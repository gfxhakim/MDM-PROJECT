// Step 5 — Onboarding Agent engine: business hours, the capacity formula, pick_agent, capture
// (r1), cadences (r3–r7), the state machine, activation + handoff, macros, simulate/publish.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTestDatabase } from './helpers/db.js';
import { startApp } from './helpers/http.js';

useTestDatabase('oa');
process.env.JWT_SECRET = 'test-secret';
const { prisma } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const cfg = await import('../src/config/service.js');
const { hashPassword } = await import('../src/auth/service.js');
const { receiveInbound } = await import('../src/core/contacts.js');
const { emit } = await import('../src/core/events.js');
const bh = await import('../src/oa/businessHours.js');
const { availabilityFromCounts, pickAgent } = await import('../src/oa/capacity.js');
const oa = await import('../src/oa/service.js');
const { runOnboardingSweep } = await import('../src/oa/rules.js');
const { defaultValues } = await import('../src/config/parameters.js');

const PASSWORD = 'pw-123456';
const U = {};
const ADMIN = () => ({ id: U.admin.id, role: 'ADMIN', name: 'admin' });
const as = (k) => ({ id: U[k].id, role: U[k].role, name: U[k].name });
let app;
const tok = (k) => app.login(`${k}@t.local`, PASSWORD);
const call = (...a) => app.call(...a);

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
// Sunday 1 Nov 2026, 10:00 in Tripoli (UTC+2) — a business day, inside the shift.
const T0 = new Date('2026-11-01T08:00:00Z');
const at = (ms) => new Date(T0.getTime() + ms);
const D = defaultValues();
const BH = bh.hoursFromConfig(D);

let seq = 1000;
const phone = () => `+2189200${seq++}`;

async function resetWork() {
  for (const m of ['notification', 'eventLog', 'message', 'ticket', 'playbookProgress', 'healthHistory', 'seller', 'conversation', 'contact']) await prisma[m].deleteMany();
  await prisma.configDraft.deleteMany();
  await prisma.configVersion.deleteMany();
  await cfg.seedDefaults();
  await prisma.user.updateMany({ data: { onCall: false, lastAssignedAt: null } });
}

/** A captured lead: inbound during business hours → r1 assigns it. */
async function lead({ country = 'LY', when = T0, name = 'Merchant' } = {}) {
  const r = await receiveInbound({ phone: phone(), body: 'Hello, I registered', name, country, at: when });
  const ticket = await prisma.ticket.findFirst({ where: { contactId: r.contact.id, type: 'onboarding_task' } });
  return { ...r, ticket };
}

const reload = (t) => prisma.ticket.findUnique({ where: { id: t.id } });

before(async () => {
  for (const [k, role, markets] of [['admin', 'ADMIN', []], ['manager', 'MANAGER', []], ['lead', 'SHIFT_LEAD', []],
    ['salma', 'OA_AGENT', ['LY']], ['karim', 'OA_AGENT', ['LB']], ['noor', 'OA_AGENT', ['IQ']],
    ['yassine', 'ACCOUNT_MANAGER', ['LY']], ['rania', 'ACCOUNT_MANAGER', ['LB']]]) {
    U[k] = await prisma.user.create({ data: { email: `${k}@t.local`, name: k, role, markets: JSON.stringify(markets), passwordHash: await hashPassword(PASSWORD) } });
  }
  for (const [key, module, bodyEn] of [
    ['oa_nudge_v2', 'oa', '{{1}}, pricing, trust, or timing?'],
    ['oa_hub_share_v1', 'oa', '{{1}}, everything is here: {{2}}'],
    ['oa_winback_d30', 'oa', '{{1}}, we added {{2}}.'],
  ]) await prisma.template.create({ data: { key, module, bodyEn, status: 'approved' } });
  await prisma.macro.create({ data: { module: 'oa', scope: 'team', name: 'Log call — no answer', actions: JSON.stringify({ op: 'log_call', outcome: 'no_answer' }), insertText: 'Called, no answer.' } });
  app = await startApp(createApp);
});
beforeEach(resetWork);
after(async () => { app?.close(); await prisma.$disconnect(); });

