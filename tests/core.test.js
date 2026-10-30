// Step 4 — platform core: contacts, the one conversation, messages and the session window,
// templates and the onboarding budget, take-over, scoped tickets.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTestDatabase } from './helpers/db.js';
import { startApp } from './helpers/http.js';

useTestDatabase('core');
process.env.JWT_SECRET = 'test-secret';
const { prisma } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const cfg = await import('../src/config/service.js');
const { hashPassword } = await import('../src/auth/service.js');
const { on } = await import('../src/core/events.js');
const { receiveInbound } = await import('../src/core/contacts.js');
const { sendTemplate } = await import('../src/core/conversations.js');

const PASSWORD = 'pw-123456';
const U = {};
let app;
const tok = (k) => app.login(`${k}@t.local`, PASSWORD);
const call = (...a) => app.call(...a);
const HOUR = 3_600_000;

let phoneSeq = 100;
const nextPhone = () => `+21891000${String(phoneSeq++).padStart(4, '0')}`;

/** A merchant with a conversation and an open onboarding ticket assigned to `assignee`. */
async function lead(assigneeKey, { inboundAgoMs = HOUR } = {}) {
  const r = await receiveInbound({ phone: nextPhone(), body: 'Hello', name: 'Merchant', country: 'LY', at: new Date(Date.now() - inboundAgoMs) });
  // The onboarding engine's r1 may already have captured it; either way, assign it to `assignee`.
  const existing = await prisma.ticket.findFirst({ where: { contactId: r.contact.id, type: 'onboarding_task' } });
  const ticket = existing
    ? await prisma.ticket.update({ where: { id: existing.id }, data: { assigneeId: U[assigneeKey].id, holdReason: null } })
    : await prisma.ticket.create({ data: { type: 'onboarding_task', contactId: r.contact.id, assigneeId: U[assigneeKey].id, status: 'new', stage: 'first_contact' } });
  return { ...r, ticket };
}

/** An activated seller in `amKey`'s book, with its conversation. */
async function seller(amKey) {
  const r = await receiveInbound({ phone: nextPhone(), body: 'Hi', name: 'Seller', country: 'LY' });
  await prisma.ticket.updateMany({ where: { contactId: r.contact.id, type: 'onboarding_task' }, data: { status: 'activated', closedAt: new Date() } });
  await prisma.contact.update({ where: { id: r.contact.id }, data: { contactType: 'seller', ownerAgentId: U[amKey].id } });
  const s = await prisma.seller.create({ data: { mdmRef: `MDM-S-${phoneSeq}`, contactId: r.contact.id, market: 'LY', assignedAccountManagerId: U[amKey].id, joinStatus: 'accepted' } });
  return { ...r, seller: s };
}

before(async () => {
  await cfg.seedDefaults();
  for (const [k, role] of [['admin', 'ADMIN'], ['manager', 'MANAGER'], ['salma', 'OA_AGENT'], ['karim', 'OA_AGENT'],
    ['yassine', 'ACCOUNT_MANAGER'], ['rania', 'ACCOUNT_MANAGER'], ['viewer', 'READ_ONLY']]) {
    U[k] = await prisma.user.create({ data: { email: `${k}@t.local`, name: k, role, passwordHash: await hashPassword(PASSWORD) } });
  }
  const T = [
    ['oa_intro_v2', 'oa', 'Salam {{1}}, this is {{2}} from MDM Express.', 'approved', true],
    ['oa_nudge_v2', 'oa', '{{1}}, pricing, trust, or timing?', 'approved', true],
    ['oa_winback_d30', 'oa', '{{1}}, come back.', 'approved', false],
    ['oa_pending', 'oa', 'pending {{1}}', 'pending', true],
    ['am_welcome_v1', 'am', 'Salam {{1}}, I am {{2}}, your account manager.', 'approved', true],
  ];
  for (const [key, module, bodyEn, status, enabled] of T) await prisma.template.create({ data: { key, module, bodyEn, status, enabled } });
  app = await startApp(createApp);
});

