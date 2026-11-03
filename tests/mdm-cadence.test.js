// A lead that comes from MDM runs the same cadence as any other lead (OA 3.5 applied to the
// platform): due at the import, its MDM 'not answered' mark on the no-answer cadence from attempt
// 0, our own write-back never coming back as history, one contact per merchant even when MDM
// changes the phone (OA 3.3), a manager's move kept, and "Open as lead" on the skipped list going
// through the pull's own path.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTestDatabase } from './helpers/db.js';
import { startApp } from './helpers/http.js';

useTestDatabase('mdm-cadence');
process.env.JWT_SECRET = 'test-secret';
process.env.MDM_WEBHOOK_SECRET = 'mdm-key';
for (const k of ['OPTIONAL_INTEGRATIONS', 'MDM_API_KEY', 'MDM_API_URL', 'MDM_WRITEBACK']) delete process.env[k];
const { prisma } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const cfg = await import('../src/config/service.js');
const { hashPassword } = await import('../src/auth/service.js');
const { runOnboardingSweep } = await import('../src/oa/rules.js');
const { alignOwnership } = await import('../src/integrations/mdm-staff.js');
const { rememberSkipped } = await import('../src/integrations/mdm-skipped.js');

const PASSWORD = 'pw-123456';
const U = {};
let app;
const DAY = 86_400_000;
const tok = (k) => app.login(`${k}@t.local`, PASSWORD);
const hook = (data) => fetch(`${app.base}/api/integrations/mdm/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mdm-key': 'mdm-key' }, body: JSON.stringify({ type: 'seller.upserted', data }) })
  .then((r) => r.json()).then((b) => b.results[0]);
const near = (d, ms = 60_000) => d && Math.abs(new Date(d).getTime() - Date.now()) < ms;

before(async () => {
  for (const [k, role, mdmRef] of [['admin', 'ADMIN', null], ['salma', 'OA_AGENT', null], ['amal', 'OA_AGENT', 'U-A'], ['badr', 'OA_AGENT', 'U-B']]) {
    U[k] = await prisma.user.create({ data: { email: `${k}@t.local`, name: k, role, mdmRef, markets: JSON.stringify(['LY']), passwordHash: await hashPassword(PASSWORD) } });
  }
  await cfg.seedDefaults();
  app = await startApp(createApp);
});
beforeEach(async () => {
  for (const m of ['notification', 'eventLog', 'message', 'ticket', 'seller', 'conversation', 'contact', 'mdmSkipped']) await prisma[m].deleteMany();
});
after(async () => { app.close(); await prisma.$disconnect(); });

test("an MDM 'not answered' lead is due at the import, on the no-answer cadence from attempt 0, and r3 reminds the agent", async () => {
  const r = await hook({ mdmRef: 'MDM-NA-1', phone: '+218915550101', name: 'Nour', country: 'LY', joinStatus: 'not answered', responsibleRef: 'U-A', createdAt: new Date(Date.now() - 5 * DAY).toISOString() });
  assert.equal(r.action, 'lead_created', JSON.stringify(r));
  const t = await prisma.ticket.findUnique({ where: { id: r.ticketId } });
  assert.equal(t.status, 'failed_to_contact');
  assert.equal(t.attemptNo, 0, 'OA 3.5: counters do not carry over');
  assert.ok(near(t.dueAt), 'OA 3.5: due date at cutover');
  assert.ok(near(t.nextAttemptAt), 'the next attempt is due now');
  assert.equal(t.assigneeId, U.amal.id, 'the agent MDM holds responsible');
  const sweep = await runOnboardingSweep({ now: new Date(Date.now() + 60_000) });
  assert.equal(sweep.r3, 1);
  const n = await prisma.notification.findFirst({ where: { ticketId: t.id, kind: 'oa.r3.attempt_due' } });
  assert.equal(n.title, 'Attempt 1 of 5 due');
  assert.equal((await runOnboardingSweep({ now: new Date(Date.now() + 120_000) })).r3, 0, 'one reminder per scheduled attempt');
});

test('our own write-back never comes back from MDM as a second history line', async () => {
  const r = await hook({ mdmRef: 'MDM-H-1', phone: '+218915550102', name: 'Huda', country: 'LY', joinStatus: 'follow up', history: [
    { date: '2026-10-01T09:00:00Z', status: 'not answered', notes: 'No answer (attempt 1) — salma, onboarding console' },
    { date: '2026-10-02T09:00:00Z', status: 'follow up', notes: 'asked to call back', responsibleName: 'Amal' },
  ] });
  assert.equal(r.action, 'lead_created');
  const conv = await prisma.conversation.findFirst({ where: { contactId: r.contactId } });
  const legacy = await prisma.message.findMany({ where: { conversationId: conv.id, legacy: true } });
  assert.deepEqual(legacy.map((m) => m.body), ['MDM · follow up — asked to call back · Amal']);
});

test('a phone changed on MDM opens nothing new: one contact, one ticket, and the change waits for a person (OA 3.3)', async () => {
  const first = await hook({ mdmRef: 'MDM-P-1', phone: '+218915550103', name: 'Rami', country: 'LY', joinStatus: 'pending' });
  assert.equal(first.action, 'lead_created');
  const again = await hook({ mdmRef: 'MDM-P-1', phone: '+218915550999', name: 'Rami', country: 'LY', joinStatus: 'pending' });
  assert.deepEqual([again.action, again.code], ['skipped', 'phone_changed']);
  assert.match(again.reason, /\+218915550999/);
  assert.equal(await prisma.contact.count(), 1);
  assert.equal(await prisma.ticket.count({ where: { type: 'onboarding_task' } }), 1);
});

test("a manager's move stays: the sync gives the lead back to MDM's agent only when MDM names someone new", async () => {
  const r = await hook({ mdmRef: 'MDM-M-1', phone: '+218915550104', name: 'Sara', country: 'LY', joinStatus: 'pending', responsibleRef: 'U-A' });
  assert.equal(r.owner, 'amal');
  const re = await app.call('POST', `/api/oa/tickets/${r.ticketId}/reassign`, { token: await tok('admin'), body: { toUserId: U.salma.id, reason: 'Amal is on leave' } });
  assert.equal(re.status, 200, JSON.stringify(re.body));
  await hook({ mdmRef: 'MDM-M-1', phone: '+218915550104', name: 'Sara', country: 'LY', joinStatus: 'pending', responsibleRef: 'U-A' });
  await alignOwnership();
  assert.equal((await prisma.ticket.findUnique({ where: { id: r.ticketId } })).assigneeId, U.salma.id, 'the next sync does not undo the move');
  await hook({ mdmRef: 'MDM-M-1', phone: '+218915550104', name: 'Sara', country: 'LY', joinStatus: 'pending', responsibleRef: 'U-B' });
  assert.equal((await prisma.ticket.findUnique({ where: { id: r.ticketId } })).assigneeId, U.badr.id, 'MDM named a new agent');
});

test("'Open as lead' on the skipped list brings MDM's status, dates and history, like the pull", async () => {
  const created = new Date(Date.now() - 10 * DAY);
  const row = { mdmRef: 'MDM-S-9', phone: '+218915550105', name: 'Yasmine', country: 'DZA', joinStatus: 'not answered', createdAt: created.toISOString(),
    history: [{ date: '2026-10-20T10:00:00Z', status: 'not answered', notes: 'no reply', responsibleName: 'Amal' }] };
  await rememberSkipped(row, { code: 'market', reason: 'Market DZ is not Libya, Iraq or Lebanon.' });
  const h = await prisma.mdmSkipped.findUnique({ where: { mdmRef: 'MDM-S-9' } });
  const d = await app.call('POST', '/api/integrations/mdm/skipped/decide', { token: await tok('admin'), body: { ids: [h.id], action: 'lead', market: 'LY' } });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  const contact = await prisma.contact.findFirst({ where: { mdmRef: 'MDM-S-9' } });
  assert.equal(contact.mdmCreatedAt.getTime(), created.getTime());
  const t = await prisma.ticket.findFirst({ where: { contactId: contact.id, type: 'onboarding_task' } });
  assert.deepEqual([t.status, t.attemptNo], ['failed_to_contact', 0]);
  assert.ok(t.nextAttemptAt);
  const conv = await prisma.conversation.findFirst({ where: { contactId: contact.id } });
  assert.equal(await prisma.message.count({ where: { conversationId: conv.id, legacy: true } }), 1);
  // the same seller again is refused: one contact per merchant
  await prisma.mdmSkipped.update({ where: { id: h.id }, data: { decision: null } });
  const again = await app.call('POST', '/api/integrations/mdm/skipped/decide', { token: await tok('admin'), body: { ids: [h.id], action: 'lead', market: 'LY' } });
  assert.match(JSON.stringify(again.body), /Already here as Yasmine/);
});