// ───────────── business hours ─────────────

test('business hours: Sun–Thu 08:30–16:30 Tripoli; SLA counted in business minutes', () => {
  assert.equal(bh.isBusinessTime(T0, BH), true);
  assert.equal(bh.isBusinessTime(at(-2 * DAY), BH), false); // Friday
  assert.equal(bh.isBusinessTime(at(8 * HOUR), BH), false); // 18:00 local
  // 24 business hours from Sunday 10:00 = three 8-hour days → Wednesday 10:00
  assert.deepEqual(bh.addBusinessMinutes(T0, 24 * 60, BH), at(3 * DAY));
  assert.equal(bh.businessMinutesBetween(T0, at(3 * DAY), BH), 24 * 60);
  // Thursday 16:00 → Sunday 09:00 spans the weekend: 30 + 30 business minutes
  assert.equal(bh.businessMinutesBetween(new Date('2026-11-05T14:00:00Z'), new Date('2026-11-08T07:00:00Z'), BH), 60);
});

// ───────────── capacity (OA 4.2) ─────────────

test('availability formula reproduces the OA 4.2.2 worked example, and names the binding constraint', () => {
  const a = availabilityFromCounts({ walkthroughsToday: 1, firstContactsDue: 2, followupsDue: 2, openLeads: 5, onCall: false }, D);
  assert.deepEqual([a.assignable, a.committed, a.free, a.leadCost, a.slotsByMinutes, a.slots, a.binding], [420, 51, 369, 17, 21, 7, 'open_lead_ceiling']);
  assert.equal(availabilityFromCounts({ walkthroughsToday: 0, firstContactsDue: 0, followupsDue: 0, openLeads: 0, onCall: true }, D).slots, 0);
  const tight = availabilityFromCounts({ walkthroughsToday: 15, firstContactsDue: 0, followupsDue: 0, openLeads: 2, onCall: false }, D);
  assert.deepEqual([tight.free, tight.slots, tight.binding], [45, 2, 'minutes']);
});

test('pick_agent: country skill first, whole team as fallback, never an agent on a call', async () => {
  assert.equal((await pickAgent('LY', D, T0)).agent.id, U.salma.id);
  assert.equal((await pickAgent('IQ', D, T0)).agent.id, U.noor.id);
  const fallback = await pickAgent('EG', D, T0); // no one carries Egypt → whole team, most free minutes
  assert.ok([U.salma.id, U.karim.id, U.noor.id].includes(fallback.agent.id));
  await prisma.user.update({ where: { id: U.salma.id }, data: { onCall: true } });
  const held = await pickAgent('LY', D, T0);
  assert.deepEqual([held.agent, held.holdReason], [null, 'all agents on calls']);
});

test('pick_agent: most free minutes, tie-break fewest open leads; the ceiling holds leads', async () => {
  await prisma.user.update({ where: { id: U.karim.id }, data: { markets: JSON.stringify(['LY']) } });
  try {
    // Salma gets a lead with a first contact due (costs 9 min) → Karim now has more free minutes
    await lead();
    const second = await lead();
    assert.equal(second.ticket.assigneeId, U.karim.id);
    // ceiling: with max_open_leads 1 both are full → held
    const third = await pickAgent('LY', { ...D, 'oa.max_open_leads': 1 }, T0);
    assert.deepEqual([third.agent, third.holdReason], [null, 'no agent with free capacity']);
  } finally {
    await prisma.user.update({ where: { id: U.karim.id }, data: { markets: JSON.stringify(['LB']) } });
  }
});

// ───────────── r1 capture & r8 holding queue ─────────────

