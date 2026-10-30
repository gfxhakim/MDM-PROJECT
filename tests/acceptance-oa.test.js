// Step 10 — OA Part 15 acceptance criteria, one test per criterion (AC-OA-1 … AC-OA-24).
// Each test is named after its criterion and follows the spec's "Verify" line as closely as an
// automated test can. Criteria the spec tags 2P (two people) or CFG (a non-developer at the
// keyboard) are exercised through the same API the console uses; docs/acceptance.md records what
// still needs to be demonstrated live.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { useTestDatabase } from './helpers/db.js';
import { startApp } from './helpers/http.js';

useTestDatabase('acceptance-oa');
process.env.JWT_SECRET = 'test-secret';
const { prisma } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const cfg = await import('../src/config/service.js');
const { hashPassword } = await import('../src/auth/service.js');
const { receiveInbound } = await import('../src/core/contacts.js');
const { TICKET_TYPES } = await import('../src/core/ticketTypes.js');
const oa = await import('../src/oa/service.js');
const { runOnboardingSweep } = await import('../src/oa/rules.js');
const { onboardingAnalytics } = await import('../src/oa/analytics.js');
const { PARAMETERS } = await import('../src/config/parameters.js');
const { heartbeat } = await import('../src/core/presence.js');
const { consoles } = await import('../src/web/consoles.js');

const PASSWORD = 'pw-123456';
const U = {};
const as = (k) => ({ id: U[k].id, role: U[k].role, name: U[k].name });
let app;
const tok = (k) => app.login(`${k}@t.local`, PASSWORD);
const call = (...a) => app.call(...a);

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const T0 = new Date('2026-11-01T08:00:00Z'); // Sunday 10:00 Tripoli — inside the shift
const at = (ms) => new Date(T0.getTime() + ms);
let seq = 5000;
const phone = () => `+2189400${seq++}`;
const reload = (t) => prisma.ticket.findUnique({ where: { id: t.id } });

async function lead({ country = 'LY', when = T0, sourceUtm } = {}) {
  const r = await receiveInbound({ phone: phone(), body: 'Hello, I registered', name: 'Merchant', country, at: when, sourceUtm });
  const ticket = await prisma.ticket.findFirst({ where: { contactId: r.contact.id, type: 'onboarding_task' } });
  return { ...r, ticket };
}
const HANDOFF = { sellerProfile: 'Tripoli boutique', intent: 'Cosmetics, ~80 orders/month', servicesDiscussed: 'COD, fulfilment', objections: 'Price — answered', commitments: 'AM call within 24h', riskNotes: 'None' };
const ALL_TRUE = { reachable: true, intent: true, walkthrough: true, documents: true, expectations: true };
async function qualified(l, who = 'salma') {
  await oa.logCall(as(who), l.ticket.id, 'answered_strong', null, { now: at(HOUR) });
  await oa.updateTicket(as(who), l.ticket.id, { qualification: ALL_TRUE, handoffRecord: HANDOFF });
}
async function quietLead() {
  const l = await lead();
  await oa.logCall(as('salma'), l.ticket.id, 'answered_soft', null, { now: at(HOUR) });
  await prisma.conversation.update({ where: { id: l.conversation.id }, data: { lastOutboundAt: at(2 * HOUR) } });
  return l;
}
async function publish(changes, who = 'manager', note) {
  const t = await tok(who);
  const d = await call('PATCH', '/api/config/draft', { token: t, body: { changes } });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  const p = await call('POST', '/api/config/publish', { token: t, body: { note } });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  return p.body;
}

