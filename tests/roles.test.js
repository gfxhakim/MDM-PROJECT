// The four accesses: Onboarding agent, Account manager, Head of AM, Administrator — each with its own
// menu, pages and server-side permissions. The Head of AM is the AM module's Administrator (AM 9.1,
// AM Appendix A "Admin"; the AM prototype's "Head of AM"), held by its own account: account
// management in full, the AM part of the audit trail, no onboarding workspace, no platform settings.
// Roles change only through the Admin's "Change role" (OA Appendix A: Manage roles & permissions).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTestDatabase } from './helpers/db.js';
import { startApp } from './helpers/http.js';

useTestDatabase('roles');
process.env.JWT_SECRET = 'test-secret';
const { prisma } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const cfg = await import('../src/config/service.js');
const { hashPassword } = await import('../src/auth/service.js');
const { grantsFor, ROLES } = await import('../src/auth/permissions.js');

const PASSWORD = 'pw-123456';
const U = {};
let app;
const tok = (k) => app.login(`${k}@t.local`, PASSWORD);
const call = (...a) => app.call(...a);
let seq = 100;

async function mkSeller(amKey) {
  const n = seq++;
  const contact = await prisma.contact.create({ data: { name: `Seller ${n}`, phone: `+2189400${n}`, country: 'LY', contactType: 'seller', ownerAgentId: U[amKey].id } });
  await prisma.conversation.create({ data: { contactId: contact.id } });
  return prisma.seller.create({
    data: { mdmRef: `MDM-R-${n}`, contactId: contact.id, market: 'LY', joinStatus: 'accepted', activatedAt: new Date(Date.now() - 60 * 86_400_000),
      assignedAccountManagerId: U[amKey].id, welcomeCallAt: new Date(), totalOrders: 50, weeklyOrders: JSON.stringify([5, 5, 5, 5, 5, 5, 5, 5]), lastOrderAt: new Date() },
  });
}
async function mkLead(agentKey) {
  const n = seq++;
  const c = await prisma.contact.create({ data: { name: `Lead ${n}`, phone: `+2189500${n}`, country: 'LY', sourceUtm: 'fb_ads' } });
  await prisma.conversation.create({ data: { contactId: c.id } });
  return prisma.ticket.create({ data: { type: 'onboarding_task', contactId: c.id, assigneeId: U[agentKey].id, status: 'new', stage: 'first_contact', dueAt: new Date(Date.now() + 86_400_000) } });
}

before(async () => {
  for (const [k, role] of [['admin', 'ADMIN'], ['head', 'HEAD_OF_AM'], ['manager', 'MANAGER'], ['salma', 'OA_AGENT'], ['yassine', 'ACCOUNT_MANAGER'], ['rania', 'ACCOUNT_MANAGER']]) {
    U[k] = await prisma.user.create({ data: { email: `${k}@t.local`, name: k, role, markets: JSON.stringify(['LY']), passwordHash: await hashPassword(PASSWORD) } });
  }
  app = await startApp(createApp);
});
beforeEach(async () => {
  for (const m of ['notification', 'eventLog', 'message', 'ticket', 'playbookProgress', 'healthHistory', 'seller', 'conversation', 'contact']) await prisma[m].deleteMany();
  await prisma.configDraft.deleteMany();
  await prisma.configVersion.deleteMany();
  await cfg.seedDefaults();
  for (const [k, role] of [['admin', 'ADMIN'], ['head', 'HEAD_OF_AM'], ['manager', 'MANAGER'], ['salma', 'OA_AGENT'], ['yassine', 'ACCOUNT_MANAGER'], ['rania', 'ACCOUNT_MANAGER']]) {
    await prisma.user.update({ where: { id: U[k].id }, data: { role, active: true, removedAt: null, markets: JSON.stringify(['LY']) } });
  }
});
after(async () => { app?.close(); await prisma.$disconnect(); });

