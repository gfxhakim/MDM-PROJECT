// Deleting merchants (Admin only; kept out of the MDM sync until restored), removing accounts (the demo
// team at deploy, or an Admin's choice), and the date ranges every list accepts.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTestDatabase } from './helpers/db.js';
import { startApp } from './helpers/http.js';
import { fakeMdm, mdmSeller } from './helpers/fake-mdm.js';

useTestDatabase('deletion');
process.env.JWT_SECRET = 'test-secret';
Object.assign(process.env, { MDM_WEBHOOK_SECRET: 'mdm-key' });
delete process.env.MDM_API_URL; delete process.env.MDM_API_KEY; delete process.env.MDM_WRITEBACK_URL;
const { prisma } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const cfg = await import('../src/config/service.js');
const { hashPassword } = await import('../src/auth/service.js');
const { syncSellers } = await import('../src/integrations/mdm.js');
const { onboardingBudget } = await import('../src/core/templates.js');
const { retireDemoTeam, removeUser, DEMO_TEAM } = await import('../src/auth/users.js');

const PASSWORD = 'pw-123456';
const U = {};
let app;
const tok = (k) => app.login(`${k}@t.local`, PASSWORD);
let n = 0;

async function lead(assignee, { mdmRef = null, at = null, sends = 0 } = {}) {
  n++;
  const c = await prisma.contact.create({ data: { name: `Lead ${n}`, phone: `+21891777${String(n).padStart(4, '0')}`, country: 'LY', mdmRef, mdmCreatedAt: at } });
  const conv = await prisma.conversation.create({ data: { contactId: c.id } });
  await prisma.message.create({ data: { conversationId: conv.id, direction: 'in', body: 'hello' } });
  for (let i = 0; i < sends; i++) await prisma.message.create({ data: { conversationId: conv.id, direction: 'out', kind: 'template', templateKey: 'oa_intro_v2', body: 'Salam', billable: true } });
  const t = await prisma.ticket.create({ data: { type: 'onboarding_task', contactId: c.id, assigneeId: assignee ? U[assignee].id : null, status: 'prequalified', stage: 'first_contact', dueAt: new Date(Date.now() + 86_400_000) } });
  await prisma.notification.create({ data: { userId: U.admin.id, kind: 'x', title: 'x', ticketId: t.id } });
  return { contact: c, conv, ticket: t };
}
async function seller(am, { mdmRef, mdmManagerRef = null } = {}) {
  n++;
  const c = await prisma.contact.create({ data: { name: `Seller ${n}`, phone: `+21891888${String(n).padStart(4, '0')}`, country: 'LY', contactType: 'seller', mdmRef } });
  await prisma.conversation.create({ data: { contactId: c.id } });
  const s = await prisma.seller.create({ data: { mdmRef: mdmRef ?? `LOCAL-${n}`, contactId: c.id, market: 'LY', joinStatus: 'accepted', activatedAt: new Date(), assignedAccountManagerId: am ? U[am].id : null, mdmManagerRef } });
  await prisma.healthHistory.create({ data: { sellerId: s.id, date: new Date(), score: 60, band: 'healthy', components: '{}' } });
  await prisma.playbookProgress.create({ data: { sellerId: s.id, stepDay: 0, tickedAt: new Date() } });
  await prisma.ticket.create({ data: { type: 'am_task', contactId: c.id, sellerId: s.id, assigneeId: am ? U[am].id : null, status: 'open', taskType: 'checkin', title: 't', why: 'w' } });
  return s;
}

before(async () => {
  for (const [k, role] of [['admin', 'ADMIN'], ['admin2', 'ADMIN'], ['manager', 'MANAGER'], ['lead', 'SHIFT_LEAD'], ['salma', 'OA_AGENT'], ['karim', 'OA_AGENT'], ['yassine', 'ACCOUNT_MANAGER'], ['rania', 'ACCOUNT_MANAGER']]) {
    U[k] = await prisma.user.create({ data: { email: `${k}@t.local`, name: k, role, markets: JSON.stringify(['LY']), passwordHash: await hashPassword(PASSWORD) } });
  }
  await cfg.seedDefaults();
  await prisma.template.create({ data: { key: 'oa_intro_v2', module: 'oa', bodyEn: 'Salam {{1}}', status: 'approved' } });
  app = await startApp(createApp);
});
beforeEach(async () => {
  for (const m of ['notification', 'eventLog', 'message', 'healthHistory', 'playbookProgress', 'ticket', 'seller', 'conversation', 'contact', 'integrationRun', 'mdmSkipped', 'deletedMerchant']) await prisma[m].deleteMany();
  await prisma.user.deleteMany({ where: { NOT: { email: { endsWith: '@t.local' } } } });
  for (const u of Object.values(U)) await prisma.user.update({ where: { id: u.id }, data: { active: true, removedAt: null, mdmManagerRef: null } });
});
after(async () => { app.close(); await prisma.$disconnect(); });

