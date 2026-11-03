// Every piece of data MDM holds for a merchant and a person (HAKIM, 2 Nov), kept by the sync as MDM
// sends it and read back only by someone allowed to see the merchant: a foreign seller is
// not-found (AC-20), and the fees are absent — not blanked — for roles without "See cost / fee /
// margin" (OA Appendix A, 6.7).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTestDatabase } from './helpers/db.js';
import { startApp } from './helpers/http.js';
import { fakeMdm, mdmSeller, mdmUser } from './helpers/fake-mdm.js';

useTestDatabase('mdm-records');
process.env.JWT_SECRET = 'test-secret';
for (const k of ['OPTIONAL_INTEGRATIONS', 'MDM_API_KEY', 'MDM_API_URL', 'MDM_WRITEBACK']) delete process.env[k];
const { prisma } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const cfg = await import('../src/config/service.js');
const { hashPassword } = await import('../src/auth/service.js');
const { syncSellers } = await import('../src/integrations/mdm.js');

const PASSWORD = 'pw-123456';
const U = {};
let app;
let summary;
const tok = (k) => app.login(`${k}@t.local`, PASSWORD);
const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();

before(async () => {
  for (const [k, role, markets] of [['admin', 'ADMIN', ['LY', 'IQ', 'LB']], ['salma', 'OA_AGENT', ['LY']], ['yassine', 'ACCOUNT_MANAGER', ['LY']], ['omar', 'ACCOUNT_MANAGER', ['IQ']]]) {
    U[k] = await prisma.user.create({ data: { email: `${k}@t.local`, name: k, role, markets: JSON.stringify(markets), passwordHash: await hashPassword(PASSWORD) } });
  }
  await cfg.seedDefaults();
  app = await startApp(createApp);
  const mdm = fakeMdm({
    sellers: [
      mdmSeller('MDM-S-R1', '+218915551001', { joinStatus: 'accepted', joinStatusDate: '2025-01-10T00:00:00Z', gender: 'female', totalOrdersPerMonth: '100-500' }),
      mdmSeller('MDM-L-R2', '+218915551002', { createdAt: recent }),
    ],
    orders: { 'MDM-S-R1': 10 },
    stores: [
      { trackingId: 'ST-1', name: 'Rose Boutique', storeType: 'online', status: 'active', updatedAt: '2026-10-30T00:00:00Z', seller: { trackingId: 'MDM-S-R1' }, socialLinks: { instagram: 'rose.ly' } },
      { trackingId: 'ST-2', name: 'Lead Shop', storeType: 'online', status: 'pending', updatedAt: '2026-10-29T00:00:00Z', seller: { trackingId: 'MDM-L-R2' } },
    ],
    teamMembers: { 'MDM-S-R1': [{ trackingId: 'TM-1', sellerId: 'MDM-S-R1', firstName: 'Hiba', lastName: 'K', email: 'hiba@rose.ly', phones: ['+218910000001'], restricted: false }] },
    users: [mdmUser('U-1', 'amal@mdm.express', { firstName: 'Amal', role: 'commercial-agent' })],
  });
  process.env.MDM_API_KEY = 'k';
  try { summary = await syncSellers({ actorId: U.admin.id, fetchImpl: mdm.fetchImpl }); } finally { delete process.env.MDM_API_KEY; }
});
after(async () => { app.close(); await prisma.$disconnect(); });

test('the sync keeps every MDM record: sellers, stores, team members, fees and users, as MDM sent them', async () => {
  assert.equal(summary.errorCount, 0, JSON.stringify(summary.reasons.errors));
  const kinds = Object.fromEntries((await prisma.mdmRecord.groupBy({ by: ['kind'], _count: { _all: true } })).map((r) => [r.kind, r._count._all]));
  assert.deepEqual(kinds, { seller: 2, store: 2, team_member: 1, service_fees: 2, user: 1 });
  const seller = JSON.parse((await prisma.mdmRecord.findUnique({ where: { kind_mdmRef: { kind: 'seller', mdmRef: 'MDM-S-R1' } } })).data);
  assert.equal(seller.totalOrdersPerMonth, '100-500', 'fields kept even when the app has no column for them');
});

test('an account manager reads the record of a seller in their book, fees included; another book is not-found', async () => {
  const s = await prisma.seller.findUnique({ where: { mdmRef: 'MDM-S-R1' } });
  assert.equal(s.assignedAccountManagerId, U.yassine.id);
  const r = await app.call('GET', `/api/mdm/record?sellerId=${s.id}`, { token: await tok('yassine') });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.seller.trackingId, 'MDM-S-R1');
  assert.deepEqual(r.body.stores.map((x) => x.name), ['Rose Boutique']);
  assert.deepEqual(r.body.teamMembers.map((x) => x.email), ['hiba@rose.ly']);
  assert.equal(r.body.fees.length, 1);
  assert.equal(r.body.fees[0].currency, 'LYD');
  assert.equal((await app.call('GET', `/api/mdm/record?sellerId=${s.id}`, { token: await tok('omar') })).status, 404, 'AC-20: a foreign seller is not-found');
});

test('an onboarding agent reads the lead record without fees: the field is absent, with the reason', async () => {
  const contact = await prisma.contact.findFirst({ where: { mdmRef: 'MDM-L-R2' } });
  const t = await prisma.ticket.findFirst({ where: { contactId: contact.id, type: 'onboarding_task' } });
  const r = await app.call('GET', `/api/mdm/record?ticketId=${t.id}`, { token: await tok('salma') });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.seller.trackingId, 'MDM-L-R2');
  assert.deepEqual(r.body.stores.map((x) => x.name), ['Lead Shop']);
  assert.equal('fees' in r.body, false, 'absent, not blanked');
  assert.deepEqual(r.body.withheld, ['fees']);
  const s = await prisma.seller.findUnique({ where: { mdmRef: 'MDM-S-R1' } });
  assert.equal((await app.call('GET', `/api/mdm/record?sellerId=${s.id}`, { token: await tok('salma') })).status, 404);
  assert.equal((await app.call('GET', '/api/mdm/record', { token: await tok('salma') })).status, 400);
});

test('a person on MDM: the Admin reads the full user record; nobody else does', async () => {
  const r = await app.call('GET', '/api/integrations/mdm/staff/U-1/record', { token: await tok('admin') });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.user.email, r.body.user.role], ['amal@mdm.express', 'commercial-agent']);
  assert.equal((await app.call('GET', '/api/integrations/mdm/staff/U-1/record', { token: await tok('salma') })).status, 403);
  assert.equal((await app.call('GET', '/api/integrations/mdm/staff/U-404/record', { token: await tok('admin') })).status, 404);
});

test('the lead page, the seller page and People on MDM carry the read-only From MDM card', async () => {
  const oa = await (await fetch(app.base + '/oa')).text();
  assert.match(oa, /\/assets\/mdm-record\.js\?v=/);
  assert.ok(oa.includes("MDMREC.merchant('ticketId', l.id)"));
  const am = await (await fetch(app.base + '/am')).text();
  assert.ok(am.includes("MDMREC.merchant('sellerId', s.id)"));
  const integ = await (await fetch(app.base + '/integrations')).text();
  assert.match(integ, /\/assets\/mdm-record\.js\?v=/);
  const js = await (await fetch(app.base + '/assets/mdm-record.js')).text();
  assert.match(js, /Cost, margin and settlement withheld/);
});