after(async () => {
  app?.close();
  await prisma.$disconnect();
});

// ───────────── contacts & the one conversation ─────────────

test('inbound creates the contact and ONE conversation for life; source_utm is immutable', async () => {
  const seen = [];
  const off = on('message.received', 'test', (p) => seen.push(p.message.id));
  try {
    const phone = nextPhone();
    const a = await receiveInbound({ phone, body: 'first', name: 'Amal', country: 'LY', sourceUtm: 'meta_ads' });
    const b = await receiveInbound({ phone: phone.replace('+', '00'), body: 'second', sourceUtm: 'referral' });
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(a.conversation.id, b.conversation.id);
    assert.equal(await prisma.conversation.count({ where: { contactId: a.contact.id } }), 1);
    assert.equal((await prisma.contact.findUnique({ where: { id: a.contact.id } })).sourceUtm, 'meta_ads');
    assert.deepEqual(seen, [a.message.id, b.message.id]);
    await assert.rejects(prisma.conversation.create({ data: { contactId: a.contact.id } })); // DB-level guard too
  } finally { off(); }
});

test('a blocked contact\'s inbound is stored but emits nothing (no tickets)', async () => {
  const r = await receiveInbound({ phone: nextPhone(), body: 'x', country: 'LY' });
  await prisma.contact.update({ where: { id: r.contact.id }, data: { blocked: true, blockReason: 'spam' } });
  const seen = [];
  const off = on('message.received', 'test', (p) => seen.push(p));
  try {
    const again = await receiveInbound({ phone: r.contact.phone, body: 'still here' });
    assert.equal(seen.length, 0);
    assert.equal(await prisma.message.count({ where: { conversationId: again.conversation.id } }), 2);
  } finally { off(); }
});

test('inbound rejects a phone that is not E.164', async () => {
  await assert.rejects(receiveInbound({ phone: '091-555', body: 'x', country: 'LY' }), { status: 400 });
});

test('contact list is scoped: team for onboarding roles, own book for an AM', async () => {
  const l = await lead('karim');
  const s = await seller('rania');
  const agentIds = (await call('GET', '/api/contacts', { token: await tok('salma') })).body.map((c) => c.id);
  assert.ok(agentIds.includes(l.contact.id));
  // a seller is visible to onboarding roles only through its onboarding history
  const plain = await prisma.contact.create({ data: { name: 'Direct seller', phone: nextPhone(), country: 'LY', contactType: 'seller', ownerAgentId: U.rania.id } });
  assert.ok(!(await call('GET', '/api/contacts', { token: await tok('salma') })).body.some((c) => c.id === plain.id));
  const yIds = (await call('GET', '/api/contacts', { token: await tok('yassine') })).body.map((c) => c.id);
  assert.ok(!yIds.includes(s.contact.id) && !yIds.includes(l.contact.id));
  assert.equal((await call('GET', `/api/contacts/${s.contact.id}`, { token: await tok('yassine') })).status, 404);
  assert.equal((await call('GET', `/api/contacts/${s.contact.id}`, { token: await tok('rania') })).status, 200);
});

// ───────────── session window ─────────────

test('free text is blocked server-side outside the 24h window; a template still goes, billable', async () => {
  const l = await lead('salma', { inboundAgoMs: 25 * HOUR });
  const t = await tok('salma');
  const conv = await call('GET', `/api/conversations/${l.conversation.id}`, { token: t });
  assert.equal(conv.body.window.open, false);
  const text = await call('POST', `/api/conversations/${l.conversation.id}/messages`, { token: t, body: { kind: 'text', body: 'hi' } });
  assert.equal(text.status, 409);
  assert.equal(text.body.error.code, 'window_closed');
  const tpl = await call('POST', `/api/conversations/${l.conversation.id}/messages`, { token: t, body: { kind: 'template', templateKey: 'oa_intro_v2', variables: ['Amal', 'Salma'] } });
  assert.equal(tpl.status, 201);
  assert.equal(tpl.body.billable, true);
  assert.equal(tpl.body.body, 'Salam Amal, this is Salma from MDM Express.');
});