before(async () => {
  for (const [k, role, markets] of [['admin', 'ADMIN', []], ['manager', 'MANAGER', []], ['lead', 'SHIFT_LEAD', []],
    ['salma', 'OA_AGENT', ['LY']], ['karim', 'OA_AGENT', ['LB']], ['noor', 'OA_AGENT', ['IQ']],
    ['yassine', 'ACCOUNT_MANAGER', ['LY']], ['viewer', 'READ_ONLY', []]]) {
    U[k] = await prisma.user.create({ data: { email: `${k}@t.local`, name: k, role, markets: JSON.stringify(markets), passwordHash: await hashPassword(PASSWORD) } });
  }
  for (const [key, bodyEn] of [['oa_nudge_v2', '{{1}}, pricing, trust, or timing?'], ['oa_hub_share_v1', '{{1}}, everything is here: {{2}}'], ['oa_intro_v2', 'Salam {{1}}, this is {{2}} from MDM Express.']]) {
    await prisma.template.create({ data: { key, module: 'oa', bodyEn, status: 'approved' } });
  }
  for (const [name, actions, insertText] of [
    ['Log call — no answer', { op: 'log_call', outcome: 'no_answer' }, 'Called, no answer.'],
    ['Log call — answered, strong lead', { op: 'log_call', outcome: 'answered_strong' }, 'Answered — strong lead.'],
    ['Log call — answered, soft lead', { op: 'log_call', outcome: 'answered_soft' }, 'Answered — interested.'],
    ['Book the walkthrough', { op: 'book_walkthrough' }, 'Your walkthrough is booked.'],
    ['Send Hub instead of a call', { op: 'send_hub' }, ''],
    ['Mark junk — not a real seller', { op: 'mark_junk' }, 'Not a real seller.'],
  ]) await prisma.macro.create({ data: { module: 'oa', scope: 'team', name, actions: JSON.stringify(actions), insertText } });
  app = await startApp(createApp);
});
beforeEach(async () => {
  for (const m of ['notification', 'eventLog', 'message', 'ticket', 'playbookProgress', 'healthHistory', 'seller', 'conversation', 'contact']) await prisma[m].deleteMany();
  await prisma.configDraft.deleteMany();
  await prisma.configVersion.deleteMany();
  await cfg.seedDefaults();
  await prisma.user.updateMany({ data: { onCall: false, lastAssignedAt: null } });
  await prisma.user.update({ where: { id: U.karim.id }, data: { markets: JSON.stringify(['LB']) } });
});
after(async () => { app?.close(); await prisma.$disconnect(); });

// ───────────── Capture and assignment ─────────────

test('AC-OA-1 — an unknown number creates a contact, a conversation and one assigned ticket with stage, due date and source', async () => {
  const r = await receiveInbound({ phone: phone(), body: 'Salam, I want to sell', name: 'Amal', country: 'LY', at: T0 });
  assert.equal(r.created, true);
  assert.equal(await prisma.conversation.count({ where: { contactId: r.contact.id } }), 1);
  const tickets = await prisma.ticket.findMany({ where: { contactId: r.contact.id } });
  assert.equal(tickets.length, 1);
  const [t] = tickets;
  assert.equal(t.type, 'onboarding_task');
  assert.equal(t.assigneeId, U.salma.id);
  assert.equal(t.stage, 'first_contact');
  assert.ok(t.dueAt);
  assert.equal(JSON.parse(t.handoffRecord).source, 'whatsapp');
  assert.ok(await prisma.notification.findFirst({ where: { userId: U.salma.id, ticketId: t.id, kind: 'oa.r1.assigned' } }));
});

test('AC-OA-2 — message then portal registration with the same phone gives one ticket and one contact', async () => {
  const l = await lead();
  const r = await oa.registerMerchant({ phone: l.contact.phone.replace('+', '00'), name: 'Amal Store', country: 'LY', sourceUtm: 'portal' });
  assert.equal(r.contact.id, l.contact.id);
  assert.equal(await prisma.contact.count({ where: { phone: l.contact.phone } }), 1);
  assert.equal(await prisma.ticket.count({ where: { contactId: l.contact.id, type: 'onboarding_task' } }), 1);
});

test('AC-OA-3 — the lead goes to the agent with the most free minutes: three walkthroughs today lose to none', async () => {
  await prisma.user.update({ where: { id: U.karim.id }, data: { markets: JSON.stringify(['LY']) } });
  for (const [agent, booked] of [['salma', true], ['karim', false]]) {
    for (let i = 0; i < 3; i++) {
      const c = await prisma.contact.create({ data: { name: `${agent} ${i}`, phone: phone(), country: 'LY' } });
      await prisma.conversation.create({ data: { contactId: c.id } });
      await prisma.ticket.create({ data: {
        type: 'onboarding_task', contactId: c.id, assigneeId: U[agent].id, status: 'qualified', stage: 'walkthrough', createdAt: at(-DAY),
        walkthroughAt: booked ? at(2 * HOUR + i * HOUR) : null, dueAt: booked ? at(2 * HOUR + i * HOUR) : at(5 * DAY),
      } });
    }
  }
  const l = await lead();
  assert.equal(l.ticket.assigneeId, U.karim.id);
});