test('r1: an inbound merchant gets ONE ticket, assigned by the platform, first contact due in 24 business hours', async () => {
  const l = await lead();
  assert.equal(l.ticket.assigneeId, U.salma.id);
  assert.deepEqual([l.ticket.status, l.ticket.stage], ['new', 'first_contact']);
  assert.deepEqual(l.ticket.dueAt, at(3 * DAY));
  assert.equal(JSON.parse(l.ticket.handoffRecord).source, 'whatsapp');
  await receiveInbound({ phone: l.contact.phone, body: 'again', at: at(MIN) });
  assert.equal(await prisma.ticket.count({ where: { contactId: l.contact.id } }), 1);
  assert.ok(await prisma.notification.findFirst({ where: { userId: U.salma.id, kind: 'oa.r1.assigned' } }));
});

test('r1 outside business hours holds the lead with a reason; r8 assigns it at the first sweep after opening', async () => {
  const friday = new Date('2026-10-30T20:00:00Z');
  const l = await lead({ when: friday });
  assert.deepEqual([l.ticket.assigneeId, l.ticket.holdReason], [null, 'outside business hours']);
  await runOnboardingSweep({ now: new Date('2026-10-31T09:00:00Z') }); // Saturday — still closed
  assert.equal((await reload(l.ticket)).assigneeId, null);
  const r = await runOnboardingSweep({ now: T0 });
  assert.equal(r.r8, 1);
  const t = await reload(l.ticket);
  assert.deepEqual([t.assigneeId, t.holdReason], [U.salma.id, null]);
});

test('r8 escalates a quiet holding queue to the shift lead, once', async () => {
  await prisma.user.updateMany({ where: { role: 'OA_AGENT' }, data: { onCall: true } });
  const l = await lead();
  assert.equal(l.ticket.holdReason, 'all agents on calls');
  await runOnboardingSweep({ now: at(30 * MIN) });
  assert.equal(await prisma.notification.count({ where: { userId: U.lead.id, kind: 'oa.r8.escalation' } }), 0);
  await runOnboardingSweep({ now: at(61 * MIN) });
  await runOnboardingSweep({ now: at(90 * MIN) });
  assert.equal(await prisma.notification.count({ where: { userId: U.lead.id, kind: 'oa.r8.escalation' } }), 1);
});

test('duplicate registration resolves to the same contact and annotates the open ticket', async () => {
  const l = await lead();
  const r = await oa.registerMerchant({ phone: l.contact.phone, name: 'Again', country: 'LY', sourceUtm: 'meta' });
  assert.equal(r.outcome, 'annotated_existing');
  assert.equal(await prisma.ticket.count({ where: { contactId: l.contact.id } }), 1);
  const fresh = await oa.registerMerchant({ phone: phone(), name: 'New', country: 'LY', sourceUtm: 'referral' }, { now: T0 });
  assert.equal(fresh.outcome, 'created');
  assert.equal(JSON.parse(fresh.ticket.handoffRecord).source, 'referral');
});

// ───────────── AC-OA-4: agents never pick ─────────────

