// The client's integration scope: only the MDM platform (webhook + API key) is on. WhatsApp,
// Yeastar and the Zoho import stay in the code but answer 404 until OPTIONAL_INTEGRATIONS lists
// them. Work done here goes back to the platform from the audit log, in order, once.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTestDatabase } from './helpers/db.js';
import { startApp } from './helpers/http.js';

useTestDatabase('mdm-sync');
process.env.JWT_SECRET = 'test-secret';
process.env.MDM_WEBHOOK_SECRET = 'mdm-key';
for (const k of ['OPTIONAL_INTEGRATIONS', 'MDM_API_KEY', 'MDM_API_URL', 'MDM_WRITEBACK_URL', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN', 'YEASTAR_WEBHOOK_SECRET']) delete process.env[k];
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

test('write-back: off until configured; sends our updates with a merchant snapshot, in order, once; a refusal is retried', async () => {
  assert.equal((await pushPending()).skipped, true);
  const reg = (await hook({ type: 'merchant.registered', data: { phone: '+218915558800', name: 'Huda', country: 'LY' } })).results[0];
  assert.equal(reg.ok, true);
  const ticket = await prisma.ticket.findFirst({ where: { contactId: reg.contactId, type: 'onboarding_task' } });
  // outside the shift the lead may be held; an Admin places it, which is the change MDM should see
  const re = await app.call('POST', `/api/oa/tickets/${ticket.id}/reassign`, { token: await tok('admin'), body: { toUserId: U.salma.id, reason: 'Covering Libya today' } });
  assert.equal(re.status, 200, JSON.stringify(re.body));

  process.env.MDM_API_KEY = 'k'; process.env.MDM_WRITEBACK_URL = 'https://mdm.example/crm/updates';
  try {
    assert.ok((await writebackStatus()).pending >= 1);
    let fail = true;
    const posts = [];
    const fetchImpl = async (url, opts) => {
      posts.push({ url, key: opts.headers['x-api-key'], body: JSON.parse(opts.body) });
      return fail ? { ok: false, status: 503 } : { ok: true, status: 200 };
    };
    const r1 = await pushPending({ fetchImpl });
    assert.equal(r1.failed, true); assert.equal(r1.sent, 0);
    fail = false;
    const r2 = await pushPending({ fetchImpl });
    assert.ok(r2.sent >= 1);
    assert.deepEqual(posts[1].body.events.map((e) => e.id), posts[0].body.events.map((e) => e.id), 'the refused batch is resent as it was');
    const assigned = posts[1].body.events.find((e) => e.type === 'ticket.reassigned');
    assert.equal(assigned.by.email, 'admin@t.local'); assert.equal(assigned.reason, 'Covering Libya today');
    assert.equal(posts[1].url, 'https://mdm.example/crm/updates'); assert.equal(posts[1].key, 'k');
    assert.equal(assigned.merchant.phone, '+218915558800');
    assert.equal(assigned.merchant.onboarding.agent.email, 'salma@t.local');
    assert.ok(!posts[1].body.events.some((e) => e.type.startsWith('contact.created')), 'records that came from the platform are not echoed back');
    assert.deepEqual(await pushPending({ fetchImpl }), { sent: 0 });
    assert.equal((await writebackStatus()).pending, 0);

    // a later change goes out on the next push, alone
    const salma = await tok('salma');
    const call = await app.call('POST', `/api/oa/tickets/${ticket.id}/log-call`, { token: salma, body: { outcome: 'no_answer' } });
    assert.equal(call.status, 200, JSON.stringify(call.body));
    const r3 = await pushPending({ fetchImpl });
    assert.ok(r3.sent >= 1);
    assert.ok(posts.at(-1).body.events.every((e) => !posts[1].body.events.some((p) => p.id === e.id)));
    assert.ok(posts.at(-1).body.events.some((e) => e.type === 'ticket.call_logged'));
  } finally { delete process.env.MDM_API_KEY; delete process.env.MDM_WRITEBACK_URL; }
});