test('deleting leads: Admin only, a reason, at most 200; the merchant and everything on it goes; one audit entry; template spend stays spent', async () => {
  const a = await lead('salma', { mdmRef: 'MDM-L-1', sends: 2 });
  const b = await lead(null);
  const keep = await lead('salma');
  const body = { kind: 'leads', ids: [a.ticket.id, b.ticket.id], reason: 'Test registrations' };
  for (const who of ['salma', 'lead', 'manager', 'yassine']) assert.equal((await app.call('POST', '/api/admin/delete', { token: await tok(who), body })).status, 403, who);
  const admin = await tok('admin');
  assert.equal((await app.call('POST', '/api/admin/delete', { token: admin, body: { ...body, reason: ' ' } })).status, 400);
  assert.equal((await app.call('POST', '/api/admin/delete', { token: admin, body: { ...body, kind: 'everything' } })).status, 400);
  assert.equal((await app.call('POST', '/api/admin/delete', { token: admin, body: { ...body, ids: Array.from({ length: 201 }, (_, i) => `x${i}`) } })).status, 400);
  const before = await onboardingBudget(keep.conv.id);
  assert.equal(before.used, 2);

  const r = await app.call('POST', '/api/admin/delete', { token: admin, body: { ...body, ids: [a.ticket.id, b.ticket.id, 'nope'] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.done, 2); assert.equal(r.body.failed, 1);
  assert.equal(r.body.results.find((x) => x.id === 'nope').reason, 'No such lead.');
  for (const x of [a, b]) {
    assert.equal(await prisma.contact.count({ where: { id: x.contact.id } }), 0);
    assert.equal(await prisma.conversation.count({ where: { id: x.conv.id } }), 0);
    assert.equal(await prisma.message.count({ where: { conversationId: x.conv.id } }), 0);
    assert.equal(await prisma.ticket.count({ where: { id: x.ticket.id } }), 0);
    assert.equal(await prisma.notification.count({ where: { ticketId: x.ticket.id } }), 0);
  }
  assert.equal(await prisma.ticket.count({ where: { id: keep.ticket.id } }), 1);
  const tomb = await prisma.deletedMerchant.findMany({ orderBy: { name: 'asc' } });
  assert.equal(tomb.length, 2);
  assert.ok(tomb.every((t) => t.keepOut && t.kind === 'lead' && t.reason === 'Test registrations' && t.deletedById === U.admin.id));
  assert.equal(tomb.find((t) => t.mdmRef === 'MDM-L-1').phone, a.contact.phone);
  assert.equal(JSON.parse(tomb.find((t) => t.mdmRef === 'MDM-L-1').snapshot).tickets[0].owner, 'salma');
  const runs = await prisma.eventLog.findMany({ where: { action: 'records.deleted' } });
  assert.equal(runs.length, 1);
  assert.equal(JSON.parse(runs[0].after).items.length, 3);
  assert.equal(await prisma.eventLog.count({ where: { action: 'contact.deleted' } }), 2);
  // the two template sends of the deleted lead are still spent this month
  assert.equal((await onboardingBudget(keep.conv.id)).used, 2);

  // the Deleted list
  const list = await app.call('GET', '/api/admin/deleted', { token: admin });
  assert.equal(list.status, 200);
  assert.equal(list.body.items.length, 2); assert.equal(list.body.total, 2);
  assert.equal((await app.call('GET', '/api/admin/deleted', { token: await tok('manager') })).status, 403);
});

test('deleting sellers removes the seller record, health history, playbook and tasks; a lead and its seller are one merchant', async () => {
  const s = await seller('yassine', { mdmRef: 'MDM-S-9' });
  const r = await app.call('POST', '/api/admin/delete', { token: await tok('admin'), body: { kind: 'sellers', ids: [s.id], reason: 'Duplicate account' } });
  assert.equal(r.body.done, 1, JSON.stringify(r.body));
  assert.equal(await prisma.seller.count({ where: { id: s.id } }), 0);
  assert.equal(await prisma.healthHistory.count({ where: { sellerId: s.id } }), 0);
  assert.equal(await prisma.playbookProgress.count({ where: { sellerId: s.id } }), 0);
  assert.equal(await prisma.ticket.count({ where: { sellerId: s.id } }), 0);
  assert.equal(await prisma.contact.count({ where: { id: s.contactId } }), 0);
  assert.equal((await prisma.deletedMerchant.findFirst()).mdmRef, 'MDM-S-9');
  // an activated lead whose merchant is also a seller: deleting the lead takes the seller too, and says so
  const l = await lead('salma');
  await prisma.ticket.update({ where: { id: l.ticket.id }, data: { status: 'activated' } });
  const s2 = await prisma.seller.create({ data: { mdmRef: 'MDM-S-10', contactId: l.contact.id, market: 'LY', joinStatus: 'accepted', assignedAccountManagerId: U.yassine.id } });
  const r2 = await app.call('POST', '/api/admin/delete', { token: await tok('admin'), body: { kind: 'leads', ids: [l.ticket.id], reason: 'Test' } });
  assert.match(r2.body.results[0].outcome, /also a seller/);
  assert.equal(await prisma.seller.count({ where: { id: s2.id } }), 0);
});

test('a deleted merchant stays out of the MDM sync and its events until restored; a skipped seller can be deleted from the list', async () => {
  const s = await seller('yassine', { mdmRef: 'MDM-S-OUT' });
  const phone = (await prisma.contact.findUnique({ where: { id: s.contactId } })).phone;
  await app.call('POST', '/api/admin/delete', { token: await tok('admin'), body: { kind: 'sellers', ids: [s.id], reason: 'Closed shop' } });
  const recent = new Date(Date.now() - 86_400_000).toISOString();
  const mdm = fakeMdm({ sellers: [
    mdmSeller('MDM-S-OUT', phone, { joinStatus: 'accepted' }),
    mdmSeller('MDM-L-IN', '+218917770999', { createdAt: recent }),
    // a skipped seller (rejected on MDM); since 5 Nov 2026 a seller outside Libya, Iraq and Lebanon is not synced at all
    mdmSeller('MDM-X-REJ', '+218917770998', { joinStatus: 'rejected', createdAt: recent }),
  ] });
  process.env.MDM_API_KEY = 'k';
  let sum;
  try { sum = await syncSellers({ full: true, fetchImpl: mdm.fetchImpl }); } finally { delete process.env.MDM_API_KEY; }
  assert.equal(sum.keptOut, 1, JSON.stringify(sum));
  assert.equal(await prisma.seller.count({ where: { mdmRef: 'MDM-S-OUT' } }), 0);
  assert.equal(await prisma.mdmSkipped.count({ where: { mdmRef: 'MDM-S-OUT' } }), 0);
  // the lead that came in carries the day it registered on MDM
  const inLead = await prisma.contact.findFirst({ where: { mdmRef: 'MDM-L-IN' } });
  assert.equal(inLead.mdmCreatedAt.toISOString(), recent);
  // the platform's event for the same phone is refused too
  const ev = await fetch(`${app.base}/api/integrations/mdm/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mdm-key': 'mdm-key' }, body: JSON.stringify({ type: 'merchant.registered', data: { phone, name: 'Again', country: 'LY' } }) });
  const evBody = await ev.json();
  assert.match(JSON.stringify(evBody), /Deleted here/);
  assert.equal(await prisma.contact.count({ where: { phone } }), 0);

  // the rejected seller was kept aside: delete it from the list
  const sk = await prisma.mdmSkipped.findUnique({ where: { mdmRef: 'MDM-X-REJ' } });
  const d = await app.call('POST', '/api/admin/delete', { token: await tok('admin'), body: { kind: 'skipped', ids: [sk.id], reason: 'Rejected for good' } });
  assert.equal(d.body.done, 1, JSON.stringify(d.body));
  assert.equal(await prisma.mdmSkipped.count({ where: { mdmRef: 'MDM-X-REJ' } }), 0);

  // restore the seller: the next sync brings it back, as a new record
  const out = await prisma.deletedMerchant.findFirst({ where: { mdmRef: 'MDM-S-OUT' } });
  assert.equal((await app.call('POST', '/api/admin/deleted/restore', { token: await tok('admin'), body: { ids: [out.id] } })).status, 400); // reason required
  const back = await app.call('POST', '/api/admin/deleted/restore', { token: await tok('admin'), body: { ids: [out.id], reason: 'Deleted by mistake' } });
  assert.equal(back.body.done, 1);
  process.env.MDM_API_KEY = 'k';
  try { sum = await syncSellers({ full: true, fetchImpl: mdm.fetchImpl }); } finally { delete process.env.MDM_API_KEY; }
  assert.equal(sum.keptOut ?? 0, 1); // the rejected seller deleted from the list stays out
  assert.equal(await prisma.seller.count({ where: { mdmRef: 'MDM-S-OUT' } }), 1);
  assert.equal(await prisma.mdmSkipped.count({ where: { mdmRef: 'MDM-X-REJ' } }), 0);
  assert.equal(await prisma.eventLog.count({ where: { action: 'records.restored' } }), 1);
});

test('removing an account: work handed on, gone from every list, no sign-in, put back; the last Admin and oneself are refused', async () => {
  const l = await lead('karim');
  const s1 = await seller('yassine', { mdmManagerRef: 'AM-R' });
  const s2 = await seller('yassine');
  await prisma.user.update({ where: { id: U.rania.id }, data: { mdmManagerRef: 'AM-R' } });
  const admin = await tok('admin');
  assert.equal((await app.call('POST', `/api/admin/users/${U.karim.id}/remove`, { token: admin, body: {} })).status, 400);
  assert.equal((await app.call('POST', `/api/admin/users/${U.karim.id}/remove`, { token: await tok('manager'), body: { reason: 'x' } })).status, 403);
  const r = await app.call('POST', `/api/admin/users/${U.karim.id}/remove`, { token: admin, body: { reason: 'Demo account' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.leadsHeld, 1);
  const held = await prisma.ticket.findUnique({ where: { id: l.ticket.id } });
  assert.equal(held.assigneeId, null); assert.equal(held.holdReason, 'agent deactivated');
  const users = (await app.call('GET', '/api/admin/users', { token: admin })).body;
  assert.ok(!users.some((u) => u.id === U.karim.id));
  assert.ok((await app.call('GET', '/api/admin/users?removed=true', { token: admin })).body.find((u) => u.id === U.karim.id).removedAt);
  assert.ok(!(await app.call('GET', '/api/users', { token: admin })).body.some((u) => u.id === U.karim.id));
  assert.equal((await app.call('POST', '/api/auth/login', { body: { email: 'karim@t.local', password: PASSWORD } })).status, 401);
  assert.equal((await app.call('POST', `/api/admin/users/${U.karim.id}/active`, { token: admin, body: { active: true, reason: 'x' } })).status, 400);
  assert.equal(await prisma.eventLog.count({ where: { action: 'user.removed', entityId: U.karim.id } }), 1);

  // an account manager: the seller MDM gives to Rania goes to her (MDM's own assignment, not written back), the other by the rule
  const am = await app.call('POST', `/api/admin/users/${U.yassine.id}/remove`, { token: admin, body: { reason: 'Left the company' } });
  assert.equal(am.body.sellersMoved, 2, JSON.stringify(am.body));
  assert.equal((await prisma.seller.findUnique({ where: { id: s1.id } })).assignedAccountManagerId, U.rania.id);
  assert.equal((await prisma.seller.findUnique({ where: { id: s2.id } })).assignedAccountManagerId, U.rania.id);
  const moved = await prisma.eventLog.findMany({ where: { action: 'seller.reassigned' } });
  assert.equal(moved.filter((e) => JSON.parse(e.after).fromPlatform).length, 1);

  // put back
  const back = await app.call('POST', `/api/admin/users/${U.karim.id}/restore`, { token: admin, body: { reason: 'Mistake' } });
  assert.equal(back.body.active, true);
  assert.equal((await app.call('POST', '/api/auth/login', { body: { email: 'karim@t.local', password: PASSWORD } })).status, 200);

  // oneself; the last active Administrator
  assert.equal((await app.call('POST', `/api/admin/users/${U.admin.id}/remove`, { token: admin, body: { reason: 'x' } })).status, 400);
  await prisma.user.update({ where: { id: U.admin2.id }, data: { active: false } });
  await assert.rejects(removeUser(null, U.admin.id, 'x', prisma), /last active Administrator/);
  assert.equal((await prisma.user.findUnique({ where: { id: U.admin.id } })).removedAt, null);
});

test('deploy step: the demo agents and account managers are removed once; nothing else is touched', async () => {
  const demo = {};
  for (const email of DEMO_TEAM) demo[email] = await prisma.user.create({ data: { email, name: email, role: email.startsWith('y') || email.startsWith('r') || email.startsWith('o') ? 'ACCOUNT_MANAGER' : 'OA_AGENT', markets: '["LY"]', passwordHash: 'x' } });
  await prisma.user.create({ data: { email: 'admin@mdm.local', name: 'Haithem', role: 'ADMIN', markets: '["LY"]', passwordHash: 'x' } });
  const t = await prisma.contact.create({ data: { name: 'L', phone: '+218917771111', country: 'LY' } });
  await prisma.ticket.create({ data: { type: 'onboarding_task', contactId: t.id, assigneeId: demo['salma@mdm.local'].id, status: 'new', stage: 'first_contact' } });
  const first = await retireDemoTeam(prisma);
  assert.equal(first.length, DEMO_TEAM.length);
  assert.equal(first.find((r) => r.email === 'salma@mdm.local').leadsHeld, 1);
  assert.equal(await prisma.user.count({ where: { email: { in: DEMO_TEAM }, removedAt: null } }), 0);
  assert.equal((await prisma.user.findUnique({ where: { email: 'admin@mdm.local' } })).removedAt, null);
  assert.equal((await retireDemoTeam(prisma)).length, 0); // once
  assert.equal(await prisma.eventLog.count({ where: { action: 'user.removed', actorId: null } }), DEMO_TEAM.length);
});

test('date ranges: the audit log, the skipped list and the deleted list take from/to; a bad date is refused', async () => {
  const admin = await tok('admin');
  await prisma.eventLog.create({ data: { entityType: 'ticket', entityId: 'old', action: 'x.old', createdAt: new Date('2026-01-05T10:00:00Z') } });
  await prisma.eventLog.create({ data: { entityType: 'ticket', entityId: 'new', action: 'x.new', actorId: U.admin.id, createdAt: new Date('2026-03-05T10:00:00Z') } });
  const jan = await app.call('GET', '/api/admin/audit?from=2026-01-01T00:00:00Z&to=2026-01-31T23:59:59Z', { token: admin });
  assert.deepEqual(jan.body.map((e) => e.action), ['x.old']);
  assert.deepEqual((await app.call('GET', '/api/admin/audit?actor=system&to=2026-12-31T00:00:00Z', { token: admin })).body.map((e) => e.action), ['x.old']);
  assert.equal((await app.call('GET', '/api/admin/audit?from=yesterday', { token: admin })).status, 400);
  assert.equal((await app.call('GET', '/api/admin/audit?from=2026-03-01T00:00:00Z&to=2026-01-01T00:00:00Z', { token: admin })).status, 400);
  await prisma.mdmSkipped.create({ data: { mdmRef: 'A', reasonCode: 'market', reason: 'x', registeredAt: new Date('2026-02-01T00:00:00Z') } });
  await prisma.mdmSkipped.create({ data: { mdmRef: 'B', reasonCode: 'market', reason: 'x', registeredAt: new Date('2026-04-01T00:00:00Z') } });
  const feb = await app.call('GET', '/api/integrations/mdm/skipped?from=2026-01-15T00:00:00Z&to=2026-02-15T00:00:00Z', { token: admin });
  assert.deepEqual(feb.body.items.map((i) => i.mdmRef), ['A']);
  const staff = await app.call('GET', '/api/integrations/mdm/staff?decision=all&from=2026-01-15T00:00:00Z', { token: admin });
  assert.equal(staff.status, 200);
  await prisma.deletedMerchant.create({ data: { kind: 'lead', name: 'Old', reason: 'r', batchId: 'b', deletedAt: new Date('2026-01-02T00:00:00Z') } });
  const dl = await app.call('GET', '/api/admin/deleted?from=2026-01-01T00:00:00Z&to=2026-01-03T00:00:00Z', { token: admin });
  assert.deepEqual(dl.body.items.map((i) => i.name), ['Old']);
});
