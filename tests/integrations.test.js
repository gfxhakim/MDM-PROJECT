// Step 9 — integrations. Every connector authenticates by its own secret, is idempotent on provider
// retries, never writes derived fields, and degrades to a stated "not connected" when unset.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { useTestDatabase } from './helpers/db.js';
import { startApp } from './helpers/http.js';
import { fakeMdm, mdmSeller } from './helpers/fake-mdm.js';

useTestDatabase('integrations');
process.env.JWT_SECRET = 'test-secret';
Object.assign(process.env, {
  OPTIONAL_INTEGRATIONS: 'whatsapp,yeastar,zoho', WHATSAPP_APP_SECRET: 'wa-secret', WHATSAPP_VERIFY_TOKEN: 'wa-verify', MDM_WEBHOOK_SECRET: 'mdm-key', YEASTAR_WEBHOOK_SECRET: 'pbx-key',
});
delete process.env.WHATSAPP_TOKEN; delete process.env.MDM_API_URL; delete process.env.MDM_API_KEY; delete process.env.MDM_WRITEBACK_URL; delete process.env.YEASTAR_API_URL;
const { prisma } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const cfg = await import('../src/config/service.js');
const { hashPassword } = await import('../src/auth/service.js');
const { syncSellers } = await import('../src/integrations/mdm.js');
const { ratesFromReporting } = await import('../src/integrations/mdm-api.js');
const { parseCsv } = await import('../src/integrations/importer.js');

const PASSWORD = 'pw-123456';
const U = {};
let app;
const tok = (k) => app.login(`${k}@t.local`, PASSWORD);