test('inside the window the owner can reply in free text, and the audit log records it', async () => {
  const l = await lead('salma');
  const r = await call('POST', `/api/conversations/${l.conversation.id}/messages`, { token: await tok('salma'), body: { body: 'Welcome!' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.billable, false);
  assert.equal(await prisma.eventLog.count({ where: { entityId: l.conversation.id, action: 'message.sent' } }), 1);
});

// ───────────── who may write ─────────────

test('an agent cannot reply on a colleague\'s lead, but can add a note; read-only cannot write at all', async () => {
  const l = await lead('karim');
  const t = await tok('salma');
  const conv = (await call('GET', `/api/conversations/${l.conversation.id}`, { token: t })).body;
  assert.equal(conv.can.reply.allowed, false);
  assert.match(conv.can.reply.reason, /not assigned to you/);
  assert.equal((await call('POST', `/api/conversations/${l.conversation.id}/messages`, { token: t, body: { body: 'hi' } })).status, 403);
  const note = await call('POST', `/api/conversations/${l.conversation.id}/messages`, { token: t, body: { kind: 'note', body: 'He prefers evenings' } });
  assert.equal(note.status, 201);
  assert.equal(note.body.direction, 'internal');
  assert.equal((await call('POST', `/api/conversations/${l.conversation.id}/messages`, { token: await tok('viewer'), body: { kind: 'note', body: 'x' } })).status, 403);
});

test('AC-OA-22: a manager monitors without a composer, takes over with a reason, then owns the lead', async () => {
  const l = await lead('karim');
  const m = await tok('manager');
  let conv = (await call('GET', `/api/conversations/${l.conversation.id}`, { token: m })).body;
  assert.equal(conv.can.reply.allowed, false);
  assert.match(conv.can.reply.reason, /Monitoring is not replying/);
  assert.equal((await call('POST', `/api/conversations/${l.conversation.id}/take-over`, { token: m, body: {} })).status, 400);
  conv = (await call('POST', `/api/conversations/${l.conversation.id}/take-over`, { token: m, body: { reason: 'Merchant escalated' } })).body;
  assert.equal(conv.can.reply.allowed, true);
  assert.equal((await prisma.ticket.findUnique({ where: { id: l.ticket.id } })).assigneeId, U.manager.id);
  const ev = await prisma.eventLog.findFirst({ where: { entityId: l.ticket.id, action: 'ticket.taken_over' } });
  assert.deepEqual([ev.actorId, JSON.parse(ev.before).assigneeId, ev.reason], [U.manager.id, U.karim.id, 'Merchant escalated']);
  assert.ok(conv.messages.some((x) => x.kind === 'system' && /took over/.test(x.body)));
  assert.equal((await call('POST', `/api/conversations/${l.conversation.id}/messages`, { token: await tok('karim'), body: { body: 'hi' } })).status, 403);
  assert.equal((await call('POST', `/api/conversations/${l.conversation.id}/take-over`, { token: await tok('salma'), body: { reason: 'x' } })).status, 403);
});

test('AM conversation: owner replies; a foreign AM gets not-found; Admin takes over then releases', async () => {
  const s = await seller('yassine');
  const y = await tok('yassine');
  assert.equal((await call('POST', `/api/conversations/${s.conversation.id}/messages`, { token: y, body: { body: 'Salam' } })).status, 201);
  assert.equal((await call('GET', `/api/conversations/${s.conversation.id}`, { token: await tok('rania') })).status, 404);

  const a = await tok('admin');
  assert.equal((await call('POST', `/api/conversations/${s.conversation.id}/messages`, { token: a, body: { body: 'hi' } })).status, 403);
  await call('POST', `/api/conversations/${s.conversation.id}/take-over`, { token: a, body: { reason: 'AM on leave' } });
  assert.equal((await call('POST', `/api/conversations/${s.conversation.id}/messages`, { token: a, body: { body: 'Covering today' } })).status, 201);
  assert.equal((await call('POST', `/api/conversations/${s.conversation.id}/messages`, { token: y, body: { body: 'x' } })).status, 403);
  await call('POST', `/api/conversations/${s.conversation.id}/release`, { token: a });
  assert.equal((await call('POST', `/api/conversations/${s.conversation.id}/messages`, { token: y, body: { body: 'Back' } })).status, 201);
});

test('opted-out and blocked contacts receive nothing', async () => {
  const l = await lead('salma');
  const t = await tok('salma');
  await call('POST', `/api/contacts/${l.contact.id}/opt-out`, { token: t, body: { reason: 'Replied STOP' } });
  const r = await call('POST', `/api/conversations/${l.conversation.id}/messages`, { token: t, body: { body: 'hi' } });
  assert.equal(r.status, 403);
  assert.match(r.body.error.message, /opted out/);
  await assert.rejects(sendTemplate(null, l.conversation.id, 'oa_nudge_v2', ['A'], { automated: true }), { code: 'contact_unreachable' });
  // block: agents may not; a manager may, with a reason
  const l2 = await lead('salma');
  assert.equal((await call('POST', `/api/contacts/${l2.contact.id}/block`, { token: t, body: { reason: 'abuse' } })).status, 403);
  assert.equal((await call('POST', `/api/contacts/${l2.contact.id}/block`, { token: await tok('manager'), body: {} })).status, 400);
  assert.equal((await call('POST', `/api/contacts/${l2.contact.id}/block`, { token: await tok('manager'), body: { reason: 'abuse' } })).status, 200);
  assert.equal(await prisma.eventLog.count({ where: { entityId: l2.contact.id, action: 'contact.blocked' } }), 1);
});

// ───────────── templates & budget ─────────────

test('templates fail loudly: unapproved, disabled, wrong module, unfilled variables', async () => {
  const l = await lead('salma');
  const t = await tok('salma');
  const send = (templateKey, variables = ['A', 'B']) =>
    call('POST', `/api/conversations/${l.conversation.id}/messages`, { token: t, body: { kind: 'template', templateKey, variables } });
  assert.equal((await send('oa_pending')).body.error.code, 'template_not_approved');
  assert.equal((await send('oa_winback_d30')).body.error.code, 'template_disabled');
  assert.equal((await send('am_welcome_v1')).body.error.code, 'template_wrong_module');
  const missing = await send('oa_intro_v2', ['A']);
  assert.equal(missing.status, 400);
  assert.match(missing.body.error.message, /\{\{2\}\}/);
  const preview = await call('POST', '/api/templates/oa_intro_v2/preview', { token: t, body: { variables: ['Amal', 'Salma'] } });
  assert.deepEqual(preview.body, { key: 'oa_intro_v2', billable: true, body: 'Salam Amal, this is Salma from MDM Express.' });
});

test('per-contact template cap is a hard stop, for agents and rules alike', async () => {
  await cfg.updateDraft({ 'oa.template_per_contact_cap': 2 }, { id: U.admin.id, role: 'ADMIN' });
  await cfg.publish({ actor: { id: U.admin.id, role: 'ADMIN' } });
  try {
    const l = await lead('salma');
    const t = await tok('salma');
    const send = () => call('POST', `/api/conversations/${l.conversation.id}/messages`, { token: t, body: { kind: 'template', templateKey: 'oa_nudge_v2', variables: ['A'] } });
    assert.equal((await send()).status, 201);
    const auto = await sendTemplate(null, l.conversation.id, 'oa_nudge_v2', ['A'], { automated: true, ruleId: 'r5' });
    assert.equal(auto.authorUserId, null);
    const third = await send();
    assert.equal(third.status, 409);
    assert.equal(third.body.error.code, 'template_budget');
    assert.match(third.body.error.message, /2 of 2/);
    await assert.rejects(sendTemplate(null, l.conversation.id, 'oa_nudge_v2', ['A'], { automated: true }), { code: 'template_budget' });
    const ev = await prisma.eventLog.findFirst({ where: { entityId: l.conversation.id, action: 'message.template_sent', actorId: null } });
    assert.equal(JSON.parse(ev.after).ruleId, 'r5');
  } finally {
    await cfg.rollback({ actor: { id: U.admin.id, role: 'ADMIN' }, targetVersion: 1 });
  }
});

test('the monthly onboarding ceiling stops sends once spent', async () => {
  const admin = { id: U.admin.id, role: 'ADMIN' };
  const used = await prisma.message.count({ where: { kind: 'template', templateKey: { startsWith: 'oa_' } } });
  await cfg.updateDraft({ 'oa.template_budget_month': used }, admin);
  await cfg.publish({ actor: admin });
  try {
    const l = await lead('salma');
    const r = await call('POST', `/api/conversations/${l.conversation.id}/messages`, { token: await tok('salma'), body: { kind: 'template', templateKey: 'oa_nudge_v2', variables: ['A'] } });
    assert.equal(r.status, 409);
    assert.match(r.body.error.message, /Monthly onboarding template budget spent/);
  } finally {
    await cfg.rollback({ actor: admin, targetVersion: 1 });
  }
});

// ───────────── tickets ─────────────

test('tickets: team read for agents with per-action reasons; counts_toward none; am_task by book', async () => {
  const l = await lead('karim');
  const t = await tok('salma');
  const list = (await call('GET', '/api/tickets?type=onboarding_task', { token: t })).body;
  assert.ok(list.some((x) => x.id === l.ticket.id));
  const mine = (await call('GET', '/api/tickets?type=onboarding_task&assignee=me', { token: t })).body;
  assert.ok(mine.every((x) => x.assigneeId === U.salma.id));
  const one = (await call('GET', `/api/tickets/${l.ticket.id}`, { token: t })).body;
  assert.equal(one.countsToward, 'none');
  assert.deepEqual(one.can['onboarding.edit'], { allowed: false, reason: 'Lead not assigned to you.' });
  assert.equal(one.can['onboarding.note'].allowed, true);

  const s = await seller('rania');
  const task = await prisma.ticket.create({ data: { type: 'am_task', contactId: s.contact.id, sellerId: s.seller.id, assigneeId: U.rania.id, status: 'open', taskType: 'welcome', why: 'Seller activated' } });
  assert.equal((await call('GET', `/api/tickets/${task.id}`, { token: await tok('yassine') })).status, 404);
  assert.equal((await call('GET', `/api/tickets/${task.id}`, { token: t })).status, 404);
  const r = (await call('GET', `/api/tickets/${task.id}`, { token: await tok('rania') })).body;
  assert.equal(r.countsToward, 'none');
  assert.equal(r.can['am_task.close'].allowed, true);
  assert.deepEqual((await call('GET', '/api/tickets?type=am_task', { token: await tok('yassine') })).body.filter((x) => x.id === task.id), []);
});

test('closing a ticket never closes the conversation', async () => {
  const l = await lead('salma');
  await prisma.ticket.update({ where: { id: l.ticket.id }, data: { status: 'activated', closedAt: new Date() } });
  await prisma.contact.update({ where: { id: l.contact.id }, data: { contactType: 'seller', ownerAgentId: U.yassine.id } });
  await receiveInbound({ phone: l.contact.phone, body: 'Hi again' });
  const conv = await prisma.conversation.findMany({ where: { contactId: l.contact.id } });
  assert.equal(conv.length, 1);
  assert.equal(await prisma.message.count({ where: { conversationId: conv[0].id } }), 2);
});
