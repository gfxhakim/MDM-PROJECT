// Step 7 — the consoles served from the reference prototypes, wired to the API, and the AM
// console's own endpoints (bundle, call logging, reschedule, transfer request).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTestDatabase } from './helpers/db.js';
import { startApp } from './helpers/http.js';

useTestDatabase('web');
process.env.JWT_SECRET = 'test-secret';
const { prisma } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const cfg = await import('../src/config/service.js');
const { hashPassword } = await import('../src/auth/service.js');

const PASSWORD = 'pw-123456';
const U = {};
let app;
const tok = (k) => app.login(`${k}@t.local`, PASSWORD);
const DAY = 86_400_000;

async function mkSeller(amKey, n) {
  const contact = await prisma.contact.create({ data: { name: `Seller ${n}`, phone: `+2189400${n}`, country: 'LY', contactType: 'seller', ownerAgentId: U[amKey].id } });
  await prisma.conversation.create({ data: { contactId: contact.id } });
  return prisma.seller.create({
    data: { mdmRef: `MDM-S-W${n}`, contactId: contact.id, market: 'LY', joinStatus: 'accepted', activatedAt: new Date(Date.now() - 60 * DAY),
      assignedAccountManagerId: U[amKey].id, welcomeCallAt: new Date(Date.now() - 59 * DAY), totalOrders: 50, lastOrderAt: new Date(Date.now() - DAY) },
  });
}
const mkTask = (s, extra = {}) => prisma.ticket.create({
  data: { type: 'am_task', contactId: s.contactId, sellerId: s.id, assigneeId: s.assignedAccountManagerId, status: 'open', taskType: 'checkin', title: 'Check in', why: 'test', priority: 'normal', dueAt: new Date(), ...extra },
});

before(async () => {
  for (const [k, role] of [['admin', 'ADMIN'], ['yassine', 'ACCOUNT_MANAGER'], ['rania', 'ACCOUNT_MANAGER'], ['salma', 'OA_AGENT']]) {
    U[k] = await prisma.user.create({ data: { email: `${k}@t.local`, name: k, role, markets: JSON.stringify(['LY']), passwordHash: await hashPassword(PASSWORD) } });
  }
  await cfg.seedDefaults();
  app = await startApp(createApp);
});
beforeEach(async () => {
  for (const m of ['notification', 'eventLog', 'message', 'ticket', 'playbookProgress', 'seller', 'conversation', 'contact']) await prisma[m].deleteMany();
});
after(async () => { app.close(); await prisma.$disconnect(); });

test('pages: login, both consoles built from the reference files with the adapters appended', async () => {
  const page = async (p) => { const r = await fetch(app.base + p); return { status: r.status, text: await r.text() }; };
  const login = await page('/');
  assert.equal(login.status, 200);
  assert.match(login.text, /id="email"/);
  for (const [path, adapter, marker, empty] of [['/oa', 'oa-adapter.js', 'MDM Onboarding Console', 'let S={leads:[],'], ['/am', 'am-adapter.js', 'MDM Account Manager Console', 'let S={sellers:[],']]) {
    const r = await page(path);
    assert.equal(r.status, 200, path);
    assert.ok(r.text.includes(marker), `${path} renders the reference console`);
    assert.ok(r.text.includes(`/assets/${adapter}`), `${path} loads its adapter`);
    assert.ok(r.text.includes('/assets/i18n-ar.js'), `${path} loads the Arabic dictionary`);
    assert.ok(r.text.includes(empty), `${path}: the console starts empty — data comes from the API, not the demo seed`);
  }
  const asset = await fetch(`${app.base}/assets/api.js`);
  assert.equal(asset.status, 200);
});

test('console bundle is the caller\'s book only; health and stage come from the server', async () => {
  const mine = await mkSeller('yassine', 1);
  await mkSeller('rania', 2);
  const r = await app.call('GET', '/api/am/console', { token: await tok('yassine') });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.sellers.map((s) => s.id), [mine.id]);
  const s = r.body.sellers[0];
  assert.ok('health' in s && 'stage' in s && Array.isArray(s.playbook) && s.conversation);
  const admin = await app.call('GET', '/api/am/console', { token: await tok('admin') });
  assert.equal(admin.body.sellers.length, 2);
  const agent = await app.call('GET', '/api/am/console', { token: await tok('salma') });
  assert.equal(agent.status, 403);
});

test('log a call: answered + done closes the task and records contact; no answer moves it to tomorrow', async () => {
  const s = await mkSeller('yassine', 3);
  const t1 = await mkTask(s);
  const token = await tok('yassine');
  let r = await app.call('POST', `/api/am/sellers/${s.id}/calls`, { token, body: { outcome: 'done', taskId: t1.id, note: 'All good.' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const closed = await prisma.ticket.findUnique({ where: { id: t1.id } });
  assert.equal(closed.status, 'done');
  assert.equal(closed.outcome, 'All good.');
  const msgs = await prisma.message.findMany({ where: { conversation: { contactId: s.contactId } } });
  assert.ok(msgs.some((m) => m.kind === 'call_event'));
  assert.ok(msgs.some((m) => m.kind === 'note' && m.direction === 'internal'));
  assert.ok(!msgs.some((m) => m.direction === 'out' && m.kind !== 'call_event'), 'a call log never messages the seller');

  const t2 = await mkTask(s);
  r = await app.call('POST', `/api/am/sellers/${s.id}/calls`, { token, body: { outcome: 'no_answer', taskId: t2.id } });
  assert.equal(r.status, 201);
  const moved = await prisma.ticket.findUnique({ where: { id: t2.id } });
  assert.equal(moved.status, 'open');
  assert.ok(moved.dueAt.getTime() > Date.now() + 20 * 3600_000);

  const escalate = await app.call('POST', `/api/am/sellers/${s.id}/calls`, { token, body: { outcome: 'escalate', taskId: t2.id } });
  assert.equal(escalate.status, 400, 'escalating needs a written reason');
});

test('a foreign seller is not-found for calls, snooze and transfer requests (AC-20)', async () => {
  const other = await mkSeller('rania', 4);
  const t = await mkTask(other);
  const token = await tok('yassine');
  assert.equal((await app.call('POST', `/api/am/sellers/${other.id}/calls`, { token, body: { outcome: 'done' } })).status, 404);
  assert.equal((await app.call('POST', `/api/am/tasks/${t.id}/snooze`, { token, body: { days: 1 } })).status, 404);
  assert.equal((await app.call('POST', `/api/am/sellers/${other.id}/request-transfer`, { token, body: { reason: 'x' } })).status, 404);
});

test('a transfer request notifies the Admin and reassigns nothing', async () => {
  const s = await mkSeller('yassine', 5);
  const r = await app.call('POST', `/api/am/sellers/${s.id}/request-transfer`, { token: await tok('yassine'), body: { reason: 'Language fit.' } });
  assert.equal(r.status, 200);
  assert.equal((await prisma.seller.findUnique({ where: { id: s.id } })).assignedAccountManagerId, U.yassine.id);
  assert.equal(await prisma.notification.count({ where: { userId: U.admin.id, kind: 'am.transfer_request' } }), 1);
  assert.equal(await prisma.eventLog.count({ where: { action: 'seller.transfer_requested', entityId: s.id } }), 1);
});