async function raw(method, path, { headers = {}, body } = {}) {
  const res = await fetch(app.base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
const sign = (s) => `sha256=${createHmac('sha256', 'wa-secret').update(s).digest('hex')}`;
const waPayload = (id, from, text) => JSON.stringify({ entry: [{ changes: [{ value: { contacts: [{ wa_id: from, profile: { name: 'Huda' } }], messages: [{ id, from, timestamp: '1761800000', type: 'text', text: { body: text } }] } }] }] });
const b64 = (s) => Buffer.from(s).toString('base64');

async function seller(ref, phone, am = null, extra = {}) {
  const c = await prisma.contact.create({ data: { name: ref, phone, country: 'LY', contactType: 'seller', ownerAgentId: am } });
  await prisma.conversation.create({ data: { contactId: c.id } });
  return prisma.seller.create({ data: { mdmRef: ref, contactId: c.id, market: 'LY', joinStatus: 'accepted', activatedAt: new Date(), assignedAccountManagerId: am, ...extra } });
}

before(async () => {
  for (const [k, role, markets, ext] of [['admin', 'ADMIN', ['LY'], null], ['manager', 'MANAGER', ['LY'], null], ['salma', 'OA_AGENT', ['LY'], '201'],
    ['yassine', 'ACCOUNT_MANAGER', ['LY'], null], ['rania', 'ACCOUNT_MANAGER', ['LY'], null], ['omar', 'ACCOUNT_MANAGER', ['IQ'], null]]) {
    U[k] = await prisma.user.create({ data: { email: `${k}@t.local`, name: k, role, markets: JSON.stringify(markets), extension: ext, passwordHash: await hashPassword(PASSWORD) } });
  }
  await cfg.seedDefaults();
  app = await startApp(createApp);
});
beforeEach(async () => {
  for (const m of ['notification', 'eventLog', 'message', 'ticket', 'seller', 'conversation', 'contact', 'integrationRun']) await prisma[m].deleteMany();
});
after(async () => { app.close(); await prisma.$disconnect(); });

test('WhatsApp webhook: handshake, signature required, provider retries stored once, delivery statuses applied', async () => {
  assert.equal((await raw('GET', '/api/integrations/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x')).status, 403);
  const ok = await raw('GET', '/api/integrations/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wa-verify&hub.challenge=abc123');
  assert.equal(ok.body, 'abc123');

  const body = waPayload('wamid.1', '218915550001', 'Hello, I registered');
  assert.equal((await raw('POST', '/api/integrations/whatsapp/webhook', { body })).status, 401);
  assert.equal((await raw('POST', '/api/integrations/whatsapp/webhook', { body, headers: { 'x-hub-signature-256': sign(body + ' ') } })).status, 401);

  const r1 = await raw('POST', '/api/integrations/whatsapp/webhook', { body, headers: { 'x-hub-signature-256': sign(body) } });
  assert.equal(r1.status, 200); assert.equal(r1.body.received, 1);
  const r2 = await raw('POST', '/api/integrations/whatsapp/webhook', { body, headers: { 'x-hub-signature-256': sign(body) } });
  assert.equal(r2.body.duplicates, 1);
  const contact = await prisma.contact.findUnique({ where: { phone: '+218915550001' } });
  assert.equal(contact.country, 'LY'); assert.equal(contact.name, 'Huda');
  assert.equal(await prisma.message.count({ where: { externalId: 'wamid.1' } }), 1);

  // a number outside the three markets is recorded as rejected, not silently dropped
  const foreign = waPayload('wamid.2', '447700900000', 'hi');
  const r3 = await raw('POST', '/api/integrations/whatsapp/webhook', { body: foreign, headers: { 'x-hub-signature-256': sign(foreign) } });
  assert.equal(r3.body.skipped.length, 1);
  assert.ok(await prisma.eventLog.findFirst({ where: { action: 'whatsapp.inbound_rejected' } }));

  const conv = await prisma.conversation.findUnique({ where: { contactId: contact.id } });
  await prisma.message.create({ data: { conversationId: conv.id, direction: 'out', kind: 'text', body: 'Welcome', externalId: 'wamid.out1' } });
  const st = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.out1', status: 'read', timestamp: '1761800100' }] } }] }] });
  await raw('POST', '/api/integrations/whatsapp/webhook', { body: st, headers: { 'x-hub-signature-256': sign(st) } });
  assert.equal((await prisma.message.findUnique({ where: { externalId: 'wamid.out1' } })).deliveryStatus, 'read');
});

test('outbound without WhatsApp credentials is kept and marked not_sent', async () => {
  const s = await seller('MDM-S-1', '+218915550010', U.yassine.id);
  await prisma.conversation.update({ where: { contactId: s.contactId }, data: { lastInboundAt: new Date() } });
  const conv = await prisma.conversation.findUnique({ where: { contactId: s.contactId } });
  const r = await app.call('POST', `/api/conversations/${conv.id}/messages`, { token: await tok('yassine'), body: { body: 'Hi there' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await new Promise((res) => setTimeout(res, 50));
  const m = await prisma.message.findFirst({ where: { conversationId: conv.id, direction: 'out' } });
  assert.equal(m.deliveryStatus, 'not_sent');
  const status = await app.call('GET', '/api/integrations/status', { token: await tok('admin') });
  assert.equal(status.body.whatsapp.outbound, false);
  assert.match(status.body.whatsapp.detail, /Not connected/);
});

test('MDM events: key required; registrations, orders and metrics; derived fields refused', async () => {
  const send = (body, key = 'mdm-key') => raw('POST', '/api/integrations/mdm/events', { body: JSON.stringify(body), headers: { 'x-mdm-key': key } });
  assert.equal((await send({ type: 'merchant.registered', data: {} }, 'nope')).status, 401);

  const reg = await send({ type: 'merchant.registered', data: { phone: '+218915550020', name: 'Sara Store', country: 'LY', utm: 'fb_ads' } });
  assert.equal(reg.status, 200); assert.equal(reg.body.results[0].ok, true);
  assert.ok(await prisma.contact.findUnique({ where: { phone: '+218915550020' } }));

  const s = await seller('MDM-S-2', '+218915550021', U.yassine.id);
  const batch = await send({ events: [
    { type: 'order.created', data: { mdmRef: 'MDM-S-2' } },
    { type: 'seller.metrics', data: { mdmRef: 'MDM-S-2', metrics: { deliveryRate: '0.82', products: 14, colour: 'blue' } } },
    { type: 'seller.metrics', data: { mdmRef: 'MDM-S-2', metrics: { healthScore: 99 } } },
    { type: 'refund.issued', data: {} },
  ] });
  const [order, metrics, derived, unknown] = batch.body.results;
  assert.equal(order.ok, true); assert.equal(metrics.ok, true); assert.deepEqual(metrics.ignored, ['colour']);
  assert.equal(derived.ok, false); assert.match(derived.reason, /derived/);
  assert.equal(unknown.ok, false);
  const after = await prisma.seller.findUnique({ where: { id: s.id } });
  assert.equal(after.totalOrders, 1); assert.equal(after.deliveryRate, 82); assert.equal(after.products, 14);
  assert.equal(after.healthScore, null); assert.equal(after.healthStale, true); assert.ok(after.lastSyncedAt);
});

test('MDM pull sync: refused when unset; reads sellers, orders and wallets; updates, creates sellers and leads; one audit entry', async () => {
  const r = await app.call('POST', '/api/integrations/mdm/sync', { token: await tok('admin') });
  assert.equal(r.status, 503); assert.equal(r.body.error.code, 'not_configured');

  await seller('MDM-S-3', '+218915550030', U.yassine.id);
  const recent = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const mdm = fakeMdm({
    sellers: [
      mdmSeller('MDM-S-3', '+218915550030', { joinStatus: 'accepted' }),
      mdmSeller('MDM-S-NEW', '+218915550031', { joinStatus: 'accepted', joinStatusDate: '2025-01-10T00:00:00Z', accountManager: { trackingId: 'AM-R' } }),
      mdmSeller('MDM-S-LEAD', '+218915550032', { createdAt: recent }),
      mdmSeller('MDM-S-OLD', '+218915550033', { createdAt: '2024-01-01T00:00:00Z' }),
      mdmSeller('MDM-S-REJ', '+218915550034', { joinStatus: 'rejected', createdAt: recent }),
      mdmSeller('MDM-S-FR', '+33612345678', { joinStatus: 'accepted', country: { id: 'c-fr', code: 'FRA' }, countries: [{ id: 'c-ma', code: 'MAR' }] }),
      // lives in Algeria, sells in Libya: the market is where the platform delivers for the seller
      mdmSeller('MDM-S-DZ', '+213661234567', { joinStatus: 'accepted', joinStatusDate: '2025-01-10T00:00:00Z', country: { id: 'c-dz', code: 'DZA' }, countries: [{ id: 'c-ma', code: 'MAR' }, { id: 'c-ly', code: 'LBY' }] }),
    ],
    orders: { 'MDM-S-3': 40, 'MDM-S-NEW': 12, 'MDM-S-DZ': 3 },
    reporting: { 'MDM-S-NEW': [{ countryId: 'c-ly', delivered: 8, returned: 1, cancelled: 1, totalLeads: 12, totalParcels: 10 }, { countryId: 'c-iq', delivered: 3, returned: 0, cancelled: 0, totalLeads: 4, totalParcels: 3 }] },
    managers: [{ trackingId: 'AM-R', email: 'rania@t.local' }],
    wallets: { 'MDM-S-3': 310.5, 'MDM-S-DZ': -40 },
  });
  process.env.MDM_API_KEY = 'k'; process.env.MDM_PAYMENT_PASSWORD = 'pay';
  let s;
  try { s = await syncSellers({ actorId: U.admin.id, fetchImpl: mdm.fetchImpl }); } finally { delete process.env.MDM_API_KEY; delete process.env.MDM_PAYMENT_PASSWORD; }
  assert.equal(mdm.calls[0].key, 'k');
  assert.equal(s.full, true);
  assert.deepEqual([s.fetched, s.updated, s.sellersCreated, s.leadsCreated, s.skippedCount, s.errorCount], [7, 1, 2, 1, 3, 0]);
  assert.equal(s.reasons.skipped['Market FRA is not Libya, Iraq or Lebanon (the platform also lists MAR for this seller).'].count, 1);
  const dz = await prisma.seller.findUnique({ where: { mdmRef: 'MDM-S-DZ' }, include: { contact: true } });
  assert.equal(dz.market, 'LY'); assert.equal(dz.contact.country, 'LY'); assert.equal(dz.wallet, -40);
  assert.equal(mdm.calls.find((c) => c.path.includes('wallets') && c.body.filters.sellerId[0] === 'MDM-S-DZ').body.filters.countryId, 'c-ly', "the wallet is read in the seller's market, not the home country");
  assert.deepEqual(s.reasons.skipped['Rejected on the platform (rejected).'].examples, ['MDM-S-REJ']);
  const known = await prisma.seller.findUnique({ where: { mdmRef: 'MDM-S-3' } });
  assert.equal(known.totalOrders, 40); assert.deepEqual(JSON.parse(known.weeklyOrders), [1, 1, 1, 1, 1, 1, 1, 1]);
  assert.equal(known.deliveryRate, 80); assert.equal(known.returnRate, 15); assert.equal(known.cancelRate, 5); assert.equal(known.wallet, 310.5);
  assert.equal(known.marketsServed, 1);
  const inputs = JSON.parse(known.mirrorInputs).rates;
  assert.deepEqual([inputs.delivered, inputs.returned, inputs.cancelled, inputs.orders, inputs.totalParcels, inputs.markets], [80, 15, 5, 100, 95, ['c-ly']], 'the platform counts behind the rates are kept');
  assert.ok(inputs.window.start < inputs.window.end && inputs.readAt);
  const reporting = mdm.calls.filter((c) => c.path === '/api/analytics/orders/sellers-status/search');
  assert.ok(reporting.length >= 2 && reporting.every((c) => c.method === 'POST' && c.body.filters.sellerId.length === 1 && c.body.filters.date.start), "rates come from MDM's reporting rows, filtered by seller and window");
  assert.ok(!mdm.calls.some((c) => c.path.includes('/statistics/')), 'the statistics service that answers 500 is never called');
  assert.equal(known.assignedAccountManagerId, U.yassine.id);
  assert.equal(known.healthScore, null, 'health is never read from the platform');
  assert.equal(mdm.calls.find((c) => c.path.includes('wallets')).headers['x-payment-password'], 'pay');
  const created = await prisma.seller.findUnique({ where: { mdmRef: 'MDM-S-NEW' }, include: { contact: true } });
  assert.equal(created.market, 'LY'); assert.equal(created.totalOrders, 12);
  assert.deepEqual([created.deliveryRate, created.returnRate, created.cancelRate, created.marketsServed], [68.8, 6.3, 6.3, 2], 'two market rows: counts summed over 16 orders, two markets served');
  assert.equal(created.assignedAccountManagerId, U.rania.id, "the platform's account manager is kept: same email, covers LY, has room");
  assert.equal(created.contact.mdmRef, 'MDM-S-NEW');
  const lead = await prisma.contact.findUnique({ where: { phone: '+218915550032' } });
  assert.equal(lead.contactType, 'merchant'); assert.equal(lead.mdmRef, 'MDM-S-LEAD');
  assert.ok(await prisma.ticket.findFirst({ where: { contactId: lead.id, type: 'onboarding_task' } }));
  assert.equal(await prisma.contact.count({ where: { phone: { in: ['+218915550033', '+218915550034'] } } }), 0, 'old and rejected registrations are not opened as leads');
  assert.equal(await prisma.integrationRun.count({ where: { kind: 'mdm_sync', status: 'completed' } }), 1);
  assert.equal(await prisma.eventLog.count({ where: { action: 'mdm.sync' } }), 1);

  // a figure the platform refuses is left out with its reason; the seller still comes in
  const picky = fakeMdm({
    sellers: [mdmSeller('MDM-S-P', '+218915550040', { joinStatus: 'accepted', joinStatusDate: '2025-01-10T00:00:00Z' })],
    orders: { 'MDM-S-P': 7 }, fail: (method, path) => (path === '/api/analytics/orders/sellers-status/search' ? 403 : null),
  });
  process.env.MDM_API_KEY = 'k';
  try { s = await syncSellers({ full: true, fetchImpl: picky.fetchImpl }); } finally { delete process.env.MDM_API_KEY; }
  assert.equal(s.sellersCreated, 1); assert.equal(s.errorCount, 0); assert.equal(s.warningCount, 1);
  assert.match(Object.keys(s.reasons.warnings)[0], /^delivery, return and cancel rates: MDM API POST .* responded 403/);
  const p = await prisma.seller.findUnique({ where: { mdmRef: 'MDM-S-P' } });
  assert.equal(p.totalOrders, 7); assert.equal(p.deliveryRate, 0); assert.equal(p.mirrorInputs, '{}');

  // reporting figures that cannot be right, or missing for a seller with orders, are reported — never written
  const odd = fakeMdm({
    sellers: [mdmSeller('MDM-S-Q', '+218915550041', { joinStatus: 'accepted', joinStatusDate: '2025-01-10T00:00:00Z' }), mdmSeller('MDM-S-R', '+218915550042', { joinStatus: 'accepted', joinStatusDate: '2025-01-10T00:00:00Z' })],
    orders: { 'MDM-S-Q': 9, 'MDM-S-R': 9 }, reporting: { 'MDM-S-Q': [{ delivered: 120, returned: 0, cancelled: 0, totalLeads: 100, totalParcels: 100 }], 'MDM-S-R': [] },
  });
  process.env.MDM_API_KEY = 'k';
  try { s = await syncSellers({ full: true, fetchImpl: odd.fetchImpl }); } finally { delete process.env.MDM_API_KEY; }
  assert.equal(s.sellersCreated, 2); assert.equal(s.warningCount, 2);
  assert.deepEqual(Object.values(s.reasons.warnings).map((w) => w.examples), [['MDM-S-Q'], ['MDM-S-R']]);
  assert.match(Object.keys(s.reasons.warnings)[0], /counts do not add up \(120 delivered, 0 returned, 0 cancelled out of 100 orders\)/);
  assert.match(Object.keys(s.reasons.warnings)[1], /MDM reporting has no figures for this seller although it has orders in the last 8 weeks/);
  for (const ref of ['MDM-S-Q', 'MDM-S-R']) assert.equal((await prisma.seller.findUnique({ where: { mdmRef: ref } })).deliveryRate, 0);

  // one sync at a time
  process.env.MDM_API_KEY = 'k';
  try {
    const slow = fakeMdm({ sellers: [] });
    const first = syncSellers({ fetchImpl: async (u, o) => { await new Promise((r) => setTimeout(r, 50)); return slow.fetchImpl(u, o); } });
    await assert.rejects(syncSellers({ fetchImpl: slow.fetchImpl }), (e) => e.status === 409);
    await first;
  } finally { delete process.env.MDM_API_KEY; }

  // the next run only reads what changed: nothing updated since → no seller is re-read
  const quiet = fakeMdm({ sellers: [mdmSeller('MDM-S-3', '+218915550030', { joinStatus: 'accepted', updatedAt: '2020-01-01T00:00:00Z' })], orders: {} });
  process.env.MDM_API_KEY = 'k';
  try { s = await syncSellers({ fetchImpl: quiet.fetchImpl }); } finally { delete process.env.MDM_API_KEY; }
  assert.equal(s.full, false); assert.equal(s.fetched, 0); assert.equal(s.updated, 0);
});

test("MDM reporting rows → rates: counts summed over the seller's markets, no orders → no rates, impossible counts → a problem", () => {
  const two = ratesFromReporting([
    { countryId: 'c-ly', delivered: 30, returned: 10, cancelled: 20, totalLeads: 90, totalParcels: 50, totalParcelsWithoutLead: 10 },
    { countryId: 'c-iq', delivered: 5, returned: 0, cancelled: 0, totalLeads: 0, totalParcels: 5, totalParcelsWithoutLead: 0 },
    { countryId: 'c-lb', delivered: 0, returned: 0, cancelled: 0, totalLeads: 0, totalParcels: 0, totalParcelsWithoutLead: 0 },
  ], { window: { start: 'a', end: 'b' } });
  assert.deepEqual(two.rates, { deliveryRate: 35, returnRate: 10, cancelRate: 20 });
  assert.equal(two.marketsServed, 2, 'a market with no orders and no parcels is not served');
  assert.deepEqual([two.inputs.orders, two.inputs.totalParcels, two.inputs.markets, two.inputs.window], [100, 55, ['c-ly', 'c-iq'], { start: 'a', end: 'b' }]);
  const none = ratesFromReporting([]);
  assert.deepEqual([none.rates, none.marketsServed, none.inputs.orders, none.problem], [null, 1, 0, undefined]);
  const nulls = ratesFromReporting([{ countryId: 'c-ly', delivered: null, returned: 'x', cancelled: 2, totalLeads: 10, totalParcels: 4 }]);
  assert.deepEqual(nulls.rates, { deliveryRate: 0, returnRate: 0, cancelRate: 20 }, 'a missing count reads as 0, never NaN');
  const over = ratesFromReporting([{ countryId: 'c-ly', delivered: 11, returned: 0, cancelled: 0, totalLeads: 10, totalParcels: 10 }]);
  assert.equal(over.rates, null); assert.match(over.problem, /do not add up/);
});

test('CSV parser: quotes, escaped quotes, CRLF, semicolon exports, BOM', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n'), [['a', 'b'], ['x, y', 'say "hi"']]);
  assert.deepEqual(parseCsv('a;b\n1;2\n'), [['a', 'b'], ['1', '2']]);
});

test('Zoho lead import: dry run writes nothing; commit registers open leads, skips closed and duplicates, one audit entry', async () => {
  const csv = [
    'Lead Name,Mobile,Country,Lead Source,Lead Status',
    'Amal Boutique,+218 91 555 0101,Libya,fb_ads,Contacted',
    'Junk Person,+218915550102,Libya,,Junk Lead',
    'Amal again,00218915550101,Libya,,New',
    'Paris Shop,+33 6 12 34 56 78,France,,New',
    'No Phone,,Libya,,New',
  ].join('\n');
  const body = { kind: 'leads', filename: 'zoho_leads.csv', contentBase64: b64(csv) };
  assert.equal((await app.call('POST', '/api/integrations/import', { token: await tok('manager'), body })).status, 403);

  const dry = await app.call('POST', '/api/integrations/import', { token: await tok('admin'), body });
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  assert.equal(dry.body.dryRun, true);
  assert.deepEqual([dry.body.summary.create, dry.body.summary.skip], [1, 4]);
  assert.match(dry.body.plan[1].reason, /Closed in Zoho/);
  assert.match(dry.body.plan[2].reason, /Duplicate/);
  assert.equal(await prisma.contact.count(), 0);

  const run = await app.call('POST', '/api/integrations/import', { token: await tok('admin'), body: { ...body, dryRun: false } });
  assert.equal(run.body.summary.succeeded, 1);
  const c = await prisma.contact.findUnique({ where: { phone: '+218915550101' } });
  assert.equal(c.legacy, true); assert.equal(c.sourceUtm, 'fb_ads');
  assert.equal(await prisma.ticket.count({ where: { contactId: c.id, type: 'onboarding_task' } }), 1);
  const audit = await prisma.eventLog.findMany({ where: { action: 'import.zoho_leads' } });
  assert.equal(audit.length, 1); assert.equal(JSON.parse(audit[0].after).results.length, 5);
  assert.equal(await prisma.integrationRun.count({ where: { kind: 'zoho_import' } }), 1);
});

test('Zoho seller import: owner kept only when they cover the market with room; never imports health', async () => {
  await seller('MDM-S-9', '+218915550209', U.yassine.id); // yassine has 1, rania 0
  const csv = [
    'Account Name,Mobile,Country,Seller ID,Account Owner,Total Orders,Delivery Rate,Activation Date,Welcome Call',
    'Kept,+218915550201,Libya,MDM-S-201,yassine@t.local,120,91%,2025-01-10,2025-01-11',
    'Wrong market owner,+218915550202,Libya,MDM-S-202,omar,15,80,2025-02-01,2025-02-02',
    'Unknown owner,+218915550203,Libya,MDM-S-203,Somebody Else,5,70,2025-03-01,2025-03-02',
    `Fresh,+218915550204,Libya,MDM-S-204,,0,0,${new Date().toISOString().slice(0, 10)},`,
    'Existing,+218915550209,Libya,MDM-S-9,rania,77,88,2025-01-01,2025-01-02',
  ].join('\n');
  const r = await app.call('POST', '/api/integrations/import', { token: await tok('admin'), body: { kind: 'sellers', filename: 'book.csv', contentBase64: b64(csv), dryRun: false } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const by = async (ref) => prisma.seller.findUnique({ where: { mdmRef: ref } });
  assert.equal((await by('MDM-S-201')).assignedAccountManagerId, U.yassine.id);
  assert.equal((await by('MDM-S-202')).assignedAccountManagerId, U.rania.id); // omar covers IQ only → smallest LY book
  assert.match(r.body.summary.results[1].ownership, /rania/);
  assert.ok([U.yassine.id, U.rania.id].includes((await by('MDM-S-203')).assignedAccountManagerId));
  // established sellers get no welcome task; a fresh activation goes through the handover (r1)
  assert.equal(await prisma.ticket.count({ where: { taskType: 'welcome', seller: { mdmRef: { in: ['MDM-S-201', 'MDM-S-202', 'MDM-S-203'] } } } }), 0);
  assert.equal(await prisma.ticket.count({ where: { taskType: 'welcome', seller: { mdmRef: 'MDM-S-204' } } }), 1);
  // existing seller: figures updated, ownership unchanged
  const ex = await by('MDM-S-9');
  assert.equal(ex.assignedAccountManagerId, U.yassine.id); assert.equal(ex.totalOrders, 77);
  assert.equal((await by('MDM-S-201')).deliveryRate, 91);
  assert.equal((await by('MDM-S-201')).healthScore, null);

  const bad = await app.call('POST', '/api/integrations/import', { token: await tok('admin'), body: { kind: 'sellers', contentBase64: b64('Mobile,Health Score\n+218915550301,99\n') } });
  assert.equal(bad.body.summary.unmapped[0], 'Health Score'); // a health column is never mapped
});

test('Zoho import reads Excel files', async () => {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Leads');
  ws.addRow(['First Name', 'Last Name', 'Mobile', 'Country']);
  ws.addRow(['Rim', 'Haddad', '+961 3 555 010', 'Lebanon']);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const r = await app.call('POST', '/api/integrations/import', { token: await tok('admin'), body: { kind: 'leads', filename: 'leads.xlsx', contentBase64: buf.toString('base64') } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.plan[0].action, 'create_lead');
  assert.equal(r.body.plan[0].name, 'Rim Haddad'); assert.equal(r.body.plan[0].market, 'LB');
});

test('Yeastar: secret required; presence drives on-call; call lines attach once and never log an outcome; dial degrades', async () => {
  const send = (body, key = 'pbx-key') => raw('POST', '/api/integrations/yeastar/events', { body: JSON.stringify(body), headers: { 'x-yeastar-secret': key } });
  assert.equal((await send({ type: 'presence', extension: '201', onCall: true }, 'x')).status, 401);
  await send({ type: 'presence', extension: '201', onCall: true });
  assert.equal((await prisma.user.findUnique({ where: { id: U.salma.id } })).onCall, true);

  const c = await prisma.contact.create({ data: { name: 'Lead', phone: '+218915550401', country: 'LY', ownerAgentId: U.salma.id } });
  const conv = await prisma.conversation.create({ data: { contactId: c.id } });
  const t = await prisma.ticket.create({ data: { type: 'onboarding_task', contactId: c.id, assigneeId: U.salma.id, status: 'new', stage: 'first_contact' } });
  const evt = { type: 'call_end', callId: 'c-1', extension: '201', number: '218915550401', direction: 'outbound', durationSec: 0, answered: false };
  const first = await send(evt);
  assert.equal(first.body.ok, true, JSON.stringify(first.body));
  assert.equal((await send(evt)).body.duplicate, true);
  const lines = await prisma.message.findMany({ where: { conversationId: conv.id, kind: 'call_event' } });
  assert.equal(lines.length, 1); assert.match(lines[0].body, /no answer/);
  const ticket = await prisma.ticket.findUnique({ where: { id: t.id } });
  assert.equal(ticket.attemptNo, 0); assert.equal(ticket.status, 'new'); // the cadence counts agent-logged calls only
  assert.equal((await prisma.user.findUnique({ where: { id: U.salma.id } })).onCall, false);

  const dial = await app.call('POST', '/api/integrations/yeastar/dial', { token: await tok('salma'), body: { contactId: c.id } });
  assert.equal(dial.status, 503); assert.equal(dial.body.error.code, 'not_configured');
});

test('integrations page is served; its status API is Admin-only', async () => {
  const page = await fetch(`${app.base}/integrations`);
  assert.equal(page.status, 200); assert.match(await page.text(), /Zoho import/);
  assert.equal((await app.call('GET', '/api/integrations/status', { token: await tok('manager') })).status, 403);
  assert.equal((await app.call('GET', '/api/integrations/status')).status, 401);
});