test('four separate accesses: each role signs in to its own console with its own grants', async () => {
  assert.ok(ROLES.includes('HEAD_OF_AM'));
  const me = {};
  for (const k of ['salma', 'yassine', 'head', 'admin']) me[k] = (await call('GET', '/api/auth/me', { token: await tok(k) })).body;
  assert.deepEqual([me.salma.user.role, me.yassine.user.role, me.head.user.role, me.admin.user.role], ['OA_AGENT', 'ACCOUNT_MANAGER', 'HEAD_OF_AM', 'ADMIN']);
  const head = me.head.grants; const admin = grantsFor('ADMIN'); const amg = grantsFor('ACCOUNT_MANAGER');
  // account management: exactly the Admin column of AM Appendix A
  for (const k of ['seller.view', 'seller.update', 'seller.assign_am', 'am_task.create', 'am_task.bulk_create', 'am_task.close', 'am_task.escalate', 'playbook.tick',
    'am.reply', 'am.note', 'am.template', 'am.conversation_read', 'am.take_over', 'contact.request_block', 'am.performance_team', 'am.performance_own', 'am.rule_sweep']) {
    assert.equal(head[k], admin[k], k);
  }
  // onboarding: what an account manager holds; platform settings stay the Admin's
  for (const k of ['onboarding.view_all', 'onboarding.reply', 'onboarding.activate', 'onboarding.reassign', 'onboarding.bulk_internal', 'automation.manage', 'contact.block']) {
    assert.equal(head[k], amg[k], k);
  }
  for (const k of ['roles.manage', 'integrations.manage', 'records.delete']) { assert.equal(head[k], false, k); assert.equal(admin[k], true, k); }
  assert.equal(head['audit.view'], true);
  // the account manager and the onboarding agent are unchanged by the new role
  assert.equal(amg['seller.view'], 'own_book'); assert.equal(amg['seller.assign_am'], false); assert.equal(amg['audit.view'], false);
  assert.equal(grantsFor('OA_AGENT')['seller.view'], false); assert.equal(grantsFor('OA_AGENT')['onboarding.reassign'], 'request');
});

