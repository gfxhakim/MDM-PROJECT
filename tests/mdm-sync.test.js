// The client's integration scope: only the MDM platform (webhook + API key) is on. WhatsApp,
// Yeastar and the Zoho import stay in the code but answer 404 until OPTIONAL_INTEGRATIONS lists
// them. Work done here goes back to the platform from the audit log, in order, once.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTestDatabase } from './helpers/db.js';
import { startApp } from './helpers/http.js';
import { fakeMdm } from './helpers/fake-mdm.js';

useTestDatabase('mdm-sync');
process.env.JWT_SECRET = 'test-secret';
process.env.MDM_WEBHOOK_SECRET = 'mdm-key';
for (const k of ['OPTIONAL_INTEGRATIONS', 'MDM_API_KEY', 'MDM_API_URL', 'MDM_WRITEBACK', 'MDM_PAYMENT_PASSWORD', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN', 'YEASTAR_WEBHOOK_SECRET']) delete process.env[k];
const { prisma } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const cfg = await import('../src/config/service.js');
const { hashPassword } = await import('../src/auth/service.js');
const { pushPending, writebackStatus } = await import('../src/integrations/mdm-writeback.js');

const PASSWORD = 'pw-123456';
const U = {};
let app;
const tok = (k) => app.login(`${k}@t.local`, PASSWORD);
const hook = (body) => fetch(`${app.base}/api/integrations/mdm/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mdm-key': 'mdm-key' }, body: JSON.stringify(body) }).then((r) => r.json());

before(async () => {
  for (const [k, role, markets] of [['admin', 'ADMIN', ['LY', 'IQ', 'LB']], ['salma', 'OA_AGENT', ['LY']], ['yassine', 'ACCOUNT_MANAGER', ['LY']]]) {
    U[k] = await prisma.user.create({ data: { email: `${k}@t.local`, name: k, role, markets: JSON.stringify(markets), passwordHash: await hashPassword(PASSWORD) } });
  }
  await cfg.seedDefaults();
  app = await startApp(createApp);
});
beforeEach(async () => {
  for (const m of ['notification', 'eventLog', 'message', 'ticket', 'seller', 'conversation', 'contact', 'integrationRun']) await prisma[m].deleteMany();
});
after(async () => { app.close(); await prisma.$disconnect(); });

test('only MDM is on: WhatsApp, Yeastar and Zoho routes answer 404 and are not on the status page', async () => {
  const admin = await tok('admin');
  assert.equal((await fetch(`${app.base}/api/integrations/whatsapp/webhook?hub.mode=subscribe`)).status, 404);
  assert.equal((await fetch(`${app.base}/api/integrations/whatsapp/webhook`, { method: 'POST' })).status, 404);
  assert.equal((await fetch(`${app.base}/api/integrations/yeastar/events`, { method: 'POST' })).status, 404);
  assert.equal((await app.call('POST', '/api/integrations/import', { token: admin, body: { kind: 'leads' } })).status, 404);
  assert.equal((await app.call('POST', '/api/integrations/yeastar/dial', { token: admin, body: {} })).status, 404);
  const s = await app.call('GET', '/api/integrations/status', { token: admin });
  assert.equal(s.status, 200);
  assert.deepEqual(s.body.optional, { whatsapp: false, yeastar: false, zoho: false });
  assert.equal(s.body.whatsapp, undefined); assert.equal(s.body.yeastar, undefined);
  assert.ok(s.body.mdm); assert.equal(s.body.writeback.on, false);
});

test('MDM webhook seller.upserted: an established seller joins the book, a repeat only updates figures', async () => {
  const evt = { type: 'seller.upserted', data: { mdmRef: 'MDM-S-77', phone: '+218915557700', name: 'Old Shop', activatedAt: '2025-03-01', metrics: { totalOrders: 300, deliveryRate: 71 } } };
  const r1 = (await hook(evt)).results[0];
  assert.equal(r1.action, 'seller_created');
  const s = await prisma.seller.findUnique({ where: { mdmRef: 'MDM-S-77' } });
  assert.equal(s.assignedAccountManagerId, U.yassine.id); assert.equal(s.totalOrders, 300);
  assert.equal(await prisma.ticket.count({ where: { sellerId: s.id, taskType: 'welcome' } }), 0, 'activated a year ago: no welcome task');
  const r2 = (await hook({ ...evt, data: { ...evt.data, metrics: { totalOrders: 301, healthScore: 100 } } })).results[0];
  assert.equal(r2.ok, false); assert.match(r2.reason, /derived/);
  const r3 = (await hook({ ...evt, data: { ...evt.data, metrics: { totalOrders: 301 } } })).results[0];
  assert.equal(r3.action, 'updated');
  assert.equal(await prisma.seller.count(), 1);
});

test('write-back: off until switched on; our call outcomes become MDM join actions, in order, once; outages retried, refusals reported', async () => {
  assert.equal((await pushPending()).skipped, true);
  process.env.MDM_API_KEY = 'k'; process.env.MDM_WRITEBACK = 'on';
  const before = await prisma.eventLog.count();
  if (before) await prisma.eventLog.create({ data: { entityType: 'ticket', entityId: 'x', action: 'ticket.call_logged', reason: 'no_answer' } });
  assert.deepEqual(await pushPending({ fetchImpl: fakeMdm().fetchImpl }), { sent: 0, refused: [] }, 'switching on starts from now');
  delete process.env.MDM_API_KEY; delete process.env.MDM_WRITEBACK;
  const reg = (await hook({ type: 'seller.upserted', data: { mdmRef: 'MDM-L-1', phone: '+218915558800', name: 'Huda', country: 'LY', joinStatus: 'pending' } })).results[0];
  assert.equal(reg.action, 'lead_created');
  assert.equal((await prisma.contact.findUnique({ where: { id: reg.contactId } })).mdmRef, 'MDM-L-1');
  const ticket = await prisma.ticket.findFirst({ where: { contactId: reg.contactId, type: 'onboarding_task' } });
  // outside the shift the lead may be held; an Admin places it (not something MDM records)
  const re = await app.call('POST', `/api/oa/tickets/${ticket.id}/reassign`, { token: await tok('admin'), body: { toUserId: U.salma.id, reason: 'Covering Libya today' } });
  assert.equal(re.status, 200, JSON.stringify(re.body));
  const salma = await tok('salma');
  assert.equal((await app.call('POST', `/api/oa/tickets/${ticket.id}/log-call`, { token: salma, body: { outcome: 'no_answer' } })).status, 200);

  process.env.MDM_API_KEY = 'k'; process.env.MDM_WRITEBACK = 'on';
  try {
    assert.equal((await writebackStatus()).on, true);
    let outage = true;
    const mdm = fakeMdm({ fail: (method, path) => (outage && path.includes('/join/') ? 503 : null) });
    const r1 = await pushPending({ fetchImpl: mdm.fetchImpl });
    assert.equal(r1.failed, true); assert.equal(r1.sent, 0);
    outage = false;
    const r2 = await pushPending({ fetchImpl: mdm.fetchImpl });
    assert.equal(r2.sent, 1);
    const joins = mdm.calls.filter((c) => c.path.includes('/join/'));
    assert.deepEqual(joins.map((c) => c.path), ['/api/sellers/MDM-L-1/join/not-answer', '/api/sellers/MDM-L-1/join/not-answer'], 'the failed call is retried as it was');
    assert.equal(joins[1].method, 'PATCH'); assert.equal(joins[1].key, 'k');
    assert.match(joins[1].body.notes, /No answer \(attempt 1\) — salma/);
    assert.deepEqual(await pushPending({ fetchImpl: mdm.fetchImpl }), { sent: 0, refused: [] });
    assert.equal((await writebackStatus()).pending, 0);

    // a refusal for one record (MDM's flags) is reported and does not block the next one
    assert.equal((await app.call('POST', `/api/oa/tickets/${ticket.id}/log-call`, { token: salma, body: { outcome: 'answered_soft' } })).status, 200);
    const strict = fakeMdm({ fail: (method, path) => (path.endsWith('/join/followup') ? 422 : null) });
    const r3 = await pushPending({ fetchImpl: strict.fetchImpl });
    assert.equal(r3.sent, 0); assert.equal(r3.refused.length, 1); assert.match(r3.refused[0].reason, /422/);
    assert.equal((await writebackStatus()).pending, 0);
    assert.ok(!strict.calls.some((c) => /accept|reject/.test(c.path)), 'Accept and Reject are never pressed for MDM staff');
  } finally { delete process.env.MDM_API_KEY; delete process.env.MDM_WRITEBACK; }
});

test('write-back: an account manager assigned here is assigned on MDM, matched by email', async () => {
  let r;
  process.env.MDM_API_KEY = 'k'; process.env.MDM_WRITEBACK = 'on';
  await pushPending({ fetchImpl: fakeMdm().fetchImpl });
  delete process.env.MDM_API_KEY; delete process.env.MDM_WRITEBACK;
  r = (await hook({ type: 'seller.upserted', data: { mdmRef: 'MDM-S-90', phone: '+218915559000', name: 'Shop', country: 'LY', joinStatus: 'accepted', joinStatusDate: '2025-02-01' } })).results[0];
  process.env.MDM_API_KEY = 'k'; process.env.MDM_WRITEBACK = 'on';
  try {
    assert.equal(r.action, 'seller_created');
    const mdm = fakeMdm({ managers: [{ trackingId: 'AM-7', email: 'YASSINE@t.local' }] });
    const out = await pushPending({ fetchImpl: mdm.fetchImpl });
    assert.equal(out.sent, 1);
    const assign = mdm.calls.find((c) => c.path === '/api/omni-channel/account-managers/sellers/MDM-S-90');
    assert.equal(assign.method, 'POST'); assert.deepEqual(assign.body, { accountManagerId: 'AM-7' });
  } finally { delete process.env.MDM_API_KEY; delete process.env.MDM_WRITEBACK; }
});