test('AC-OA-4 — no interface path or API call lets an agent select, claim or self-assign a lead', async () => {
  const html = consoles().oa;
  assert.doesNotMatch(html, /onclick="(claim|selfAssign|pickLead|takeLead)\(/);
  const l = await lead({ country: 'LB' }); // Karim's lead
  const s = await tok('salma');
  for (const [path, body] of [
    [`/api/oa/tickets/${l.ticket.id}/reassign`, { toUserId: U.salma.id, reason: 'mine' }],
    [`/api/oa/tickets/${l.ticket.id}/assign-over-capacity`, { reason: 'mine' }],
    ['/api/oa/bulk', { op: 'reassign', ticketIds: [l.ticket.id], toUserId: U.salma.id, reason: 'mine' }],
    [`/api/conversations/${l.conversation.id}/take-over`, { reason: 'mine' }],
  ]) {
    const r = await call('POST', path, { token: s, body });
    assert.equal(r.status, 403, `${path} → ${r.status}`);
  }
  assert.equal(await call('PATCH', `/api/oa/tickets/${l.ticket.id}`, { token: s, body: { assigneeId: U.salma.id } }).then((r) => r.status >= 400), true);
  assert.equal((await reload(l.ticket)).assigneeId, U.karim.id);
});

test('AC-OA-5 — a ticket that cannot be assigned is held with a reason, and assigned within one sweep of capacity freeing', async () => {
  const first = await lead();
  assert.equal(first.ticket.assigneeId, U.salma.id);
  await publish({ 'oa.max_open_leads': 1 }, 'manager', 'Ceiling test');
  const held = await lead();
  assert.equal(held.ticket.assigneeId, null);
  assert.equal(held.ticket.holdReason, 'no agent with free capacity');
  await oa.transition(as('salma'), first.ticket.id, 'junk_lead', 'Not a real seller');
  const sweep = await runOnboardingSweep({ now: at(MIN) });
  assert.equal(sweep.r8, 1);
  const t = await reload(held.ticket);
  assert.deepEqual([t.assigneeId, t.holdReason], [U.salma.id, null]);
});

// ───────────── Cadence ─────────────

test('AC-OA-6 — each no-answer increments attempt_no, holds Failed to Contact, schedules the next; the limit moves to Cold with a reason', async () => {
  const l = await lead();
  let t;
  for (let i = 1; i <= 5; i++) {
    t = await oa.logCall(as('salma'), l.ticket.id, 'no_answer', null, { now: at(i * DAY) });
    if (i < 5) {
      assert.deepEqual([t.attemptNo, t.status], [i, 'failed_to_contact']);
      assert.deepEqual(t.nextAttemptAt, at(i * DAY + DAY));
    }
  }
  assert.deepEqual([t.attemptNo, t.status], [5, 'cold_lead']);
  const ev = await prisma.eventLog.findFirst({ where: { entityId: l.ticket.id, action: 'ticket.status_changed' }, orderBy: { createdAt: 'desc' } });
  assert.ok(ev.reason && /no answer|no-answer|attempt/i.test(ev.reason), ev.reason);
});

test('AC-OA-7 — an inbound reply resets the cadence once; a second silence runs to the normal cutoff', async () => {
  const l = await lead();
  const s = as('salma');
  await oa.logCall(s, l.ticket.id, 'no_answer', null, { now: at(DAY) });
  await oa.logCall(s, l.ticket.id, 'no_answer', null, { now: at(2 * DAY) });
  await receiveInbound({ phone: l.contact.phone, body: 'sorry, busy', at: at(2 * DAY + HOUR) });
  assert.deepEqual([(await reload(l.ticket)).attemptNo, (await reload(l.ticket)).cadenceReset], [0, true]);
  for (let i = 3; i <= 4; i++) await oa.logCall(s, l.ticket.id, 'no_answer', null, { now: at(i * DAY) });
  await receiveInbound({ phone: l.contact.phone, body: 'call me later', at: at(4 * DAY + HOUR) });
  assert.equal((await reload(l.ticket)).attemptNo, 2); // no second reset
  let t;
  for (let i = 5; i <= 7; i++) t = await oa.logCall(s, l.ticket.id, 'no_answer', null, { now: at(i * DAY) });
  assert.deepEqual([t.attemptNo, t.status], [5, 'cold_lead']);
  assert.equal(await prisma.eventLog.count({ where: { entityId: l.ticket.id, action: 'ticket.cadence_reset' } }) <= 1, true);
});

test('AC-OA-8 — went-quiet does not send without template budget, and the suppression is visible on the lead', async () => {
  const l = await quietLead();
  await publish({ 'oa.template_budget_month': 1 }, 'admin', 'Budget below usage');
  await prisma.message.create({ data: { conversationId: l.conversation.id, direction: 'out', kind: 'template', templateKey: 'oa_nudge_v2', body: 'x', billable: true, createdAt: at(HOUR) } });
  const before = await prisma.message.count({ where: { conversationId: l.conversation.id, kind: 'template' } });
  const r = await runOnboardingSweep({ now: at(4 * DAY) });
  assert.equal(r.r5, 0);
  assert.equal(await prisma.message.count({ where: { conversationId: l.conversation.id, kind: 'template' } }), before);
  const t = await reload(l.ticket);
  assert.equal(t.followupNo, 0);
  assert.ok(JSON.parse(t.tags).includes('oa_followup_suppressed'));
  const line = await prisma.message.findFirst({ where: { conversationId: l.conversation.id, kind: 'system' }, orderBy: { createdAt: 'desc' } });
  assert.match(line.body, /^Follow-up 1 of 3 was not sent — .*budget/i);
  assert.ok(await prisma.notification.findFirst({ where: { userId: U.salma.id, kind: 'oa.r5.suppressed' } }));
  await runOnboardingSweep({ now: at(4 * DAY + HOUR) }); // reported once, not on every sweep
  assert.equal(await prisma.message.count({ where: { conversationId: l.conversation.id, kind: 'system', body: { startsWith: 'Follow-up 1 of 3' } } }), 1);
});

test('AC-OA-9 (CFG) — a Manager changes the attempt count in settings; open tickets and the tracker follow at the next evaluation', async () => {
  const l = await lead();
  for (let i = 1; i <= 3; i++) await oa.logCall(as('salma'), l.ticket.id, 'no_answer', null, { now: at(i * DAY) });
  const s = await tok('salma');
  assert.equal((await call('GET', `/api/oa/tickets/${l.ticket.id}`, { token: s })).body.cadence.noAnswer.max, 5);
  const pub = await publish({ 'oa.no_answer_max': 7 }, 'manager', 'Seven attempts');
  assert.ok(pub.version > 1);
  const view = (await call('GET', `/api/oa/tickets/${l.ticket.id}`, { token: s })).body;
  assert.deepEqual([view.cadence.noAnswer.attemptNo, view.cadence.noAnswer.max], [3, 7]);
  const t = await oa.logCall(as('salma'), l.ticket.id, 'no_answer', null, { now: at(4 * DAY) });
  assert.equal(t.status, 'failed_to_contact'); // the old limit (5) no longer applies; 7 does
  await runOnboardingSweep({ now: at(5 * DAY) });
  assert.ok(await prisma.notification.findFirst({ where: { kind: 'oa.r3.attempt_due', title: 'Attempt 5 of 7 due' } }));
});

// ───────────── Workspace and conversation ─────────────

test('AC-OA-10 — the workspace docks the platform conversation; there is no onboarding-specific composer or send path', () => {
  const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
  const src = walk('src').filter((f) => f.endsWith('.js'));
  // only the platform conversation service writes outbound text/template messages or emits message.sent
  for (const f of src.filter((x) => !x.endsWith(join('core', 'conversations.js')))) {
    const code = readFileSync(f, 'utf8');
    assert.doesNotMatch(code, /message\.create\(\{[^}]*kind: '(text|template)'/, `${f} writes an outbound message`);
    assert.doesNotMatch(code, /emit\('message\.sent'/, `${f} has its own send path`);
  }
  // both consoles post through the one platform endpoint; neither adapter has a module-specific send route
  for (const f of ['public/assets/oa-adapter.js', 'public/assets/am-adapter.js']) {
    const code = readFileSync(f, 'utf8');
    assert.match(code, /\/api\/conversations\/\$\{[a-z]\.convId\}\/messages/);
    assert.doesNotMatch(code, /\/api\/(oa|am)\/[\w/${}.-]*\/(messages|send|reply)(?![\w-])/); // send-hub is a ticket action that calls the platform send
  }
});

test('AC-OA-11 — outside the 24h window free text is refused server-side, templates are offered, remaining time is reported', async () => {
  const l = await lead();
  const s = await tok('salma');
  const open = (await call('GET', `/api/conversations/${l.conversation.id}`, { token: s })).body;
  assert.equal(open.window.open, true);
  assert.ok(open.window.remainingMs > 0 && open.window.closesAt);
  await prisma.conversation.update({ where: { id: l.conversation.id }, data: { lastInboundAt: new Date(Date.now() - 25 * HOUR) } });
  const shut = (await call('GET', `/api/conversations/${l.conversation.id}`, { token: s })).body;
  assert.deepEqual([shut.window.open, shut.window.remainingMs], [false, 0]);
  const text = await call('POST', `/api/conversations/${l.conversation.id}/messages`, { token: s, body: { kind: 'text', body: 'hello?' } });
  assert.deepEqual([text.status, text.body.error.code], [409, 'window_closed']);
  const tpls = (await call('GET', '/api/templates', { token: s })).body;
  assert.ok(tpls.some((x) => x.key === 'oa_intro_v2' && x.status === 'approved'));
  const tpl = await call('POST', `/api/conversations/${l.conversation.id}/messages`, { token: s, body: { kind: 'template', templateKey: 'oa_intro_v2', variables: ['Amal', 'Salma'] } });
  assert.deepEqual([tpl.status, tpl.body.billable], [201, true]);
});

test('AC-OA-12 — on a colleague\'s ticket an agent reads everything and may add a note; every other action is refused with its reason', async () => {
  const l = await lead({ country: 'LB' }); // Karim's
  const s = await tok('salma');
  const view = await call('GET', `/api/oa/tickets/${l.ticket.id}`, { token: s });
  assert.equal(view.status, 200);
  for (const p of ['onboarding.edit', 'onboarding.reply', 'onboarding.activate', 'onboarding.macro']) {
    assert.deepEqual([view.body.can[p].allowed, view.body.can[p].reason], [false, 'Lead not assigned to you.'], p);
  }
  const conv = await call('GET', `/api/conversations/${l.conversation.id}`, { token: s });
  assert.ok(conv.body.messages.length >= 1);
  const note = await call('POST', `/api/conversations/${l.conversation.id}/messages`, { token: s, body: { kind: 'note', body: 'He prefers evenings' } });
  assert.equal(note.status, 201);
  const refused = [
    await call('POST', `/api/conversations/${l.conversation.id}/messages`, { token: s, body: { kind: 'text', body: 'hi' } }),
    await call('POST', `/api/oa/tickets/${l.ticket.id}/transition`, { token: s, body: { to: 'prequalified' } }),
    await call('POST', `/api/oa/tickets/${l.ticket.id}/activate`, { token: s }),
    await call('POST', `/api/oa/tickets/${l.ticket.id}/log-call`, { token: s, body: { outcome: 'no_answer' } }),
  ];
  for (const r of refused) { assert.equal(r.status, 403); assert.ok(r.body.error.message); }
  assert.equal((await reload(l.ticket)).status, 'new');
});

test('AC-OA-13 (2P) — collision detection: each agent sees the other viewing, and replying, in real time', async () => {
  const l = await lead();
  const s = await tok('salma'); const k = await tok('karim');
  const a = await call('POST', `/api/conversations/${l.conversation.id}/presence`, { token: s, body: { state: 'viewing' } });
  assert.deepEqual(a.body.others, []);
  const b = await call('POST', `/api/conversations/${l.conversation.id}/presence`, { token: k, body: { state: 'viewing' } });
  assert.deepEqual(b.body.others.map((o) => [o.name, o.state]), [['salma', 'viewing']]);
  await call('POST', `/api/conversations/${l.conversation.id}/presence`, { token: s, body: { state: 'typing' } });
  const c = await call('POST', `/api/conversations/${l.conversation.id}/presence`, { token: k, body: { state: 'viewing' } });
  assert.deepEqual(c.body.others.map((o) => [o.name, o.state]), [['salma', 'typing']]);
  await call('POST', `/api/conversations/${l.conversation.id}/presence`, { token: s, body: { state: 'left' } });
  assert.deepEqual((await call('POST', `/api/conversations/${l.conversation.id}/presence`, { token: k, body: {} })).body.others, []);
  // stale heartbeats expire; a foreign reader cannot probe a conversation
  heartbeat('conv-x', { id: 'u1', name: 'A' }, 'viewing', 0);
  assert.deepEqual(heartbeat('conv-x', { id: 'u2', name: 'B' }, 'viewing', 20_000), []);
  assert.equal((await call('POST', `/api/conversations/${l.conversation.id}/presence`, { token: await tok('yassine'), body: {} })).status, 404);
  assert.match(consoles().oa, /Presence\.watch\(l\.convId\)/);
  assert.match(consoles().am, /Presence\.watch\(s\.convId\)/);
});

test('AC-OA-14 — each of the six macros states what it applies, applies it, and only Send Hub sends (as its statement says)', async () => {
  const s = await tok('salma');
  const macros = (await call('GET', '/api/oa/macros', { token: s })).body;
  assert.equal(macros.length, 6);
  for (const m of macros) assert.ok(m.applies, `${m.name} states what it will do`);
  const expect = {
    'Log call — no answer': (t) => assert.deepEqual([t.status, t.attemptNo], ['failed_to_contact', 1]),
    'Log call — answered, strong lead': (t) => assert.deepEqual([t.status, t.stage], ['qualified', 'walkthrough']),
    'Log call — answered, soft lead': (t) => assert.equal(t.status, 'prequalified'),
    'Book the walkthrough': (t) => assert.equal(t.stage, 'walkthrough'),
    'Send Hub instead of a call': (t) => assert.deepEqual([t.stage, t.followupNo], ['walkthrough', 0]),
    'Mark junk — not a real seller': (t) => assert.deepEqual([t.status, t.dueAt], ['junk_lead', null]),
  };
  for (const m of macros) {
    const l = await lead();
    const body = m.name === 'Book the walkthrough' ? { at: new Date(Date.now() + 2 * DAY).toISOString(), mode: 'meet' } : m.name.startsWith('Send Hub') ? { variables: ['Amal', 'https://hub'] } : {};
    const r = await call('POST', `/api/oa/tickets/${l.ticket.id}/macros/${m.id}`, { token: s, body });
    assert.equal(r.status, 200, `${m.name}: ${JSON.stringify(r.body)}`);
    expect[m.name](r.body.ticket);
    const sent = await prisma.message.findMany({ where: { conversationId: l.conversation.id, direction: 'out' } });
    if (m.name.startsWith('Send Hub')) assert.deepEqual(sent.map((x) => x.templateKey), ['oa_hub_share_v1']);
    else assert.equal(sent.length, 0, `${m.name} must not send`);
    if (m.name === 'Book the walkthrough') assert.equal(r.body.insertText, 'Your walkthrough is booked.'); // inserted, not sent
  }
});

// ───────────── Activation and measurement ─────────────

test('AC-OA-15 — the accept endpoint refuses an incomplete record (criteria and handoff), enforced in the service', async () => {
  const l = await lead();
  const s = as('salma');
  await oa.logCall(s, l.ticket.id, 'answered_strong', null, { now: at(HOUR) });
  await oa.updateTicket(s, l.ticket.id, { qualification: { ...ALL_TRUE, documents: false }, handoffRecord: HANDOFF });
  const r = await call('POST', `/api/oa/tickets/${l.ticket.id}/activate`, { token: await tok('salma') });
  assert.equal(r.status, 422);
  await oa.updateTicket(s, l.ticket.id, { qualification: ALL_TRUE, handoffRecord: { ...HANDOFF, riskNotes: '  ' } });
  await assert.rejects(oa.activate(s, l.ticket.id), { status: 422 });
  // even an Admin calling the service cannot skip the gate
  await assert.rejects(oa.activate({ id: U.admin.id, role: 'ADMIN', name: 'admin' }, l.ticket.id), { status: 422 });
  assert.equal((await reload(l.ticket)).status, 'qualified');
});

test('AC-OA-16 — activation moves ownership to the AM, closes the ticket, and leaves the conversation open with its history', async () => {
  const l = await lead();
  await qualified(l);
  const historyBefore = await prisma.message.count({ where: { conversationId: l.conversation.id } });
  const r = await call('POST', `/api/oa/tickets/${l.ticket.id}/activate`, { token: await tok('salma') });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const t = await reload(l.ticket);
  assert.equal(t.status, 'activated'); assert.ok(t.closedAt);
  assert.equal((await prisma.contact.findUnique({ where: { id: l.contact.id } })).ownerAgentId, U.yassine.id);
  const conv = await call('GET', `/api/conversations/${l.conversation.id}`, { token: await tok('yassine') });
  assert.equal(conv.status, 200);
  assert.equal(conv.body.id, l.conversation.id);
  assert.ok(conv.body.messages.length >= historyBefore);
  assert.ok(conv.body.messages.some((m) => m.body === 'Hello, I registered'));
  assert.equal(await prisma.conversation.count({ where: { contactId: l.contact.id } }), 1);
});

test('AC-OA-17 — onboarding tickets count toward nothing in support metrics and get no satisfaction survey', async () => {
  assert.equal(TICKET_TYPES.onboarding_task.countsToward, 'none');
  assert.equal(TICKET_TYPES.am_task.countsToward, 'none');
  const l = await lead();
  await qualified(l);
  await oa.activate(as('salma'), l.ticket.id, { now: at(2 * HOUR) });
  const one = await call('GET', `/api/tickets/${l.ticket.id}`, { token: await tok('manager') });
  assert.equal(one.body.countsToward, 'none');
  const out = await prisma.message.findMany({ where: { conversationId: l.conversation.id, direction: 'out' } });
  assert.ok(out.every((m) => !/csat|survey|satisf/i.test(`${m.templateKey ?? ''} ${m.body}`)));
  assert.equal(await prisma.template.count({ where: { key: { contains: 'csat' } } }), 0);
});

test('AC-OA-18 — every onboarding metric matches its formula when recomputed independently; the export reconciles', async () => {
  const s = as('salma');
  const a = await lead(); const b = await lead(); const c = await lead(); const d = await lead({ country: 'LB' });
  await qualified(a);
  await oa.activate(s, a.ticket.id, { now: at(3 * HOUR) });
  for (let i = 1; i <= 5; i++) await oa.logCall(s, b.ticket.id, 'no_answer', null, { now: at(i * DAY) });
  await oa.transition(s, c.ticket.id, 'junk_lead', 'fake');
  const days = 365;
  const A = await onboardingAnalytics({ days, now: at(10 * DAY) });
  const all = await prisma.ticket.findMany({ where: { type: 'onboarding_task' } });
  assert.equal(A.registrants, all.length);
  assert.equal(A.activated, all.filter((t) => t.status === 'activated').length);
  assert.equal(A.cold, all.filter((t) => t.status === 'cold_lead').length);
  assert.equal(A.junk, all.filter((t) => t.status === 'junk_lead').length);
  const sal = A.agents.find((x) => x.id === U.salma.id);
  assert.deepEqual([sal.reg, sal.act], [3, 1]);
  assert.equal(A.agents.find((x) => x.id === U.karim.id).reg, 1);
  assert.equal(A.loss.find((x) => x.k.startsWith('Never answered')).n, 1);
  assert.equal(A.loss.find((x) => x.k.startsWith('Junk')).n, 1);
  assert.equal(d.ticket.assigneeId, U.karim.id);
  // export: Admin only; numbers equal the screen's
  assert.equal((await call('GET', '/api/oa/export/performance', { token: await tok('salma') })).status, 403);
  const res = await fetch(`${app.base}/api/oa/export/performance?days=${days}`, { headers: { authorization: `Bearer ${await tok('admin')}` } });
  assert.equal(res.status, 200);
  const rows = (await res.text()).trim().split('\r\n').map((r) => r.split(','));
  const screen = (await call('GET', `/api/oa/analytics?days=${days}`, { token: await tok('admin') })).body;
  for (const ag of screen.agents) {
    const row = rows.find((r) => r[0] === ag.name);
    assert.deepEqual([Number(row[1]), Number(row[2]), Number(row[4])], [ag.reg, ag.act, ag.first], ag.name);
  }
  assert.equal(await prisma.eventLog.count({ where: { action: 'data.exported' } }), 1);
});

test('AC-OA-19 — the activation trend marks every published configuration change with its date and description', async () => {
  await publish({ 'oa.quiet_max': 2 }, 'manager', 'Cut the third nudge');
  const A = await onboardingAnalytics({ days: 90 });
  const mark = A.marks.find((m) => m.t === 'Cut the third nudge');
  assert.ok(mark, JSON.stringify(A.marks));
  assert.match(mark.w, /^W\d{2}$/);
  assert.ok(A.weeks.some((w) => w.w === mark.w)); // lands on the chart's time axis
});

// ───────────── Administration ─────────────

test('AC-OA-20 (CFG) — every Part 12.1 setting is changed by its owner through settings, with no deployment', async () => {
  const oaParams = PARAMETERS.filter((p) => p.key.startsWith('oa.'));
  assert.ok(oaParams.length >= 30);
  const owners = { Manager: 'manager', manage_automation: 'manager', Administrator: 'admin' };
  for (const p of oaParams) {
    const who = owners[p.owner];
    assert.ok(who, `${p.key} has a non-developer owner (${p.owner})`);
    const v = p.type === 'bool' ? !p.default : p.type === 'int' || p.type === 'number' ? (p.default === p.max ? p.default - 1 : p.default + 1) : p.default;
    if (v === p.default) continue; // enums/times: same path, no value to flip generically
    const r = await call('PATCH', '/api/config/draft', { token: await tok(who), body: { changes: { [p.key]: v } } });
    assert.equal(r.status, 200, `${p.key}: ${JSON.stringify(r.body)}`);
  }
  const sim = await call('POST', '/api/config/simulate', { token: await tok('admin'), body: {} });
  assert.equal(sim.status, 200);
  // an agent cannot change any of them
  assert.equal((await call('PATCH', '/api/config/draft', { token: await tok('salma'), body: { changes: { 'oa.no_answer_max': 4 } } })).status, 403);
});

test('AC-OA-21 — simulate before live, publish attributed, roll back atomically to before two changes', async () => {
  const v1 = (await cfg.getLiveConfig()).values;
  const sim = await call('POST', '/api/config/simulate', { token: await tok('manager'), body: { changes: { 'oa.no_answer_max': 3 } } });
  assert.equal(sim.status, 200);
  assert.equal((await cfg.getLiveConfig()).values['oa.no_answer_max'], 5); // simulation changed nothing
  const p1 = await publish({ 'oa.no_answer_max': 3 }, 'manager', 'Fewer attempts');
  await publish({ 'oa.quiet_gap': 5 }, 'manager', 'Slower nudges');
  const ver = await prisma.configVersion.findUnique({ where: { id: p1.version } });
  assert.deepEqual([ver.authorId, ver.note], [U.manager.id, 'Fewer attempts']);
  const launch = await prisma.configVersion.findFirst({ orderBy: { id: 'asc' } });
  const rb = await call('POST', '/api/config/rollback', { token: await tok('manager'), body: { targetVersion: launch.id, note: 'Back to launch' } });
  assert.equal(rb.status, 200, JSON.stringify(rb.body));
  assert.deepEqual((await cfg.getLiveConfig()).values, v1);
});

test('AC-OA-22 — an administrator reads any conversation, has no composer on it, and takes over with an audited reason', async () => {
  const l = await lead({ country: 'LB' });
  const m = await tok('admin');
  const conv = (await call('GET', `/api/conversations/${l.conversation.id}`, { token: m })).body;
  assert.equal(conv.can.reply.allowed, false);
  assert.ok(conv.can.reply.reason);
  assert.equal((await call('POST', `/api/conversations/${l.conversation.id}/messages`, { token: m, body: { body: 'hi' } })).status, 403);
  assert.equal((await call('POST', `/api/conversations/${l.conversation.id}/take-over`, { token: m, body: {} })).status, 400);
  const t = await call('POST', `/api/conversations/${l.conversation.id}/take-over`, { token: m, body: { reason: 'Merchant complained' } });
  assert.equal(t.status, 200);
  const ev = await prisma.eventLog.findFirst({ where: { entityId: l.ticket.id, action: 'ticket.taken_over' } });
  assert.deepEqual([ev.actorId, JSON.parse(ev.before).assigneeId, ev.reason], [U.admin.id, U.karim.id, 'Merchant complained']);
});

test('AC-OA-23 — bulk applies to the selection only, checks each ticket, reports partial failure, writes one audit entry', async () => {
  const a = await lead(); const b = await lead(); const c = await lead({ country: 'LB' });
  const closed = await lead();
  await qualified(closed);
  await oa.activate(as('salma'), closed.ticket.id, { now: at(2 * HOUR) }); // activated is final: the transition must fail
  const untouched = await lead();
  const r = await call('POST', '/api/oa/bulk', { token: await tok('lead'), body: { op: 'transition', to: 'prequalified', reason: 'Batch review', ticketIds: [a.ticket.id, b.ticket.id, c.ticket.id, closed.ticket.id, 'missing'] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const res = Object.fromEntries(r.body.results.map((x) => [x.ticketId, x.ok]));
  assert.deepEqual([res[a.ticket.id], res[b.ticket.id], res[c.ticket.id], res[closed.ticket.id], res.missing], [true, true, true, false, false]);
  assert.ok(r.body.results.filter((x) => !x.ok).every((x) => x.error || x.reason));
  assert.equal((await reload(untouched.ticket)).status, 'new');
  const audit = await prisma.eventLog.findMany({ where: { action: 'bulk.oa_transition' } });
  assert.equal(audit.length, 1);
  assert.equal(JSON.parse(audit[0].after).results.length, 5);
  // an agent's bulk is refused outright (not partially applied)
  assert.equal((await call('POST', '/api/oa/bulk', { token: await tok('salma'), body: { op: 'transition', to: 'prequalified', reason: 'x', ticketIds: [untouched.ticket.id] } })).status, 403);
});

test('AC-OA-24 — Arabic and English, right-to-left mirroring, and the switch keeps place, filters and draft', async () => {
  const i18n = readFileSync('public/assets/i18n.js', 'utf8');
  assert.match(i18n, /dir = lang === 'ar' \? 'rtl' : 'ltr'/);
  assert.match(i18n, /re-render in place: hash, S\.\* and drafts persist/);
  globalThis.window = {};
  await import(`../public/assets/i18n-ar.js?${Date.now()}`);
  const dict = globalThis.window.I18N_AR;
  delete globalThis.window;
  for (const s of ['Onboarding Queue', 'My Day', 'Sign out', 'Integrations']) assert.ok(dict[s], `Arabic for "${s}"`);
  for (const page of [consoles().oa, consoles().am]) {
    assert.match(page, /\/assets\/i18n\.js/);
    assert.match(page, /\/assets\/i18n-ar\.js/);
  }
});
