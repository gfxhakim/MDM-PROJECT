// Step 8 — admin workspaces: analytics computed from the record and scoped per role, bulk runs
// (per-ticket results, one audit entry with the full affected list), template enable/disable.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTestDatabase } from './helpers/db.js';
import { startApp } from './helpers/http.js';

useTestDatabase('admin');
process.env.JWT_SECRET = 'test-secret';
const { prisma } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const cfg = await import('../src/config/service.js');
const { hashPassword } = await import('../src/auth/service.js');

const PASSWORD = 'pw-123456';
const U = {};
let app;
const tok = (k) => app.login(`${k}@t.local`, PASSWORD);
let n = 0;

async function lead(assignee, status = 'new') {
  const c = await prisma.contact.create({ data: { name: `Lead ${++n}`, phone: `+21891555${String(n).padStart(4, '0')}`, country: 'LY', sourceUtm: 'fb_ads' } });
  await prisma.conversation.create({ data: { contactId: c.id } });
  return prisma.ticket.create({ data: { type: 'onboarding_task', contactId: c.id, assigneeId: assignee ? U[assignee].id : null, status, stage: 'first_contact', dueAt: new Date(Date.now() + 86_400_000) } });
}

before(async () => {
  for (const [k, role] of [['admin', 'ADMIN'], ['manager', 'MANAGER'], ['lead', 'SHIFT_LEAD'], ['salma', 'OA_AGENT'], ['karim', 'OA_AGENT'], ['yassine', 'ACCOUNT_MANAGER']]) {
    U[k] = await prisma.user.create({ data: { email: `${k}@t.local`, name: k, role, markets: JSON.stringify(['LY']), passwordHash: await hashPassword(PASSWORD) } });
  }
  await cfg.seedDefaults();
  await prisma.template.create({ data: { key: 'oa_test_v1', module: 'oa', bodyEn: 'Hi {{1}}', status: 'approved', enabled: false } });
  app = await startApp(createApp);
});
beforeEach(async () => {
  for (const m of ['notification', 'eventLog', 'message', 'ticket', 'seller', 'conversation', 'contact']) await prisma[m].deleteMany();
});
after(async () => { app.close(); await prisma.$disconnect(); });

test('onboarding analytics are computed from tickets; an agent receives only their own row', async () => {
  await lead('salma', 'activated');
  await lead('salma');
  await lead('karim', 'junk_lead');
  const team = await app.call('GET', '/api/oa/analytics', { token: await tok('lead') });
  assert.equal(team.status, 200);
  assert.equal(team.body.registrants, 3);
  assert.equal(team.body.activated, 1);
  assert.equal(team.body.junk, 1);
  assert.equal(team.body.agents.length, 2);
  assert.equal(team.body.bySource.find((r) => r.k === 'Meta / Facebook ads').reg, 3);
  const own = await app.call('GET', '/api/oa/analytics', { token: await tok('salma') });
  assert.deepEqual(own.body.agents.map((a) => a.id), [U.salma.id]);
});

test('bulk reassign: per-ticket results, refusals reported, one audit entry with the full list', async () => {
  const a = await lead('salma');
  const b = await lead('salma', 'cold_lead');
  const r = await app.call('POST', '/api/oa/bulk', { token: await tok('lead'), body: { op: 'reassign', ticketIds: [a.id, b.id, 'nope'], toUserId: U.karim.id, reason: 'Leave cover' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.results.length, 3);
  assert.equal(r.body.results.find((x) => x.ticketId === a.id).ok, true);
  assert.equal(r.body.results.find((x) => x.ticketId === 'nope').ok, false);
  const entries = await prisma.eventLog.findMany({ where: { action: 'bulk.oa_reassign' } });
  assert.equal(entries.length, 1);
  assert.equal(JSON.parse(entries[0].after).results.length, 3);
  assert.equal(entries[0].reason, 'Leave cover');
});

test('bulk actions need a reason, and an agent cannot reassign through bulk either (AC-OA-4)', async () => {
  const a = await lead('salma');
  const noReason = await app.call('POST', '/api/oa/bulk', { token: await tok('lead'), body: { op: 'reassign', ticketIds: [a.id], toUserId: U.karim.id } });
  assert.equal(noReason.status, 400);
  const agent = await app.call('POST', '/api/oa/bulk', { token: await tok('salma'), body: { op: 'reassign', ticketIds: [a.id], toUserId: U.salma.id, reason: 'mine' } });
  assert.equal(agent.body.succeeded, 0);
  assert.equal((await prisma.ticket.findUnique({ where: { id: a.id } })).assigneeId, U.salma.id);
});

test('templates: a Manager enables an approved template (audited); an agent cannot', async () => {
  const agent = await app.call('POST', '/api/templates/oa_test_v1/enable', { token: await tok('salma') });
  assert.equal(agent.status, 403);
  const ok = await app.call('POST', '/api/templates/oa_test_v1/enable', { token: await tok('manager') });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.enabled, true);
  assert.equal(await prisma.eventLog.count({ where: { action: 'template.enabled', entityId: 'oa_test_v1' } }), 1);
  const usage = await app.call('GET', '/api/templates/usage', { token: await tok('manager') });
  assert.equal(usage.status, 200);
});

test('AM analytics: Head of AM sees every manager, an AM only their own row; NRR is null, not invented', async () => {
  const head = await app.call('GET', '/api/am/analytics', { token: await tok('admin') });
  assert.equal(head.status, 200);
  assert.ok(U.yassine.id in head.body.perf);
  assert.equal(head.body.perf[U.yassine.id].nrr, null);
  assert.ok('acceptedSellers' in head.body.coverage);
  const own = await app.call('GET', '/api/am/analytics', { token: await tok('yassine') });
  assert.deepEqual(Object.keys(own.body.perf), [U.yassine.id]);
  const agent = await app.call('GET', '/api/am/analytics', { token: await tok('salma') });
  assert.equal(agent.status, 403);
});

test('AM bulk tasks: Admin only, one audit entry for the run', async () => {
  const c = await prisma.contact.create({ data: { name: 'S', phone: '+218919990001', country: 'LY', contactType: 'seller' } });
  const s = await prisma.seller.create({ data: { mdmRef: 'MDM-S-B1', contactId: c.id, market: 'LY', joinStatus: 'accepted', assignedAccountManagerId: U.yassine.id } });
  const denied = await app.call('POST', '/api/am/bulk-tasks', { token: await tok('yassine'), body: { sellerIds: [s.id], taskType: 'checkin', why: 'x' } });
  assert.equal(denied.status, 403);
  const r = await app.call('POST', '/api/am/bulk-tasks', { token: await tok('admin'), body: { sellerIds: [s.id, 'missing'], taskType: 'checkin', title: 'Quarter check', why: 'Quarter start' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.succeeded, r.body.failed], [1, 1]);
  assert.equal(await prisma.eventLog.count({ where: { action: 'bulk.am_task_create' } }), 1);
});