test('AC-OA-4: no path lets an agent take a lead; request transfer reaches the shift lead', async () => {
  const l = await lead({ country: 'LB' }); // Karim's
  const s = await tok('salma');
  const self = await call('POST', `/api/oa/tickets/${l.ticket.id}/reassign`, { token: s, body: { toUserId: U.salma.id, reason: 'mine' } });
  assert.equal(self.status, 403);
  assert.match(self.body.error.message, /request a transfer/);
  const req = await call('POST', `/api/oa/tickets/${l.ticket.id}/request-transfer`, { token: s, body: { reason: 'Speaks my dialect' } });
  assert.equal(req.status, 200);
  assert.ok(await prisma.notification.findFirst({ where: { userId: U.lead.id, kind: 'oa.transfer_request' } }));
  const ok = await call('POST', `/api/oa/tickets/${l.ticket.id}/reassign`, { token: await tok('lead'), body: { toUserId: U.salma.id, reason: 'Dialect match' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.assigneeId, U.salma.id);
});

test('read is team-wide, write is own-only — every disabled action says why', async () => {
  const l = await lead({ country: 'LB' });
  const s = await tok('salma');
  const view = await call('GET', `/api/oa/tickets/${l.ticket.id}`, { token: s });
  assert.equal(view.status, 200);
  assert.equal(view.body.can['onboarding.edit'].reason, 'Lead not assigned to you.');
  const r = await call('POST', `/api/oa/tickets/${l.ticket.id}/log-call`, { token: s, body: { outcome: 'no_answer' } });
  assert.equal(r.status, 403);
  const macro = await prisma.macro.findFirst();
  const m = await call('POST', `/api/oa/tickets/${l.ticket.id}/macros/${macro.id}`, { token: s, body: {} });
  assert.equal(m.body.error.message, 'Run a macro — lead not assigned to you.');
});

// ───────────── no-answer cadence (r3, r4) ─────────────

test('no-answer cadence: the agent logs attempts, rules remind once per attempt, the 5th is the cutoff', async () => {
  const l = await lead();
  const salma = as('salma');
  let t = await oa.logCall(salma, l.ticket.id, 'no_answer', null, { now: at(HOUR) });
  assert.deepEqual([t.status, t.attemptNo], ['failed_to_contact', 1]);
  assert.deepEqual(t.nextAttemptAt, at(HOUR + DAY));
  // r3: nothing before it is due, one reminder once due, none on a second run
  assert.equal((await runOnboardingSweep({ now: at(2 * HOUR) })).r3, 0);
  assert.equal((await runOnboardingSweep({ now: at(HOUR + DAY) })).r3, 1);
  assert.equal((await runOnboardingSweep({ now: at(HOUR + DAY) })).r3, 0);
  const n = await prisma.notification.findFirst({ where: { kind: 'oa.r3.attempt_due' } });
  assert.equal(n.title, 'Attempt 2 of 5 due');
  for (let i = 2; i <= 5; i++) t = await oa.logCall(salma, l.ticket.id, 'no_answer', null, { now: at(i * DAY) });
  assert.deepEqual([t.status, t.attemptNo, t.dueAt], ['cold_lead', 5, null]);
  assert.ok(JSON.parse(t.tags).includes('oa_cold_no_answer'));
  await assert.rejects(oa.logCall(salma, l.ticket.id, 'no_answer', null, { now: at(6 * DAY) }), { code: 'ticket_closed' });
});

test('AC-25 + OA 5.7: lowering no_answer_max moves open tickets at the new limit to Cold; simulate predicted it and mutated nothing', async () => {
  const l = await lead();
  for (let i = 1; i <= 3; i++) await oa.logCall(as('salma'), l.ticket.id, 'no_answer', null, { now: at(i * HOUR) });
  // simulate and publish sweep at the real clock: the merchant's only message must be > 24 h ago
  await prisma.conversation.update({ where: { id: l.conversation.id }, data: { lastInboundAt: new Date(Date.now() - 2 * DAY) } });
  await cfg.updateDraft({ 'oa.no_answer_max': 3 }, ADMIN());
  const before = JSON.stringify(await prisma.ticket.findMany({ orderBy: { id: 'asc' } }));
  const sim = await cfg.simulate();
  assert.equal(sim.impacts.onboarding.movedToCold, 1);
  assert.equal(JSON.stringify(await prisma.ticket.findMany({ orderBy: { id: 'asc' } })), before); // AC-23
  const pub = await cfg.publish({ actor: ADMIN() });
  assert.equal(pub.effects.onboarding.movedToCold, sim.impacts.onboarding.movedToCold); // AC-25
  assert.equal((await reload(l.ticket)).status, 'cold_lead');
});

// ───────────── went-quiet cadence (r5, r6) & reset (r7) ─────────────

async function quietLead() {
  const l = await lead();
  await oa.logCall(as('salma'), l.ticket.id, 'answered_soft', null, { now: at(HOUR) });
  // the agent sent something after the merchant's last message; now we wait
  await prisma.conversation.update({ where: { id: l.conversation.id }, data: { lastOutboundAt: at(2 * HOUR) } });
  return l;
}

test('went-quiet: r5 sends the billable template every quiet_gap, up to quiet_max; r6 cuts off after the last gap', async () => {
  const l = await quietLead();
  assert.equal((await runOnboardingSweep({ now: at(2 * DAY) })).r5, 0); // not yet 3 days
  const first = await runOnboardingSweep({ now: at(3 * DAY + 2 * HOUR) });
  assert.equal(first.r5, 1);
  assert.equal((await runOnboardingSweep({ now: at(3 * DAY + 2 * HOUR) })).r5, 0); // idempotent
  let t = await reload(l.ticket);
  assert.equal(t.followupNo, 1);
  const sent = await prisma.message.findFirst({ where: { conversationId: l.conversation.id, kind: 'template' } });
  assert.deepEqual([sent.templateKey, sent.billable, sent.authorUserId], ['oa_nudge_v2', true, null]);
  await runOnboardingSweep({ now: at(6 * DAY + 3 * HOUR) });
  await runOnboardingSweep({ now: at(9 * DAY + 4 * HOUR) });
  t = await reload(l.ticket);
  assert.deepEqual([t.followupNo, t.status], [3, 'prequalified']);
  assert.equal((await runOnboardingSweep({ now: at(10 * DAY) })).r6, 0); // last follow-up still has its gap
  assert.equal((await runOnboardingSweep({ now: at(12 * DAY + 5 * HOUR) })).r6, 1);
  t = await reload(l.ticket);
  assert.equal(t.status, 'cold_lead');
  assert.ok(JSON.parse(t.tags).includes('oa_cold_went_quiet'));
  assert.equal(await prisma.message.count({ where: { conversationId: l.conversation.id, kind: 'template' } }), 3);
});

test('r5 never sends without budget, and never fabricates the counter', async () => {
  const l = await quietLead();
  await prisma.message.create({ data: { conversationId: l.conversation.id, direction: 'out', kind: 'template', templateKey: 'oa_nudge_v2', body: 'x', billable: true, createdAt: at(HOUR) } });
  const r = await runOnboardingSweep({ now: at(4 * DAY), config: { ...D, 'oa.template_budget_month': 1 } });
  assert.equal(r.r5, 0);
  assert.match(r.r5Skipped[0].reason, /Monthly onboarding template budget spent/);
  assert.equal((await reload(l.ticket)).followupNo, 0);
});

test('r7: an inbound reply resets both counters exactly once per ticket', async () => {
  const l = await lead();
  await oa.logCall(as('salma'), l.ticket.id, 'no_answer', null, { now: at(HOUR) });
  await oa.logCall(as('salma'), l.ticket.id, 'no_answer', null, { now: at(DAY) });
  await receiveInbound({ phone: l.contact.phone, body: 'Sorry, busy', at: at(DAY + HOUR) });
  let t = await reload(l.ticket);
  assert.deepEqual([t.attemptNo, t.followupNo, t.cadenceReset, t.status], [0, 0, true, 'failed_to_contact']); // status only by hand
  await oa.logCall(as('salma'), l.ticket.id, 'no_answer', null, { now: at(2 * DAY) });
  await receiveInbound({ phone: l.contact.phone, body: 'ok', at: at(2 * DAY + HOUR) });
  t = await reload(l.ticket);
  assert.equal(t.attemptNo, 1); // the second disengagement runs to its cutoff
});

// ───────────── state machine (OA 2.5) ─────────────

test('state machine: illegal transitions and missing reasons are refused by the service', async () => {
  const l = await lead();
  const s = as('salma');
  await assert.rejects(oa.transition(s, l.ticket.id, 'activated'), { status: 400 });
  await assert.rejects(oa.transition(s, l.ticket.id, 'cold_lead', 'x'), { code: 'illegal_transition' }); // no New → Cold
  await oa.transition(s, l.ticket.id, 'prequalified');
  await assert.rejects(oa.transition(s, l.ticket.id, 'cold_lead'), { status: 400 });
  const cold = await oa.transition(s, l.ticket.id, 'cold_lead', 'Not interested this year');
  assert.ok(cold.closedAt);
  await assert.rejects(oa.transition(s, l.ticket.id, 'prequalified'), { status: 400 }); // reopen needs a reason
  const reopened = await oa.transition(s, l.ticket.id, 'prequalified', 'Called back, wants to start');
  assert.deepEqual([reopened.status, reopened.closedAt], ['prequalified', null]);
  const ev = await prisma.eventLog.findFirst({ where: { entityId: l.ticket.id, action: 'ticket.reopened' } });
  assert.deepEqual([ev.actorId, ev.reason], [U.salma.id, 'Called back, wants to start']);
});

test('rule-owned fields cannot be edited; system handoff fields cannot be typed', async () => {
  const l = await lead();
  const s = as('salma');
  await assert.rejects(oa.updateTicket(s, l.ticket.id, { attemptNo: 0 }), /written by the rules/);
  await assert.rejects(oa.updateTicket(s, l.ticket.id, { handoffRecord: { accountManager: 'Me' } }), /written by the platform/);
  await assert.rejects(oa.updateTicket(s, l.ticket.id, { qualification: { reachable: 'yes' } }), { status: 400 });
});

// ───────────── activation & handoff (OA 8, AC-OA-15) ─────────────

const HANDOFF = {
  sellerProfile: 'Tripoli, ex-Instagram seller', intent: 'Cosmetics, LY, ~80 orders/month', servicesDiscussed: 'COD, fulfilment',
  objections: 'Price — answered with calculator', commitments: 'AM call within 24h', riskNotes: 'None',
};
const ALL_TRUE = { reachable: true, intent: true, walkthrough: true, documents: true, expectations: true };

test('AC-OA-15: activation is refused until all 5 criteria and the handoff record are complete', async () => {
  const l = await lead();
  const s = as('salma');
  await oa.logCall(s, l.ticket.id, 'answered_strong', null, { now: at(HOUR) });
  await oa.updateTicket(s, l.ticket.id, { qualification: { reachable: true, intent: true, walkthrough: true } });
  const r = await call('POST', `/api/oa/tickets/${l.ticket.id}/activate`, { token: await tok('salma') });
  assert.equal(r.status, 422);
  assert.match(r.body.error.message, /^Activate account — 2 qualification criteria still unmet; handoff record incomplete \(6 fields\)$/);
  assert.equal((await reload(l.ticket)).status, 'qualified');
});

test('activation hands the seller to the AM: ownership moves, ticket closes, conversation stays, welcome task due in 24h', async () => {
  const l = await lead();
  const s = as('salma');
  await oa.logCall(s, l.ticket.id, 'answered_strong', null, { now: at(HOUR) });
  await oa.updateTicket(s, l.ticket.id, { qualification: ALL_TRUE, handoffRecord: HANDOFF });
  const res = await oa.activate(s, l.ticket.id, { now: at(2 * HOUR) });
  assert.equal(res.handover.managerId, U.yassine.id);
  const t = await reload(l.ticket);
  assert.deepEqual([t.status, t.stage, t.dueAt], ['activated', 'done', null]);
  assert.ok(t.closedAt);
  const h = JSON.parse(t.handoffRecord);
  assert.equal(h.accountManager, 'yassine');
  assert.equal(h.source, 'whatsapp');
  const contact = await prisma.contact.findUnique({ where: { id: l.contact.id } });
  assert.deepEqual([contact.contactType, contact.ownerAgentId], ['seller', U.yassine.id]);
  const seller = await prisma.seller.findUnique({ where: { contactId: l.contact.id } });
  assert.deepEqual([seller.joinStatus, seller.assignedAccountManagerId], ['accepted', U.yassine.id]);
  const welcome = await prisma.ticket.findFirst({ where: { type: 'am_task', sellerId: seller.id } });
  assert.deepEqual([welcome.taskType, welcome.priority, welcome.ruleId, welcome.assigneeId], ['welcome', 'urgent', 'r1', U.yassine.id]);
  assert.deepEqual(welcome.dueAt, at(2 * HOUR + 24 * HOUR));
  // one conversation, still open, now the AM's to reply on; the agent can no longer reply
  assert.equal(await prisma.conversation.count({ where: { contactId: l.contact.id } }), 1);
  await receiveInbound({ phone: l.contact.phone, body: 'Thanks!', at: at(3 * HOUR) });
  assert.equal(await prisma.ticket.count({ where: { contactId: l.contact.id, type: 'onboarding_task' } }), 1); // no new onboarding ticket
  const conv = await call('GET', `/api/conversations/${l.conversation.id}`, { token: await tok('yassine') });
  assert.equal(conv.status, 200);
  assert.ok(await prisma.eventLog.findFirst({ where: { entityId: seller.id, action: 'SELLER_ASSIGNED' } }));
});

test('a full market leaves the seller unassigned and alerts the Admin — no cross-market fallback', async () => {
  const l = await lead({ country: 'IQ' }); // no AM covers Iraq in this test team
  const s = as('noor');
  await oa.logCall(s, l.ticket.id, 'answered_strong', null, { now: at(HOUR) });
  await oa.updateTicket(s, l.ticket.id, { qualification: ALL_TRUE, handoffRecord: HANDOFF });
  const res = await oa.activate(s, l.ticket.id, { now: at(2 * HOUR) });
  assert.equal(res.handover.assigned, false);
  assert.match(JSON.parse((await reload(l.ticket)).handoffRecord).accountManager, /^Unassigned — No account manager covers IQ/);
  assert.equal((await prisma.seller.findUnique({ where: { contactId: l.contact.id } })).assignedAccountManagerId, null);
  assert.ok(await prisma.notification.findFirst({ where: { userId: U.admin.id, kind: 'am.r1.no_manager' } }));
});

test('r10: the first order is recorded once on the activated ticket', async () => {
  const l = await lead();
  const s = as('salma');
  await oa.logCall(s, l.ticket.id, 'answered_strong', null, { now: at(HOUR) });
  await oa.updateTicket(s, l.ticket.id, { qualification: ALL_TRUE, handoffRecord: HANDOFF });
  await oa.activate(s, l.ticket.id, { now: at(2 * HOUR) });
  await emit('order.created', { contactId: l.contact.id, at: at(5 * DAY) });
  await emit('order.created', { contactId: l.contact.id, at: at(6 * DAY) });
  assert.deepEqual((await reload(l.ticket)).firstOrderAt, at(5 * DAY));
});

// ───────────── r2 first contact overdue ─────────────

test('r2: first contact overdue after 24 business hours notifies the agent and shift lead, once', async () => {
  const l = await lead();
  assert.equal((await runOnboardingSweep({ now: at(3 * DAY - MIN) })).r2, 0);
  assert.equal((await runOnboardingSweep({ now: at(3 * DAY + MIN) })).r2, 1);
  assert.equal((await runOnboardingSweep({ now: at(3 * DAY + 2 * MIN) })).r2, 0);
  assert.ok(JSON.parse((await reload(l.ticket)).tags).includes('oa_first_contact_missed'));
  assert.equal(await prisma.notification.count({ where: { kind: 'oa.r2.first_contact_missed' } }), 2);
});

// ───────────── macros ─────────────

test('a macro applies its changes, counts its use, and never sends', async () => {
  const l = await lead();
  const macro = await prisma.macro.findFirst();
  const r = await call('POST', `/api/oa/tickets/${l.ticket.id}/macros/${macro.id}`, { token: await tok('salma'), body: {} });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.ticket.status, r.body.ticket.attemptNo], ['failed_to_contact', 1]);
  assert.equal((await prisma.macro.findUnique({ where: { id: macro.id } })).usageCount, 1);
  assert.equal(await prisma.message.count({ where: { conversationId: l.conversation.id, direction: 'out' } }), 0);
});

test('capacity endpoint: agents see only their own budget; supervisors see the team with the binding constraint', async () => {
  const own = await call('GET', '/api/oa/capacity', { token: await tok('salma') });
  assert.deepEqual(own.body.map((x) => x.agentId), [U.salma.id]);
  const team = await call('GET', '/api/oa/capacity', { token: await tok('lead') });
  assert.equal(team.body.length, 3);
  assert.ok(team.body.every((x) => ['minutes', 'open_lead_ceiling', 'on_call'].includes(x.binding)));
});