test('Head of AM: every seller, reassigns with a reason, bulk tasks, runs the sweep; an account manager sees only their book', async () => {
  const sy = await mkSeller('yassine'); const sr = await mkSeller('rania');
  const head = await tok('head');
  let r = await call('GET', '/api/am/book', { token: head });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.map((s) => s.id).sort(), [sy.id, sr.id].sort());
  r = await call('GET', '/api/am/book', { token: await tok('yassine') });
  assert.deepEqual(r.body.map((s) => s.id), [sy.id]);
  assert.equal((await call('GET', `/api/am/sellers/${sr.id}`, { token: await tok('yassine') })).status, 404); // AC-20
  assert.equal((await call('GET', `/api/am/sellers/${sr.id}`, { token: head })).status, 200);

  assert.equal((await call('POST', '/api/am/reassign', { token: head, body: { sellerIds: [sy.id], toManagerId: U.rania.id } })).status, 400);
  assert.equal((await call('POST', '/api/am/reassign', { token: await tok('yassine'), body: { sellerIds: [sy.id], toManagerId: U.rania.id, reason: 'x' } })).status, 403);
  r = await call('POST', '/api/am/reassign', { token: head, body: { sellerIds: [sy.id], toManagerId: U.rania.id, reason: 'Balance the books' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await prisma.seller.findUnique({ where: { id: sy.id } })).assignedAccountManagerId, U.rania.id);

  r = await call('POST', '/api/am/bulk-tasks', { token: head, body: { sellerIds: [sy.id, sr.id], taskType: 'checkin', title: 'Ramadan check-in', why: 'Seasonal campaign' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await prisma.ticket.count({ where: { type: 'am_task', taskType: 'checkin' } }), 2);
  assert.equal((await call('POST', '/api/am/bulk-tasks', { token: await tok('rania'), body: { sellerIds: [sy.id], taskType: 'checkin', why: 'x' } })).status, 403);
  assert.equal((await call('POST', '/api/am/sweep', { token: head })).status, 200);
  assert.equal((await call('GET', '/api/am/coverage', { token: head })).status, 200);
});

test('Head of AM: changes the AM settings only; the onboarding settings stay the Manager\'s and Admin\'s', async () => {
  const head = await tok('head');
  let r = await call('PATCH', '/api/config/draft', { token: head, body: { changes: { 'am.welcomeCallH': 12 } } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await call('POST', '/api/config/publish', { token: head, body: { note: 'faster welcome' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await cfg.getLiveConfig()).values['am.welcomeCallH'], 12);
  r = await call('PATCH', '/api/config/draft', { token: head, body: { changes: { 'oa.first_contact_sla': 12 } } });
  assert.equal(r.status, 403, JSON.stringify(r.body));
  r = await call('PATCH', '/api/config/draft', { token: await tok('manager'), body: { changes: { 'am.welcomeCallH': 6 } } });
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.equal((await call('PATCH', '/api/config/draft', { token: await tok('yassine'), body: { changes: { 'am.welcomeCallH': 6 } } })).status, 403);
});

test('Head of AM: no onboarding workspace, no platform settings, no deleting; audit is the account-management part', async () => {
  const lead = await mkLead('salma');
  const s = await mkSeller('yassine');
  const head = await tok('head');
  let r = await call('GET', '/api/oa/leads', { token: head });
  assert.equal(r.status, 200);
  assert.equal(r.body.leads?.length ?? r.body.length, 0);
  assert.equal((await call('GET', `/api/oa/tickets/${lead.id}`, { token: head })).status, 404);
  for (const [m, p] of [['GET', '/api/integrations/status'], ['GET', '/api/admin/users'], ['POST', '/api/admin/delete'], ['GET', '/api/admin/deleted'], ['GET', '/api/admin/roles/OA_AGENT/grants']]) {
    assert.equal((await call(m, p, { token: head, body: m === 'POST' ? {} : undefined })).status, 403, p);
  }
  // one onboarding event, one account-management event, one block on each side
  const ev = (await import('../src/services/audit.js')).logEvent;
  await ev({ actorId: U.salma.id, entityType: 'ticket', entityId: lead.id, action: 'ticket.stage_changed', after: { stage: 'qualified' } });
  await ev({ actorId: U.admin.id, entityType: 'contact', entityId: lead.contactId, action: 'contact.blocked', reason: 'spam' });
  r = await call('POST', `/api/contacts/${s.contactId}/block`, { token: head, body: { reason: 'abusive messages' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await call('POST', '/api/am/reassign', { token: head, body: { sellerIds: [s.id], toManagerId: U.rania.id, reason: 'cover' } });
  assert.equal(r.status, 200);
  const headTrail = (await call('GET', '/api/admin/audit', { token: head })).body;
  const adminTrail = (await call('GET', '/api/admin/audit', { token: await tok('admin') })).body;
  assert.ok(headTrail.some((e) => e.action === 'seller.reassigned'));
  assert.ok(headTrail.some((e) => e.action === 'contact.blocked' && e.entityId === s.contactId));
  assert.ok(!headTrail.some((e) => e.entityId === lead.id || e.entityId === lead.contactId), 'no onboarding entries');
  assert.ok(adminTrail.some((e) => e.entityId === lead.id) && adminTrail.some((e) => e.entityId === lead.contactId));
  assert.equal((await call('GET', '/api/admin/audit', { token: await tok('yassine') })).status, 403);
});

test('Head of AM: takes over and releases a seller conversation; receives escalations', async () => {
  const s = await mkSeller('yassine');
  const conv = await prisma.conversation.findFirst({ where: { contactId: s.contactId } });
  const head = await tok('head');
  let r = await call('POST', `/api/conversations/${conv.id}/take-over`, { token: head, body: { reason: 'Seller asked for a supervisor' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.owner.userId, U.head.id);
  r = await call('POST', `/api/conversations/${conv.id}/release`, { token: head });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  r = await call('POST', `/api/am/sellers/${s.id}/tasks`, { token: await tok('yassine'), body: { taskType: 'intervention', title: 'Returns', why: 'returns 40%' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  r = await call('POST', `/api/am/tasks/${r.body.id}/escalate`, { token: await tok('yassine'), body: { reason: 'Needs a pricing decision' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const notes = (await call('GET', '/api/notifications', { token: head })).body;
  assert.ok(notes.some((n) => n.kind === 'am.task_escalated'), JSON.stringify(notes));
  assert.equal((await call('GET', '/api/notifications', { token: await tok('salma') })).body.length, 0);
});

test('Admin changes a role with a reason: work handed on, takes effect on the next click, audited; refusals stated', async () => {
  const s1 = await mkSeller('yassine'); const s2 = await mkSeller('yassine');
  const admin = await tok('admin');
  const yTok = await tok('yassine');
  const path = `/api/admin/users/${U.yassine.id}/role`;
  assert.equal((await call('POST', path, { token: admin, body: { role: 'HEAD_OF_AM' } })).status, 400); // reason required
  assert.equal((await call('POST', path, { token: admin, body: { role: 'BOSS', reason: 'x' } })).status, 400);
  assert.equal((await call('POST', path, { token: await tok('head'), body: { role: 'HEAD_OF_AM', reason: 'x' } })).status, 403);
  assert.equal((await call('POST', `/api/admin/users/${U.admin.id}/role`, { token: admin, body: { role: 'HEAD_OF_AM', reason: 'x' } })).status, 400); // own account

  let r = await call('POST', path, { token: admin, body: { role: 'HEAD_OF_AM', reason: 'Promoted to lead the AM team' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.sellersMoved, 2);
  for (const s of [s1, s2]) assert.equal((await prisma.seller.findUnique({ where: { id: s.id } })).assignedAccountManagerId, U.rania.id);
  // the same token, next request: the new role
  assert.equal((await call('GET', '/api/auth/me', { token: yTok })).body.user.role, 'HEAD_OF_AM');
  assert.equal((await call('GET', '/api/am/book', { token: yTok })).body.length, 2);
  const entry = await prisma.eventLog.findFirst({ where: { action: 'user.role_changed', entityId: U.yassine.id } });
  assert.equal(JSON.parse(entry.before).role, 'ACCOUNT_MANAGER');
  assert.equal(JSON.parse(entry.after).role, 'HEAD_OF_AM');
  assert.equal(entry.reason, 'Promoted to lead the AM team');

  // an onboarding agent's open leads go to the holding queue when they leave the role
  const lead = await mkLead('salma');
  r = await call('POST', `/api/admin/users/${U.salma.id}/role`, { token: admin, body: { role: 'ACCOUNT_MANAGER', reason: 'Moved to the AM team' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.leadsHeld, 1);
  assert.equal((await prisma.ticket.findUnique({ where: { id: lead.id } })).assigneeId, null);

  // a role matched to work by market needs a market
  r = await call('POST', `/api/admin/users/${U.manager.id}/role`, { token: admin, body: { role: 'OA_AGENT', markets: [], reason: 'x' } });
  assert.equal(r.status, 400);
  r = await call('POST', `/api/admin/users/${U.manager.id}/role`, { token: admin, body: { role: 'OA_AGENT', markets: ['LY', 'IQ'], reason: 'Back on the floor' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.markets, ['LY', 'IQ']);

  // the last active Administrator keeps its role (reachable when someone holds roles.manage by elevation)
  const { changeRole } = await import('../src/auth/users.js');
  await assert.rejects(changeRole({ id: U.head.id }, U.admin.id, 'READ_ONLY', 'x'), /last active Administrator/);
  assert.equal((await prisma.user.findUnique({ where: { id: U.admin.id } })).role, 'ADMIN');
});
