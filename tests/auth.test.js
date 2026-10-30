// Step 3 — authentication, the permission matrix, elevation and server-side scope.
// OA Part 9 / Appendix A, AM Part 9 / Appendix A, AC-20, AC-OA-4.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTestDatabase } from './helpers/db.js';

useTestDatabase('auth');
process.env.JWT_SECRET = 'test-secret';
const { prisma } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const { seedDefaults } = await import('../src/config/service.js');
const { hashPassword } = await import('../src/auth/service.js');
const { grant, redact, MATRIX, ROLES } = await import('../src/auth/permissions.js');
const scope = await import('../src/auth/scope.js');
const { expireElevations } = await import('../src/auth/elevation.js');

const PASSWORD = 'pw-123456';
const U = {};
let server, base;

async function mkUser(key, role, extra = {}) {
  U[key] = await prisma.user.create({
    data: { email: `${key}@t.local`, name: key, role, passwordHash: await hashPassword(PASSWORD), ...extra },
  });
}

async function call(method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const tokens = {};
async function tokenFor(key) {
  if (!tokens[key]) {
    const r = await call('POST', '/api/auth/login', { body: { email: `${key}@t.local`, password: PASSWORD } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    tokens[key] = r.body.token;
  }
  return tokens[key];
}

before(async () => {
  await seedDefaults();
  await mkUser('admin', 'ADMIN');
  await mkUser('manager', 'MANAGER');
  await mkUser('lead', 'SHIFT_LEAD');
  await mkUser('salma', 'OA_AGENT');
  await mkUser('karim', 'OA_AGENT');
  await mkUser('yassine', 'ACCOUNT_MANAGER');
  await mkUser('rania', 'ACCOUNT_MANAGER');
  await mkUser('viewer', 'READ_ONLY');
  await mkUser('gone', 'OA_AGENT', { active: false });
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  await prisma.$disconnect();
});

// ───────────── authentication ─────────────

test('login returns a token and the principal; /me returns every grant', async () => {
  const r = await call('POST', '/api/auth/login', { body: { email: 'SALMA@t.local ', password: PASSWORD } });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.role, 'OA_AGENT');
  assert.equal(r.body.user.passwordHash, undefined);
  const me = await call('GET', '/api/auth/me', { token: r.body.token });
  assert.equal(me.status, 200);
  assert.equal(me.body.grants['onboarding.view_all'], 'team');
  assert.equal(me.body.grants['onboarding.edit'], 'own');
  assert.deepEqual(Object.keys(me.body.grants).sort(), Object.keys(MATRIX).sort());
});

test('wrong password, unknown email and inactive account all get the same 401', async () => {
  const msgs = new Set();
  for (const body of [
    { email: 'salma@t.local', password: 'nope' },
    { email: 'nobody@t.local', password: PASSWORD },
    { email: 'gone@t.local', password: PASSWORD },
  ]) {
    const r = await call('POST', '/api/auth/login', { body });
    assert.equal(r.status, 401);
    msgs.add(r.body.error.message);
  }
  assert.equal(msgs.size, 1);
});

test('missing or forged token is 401; deactivation takes effect on the next request', async () => {
  assert.equal((await call('GET', '/api/auth/me')).status, 401);
  assert.equal((await call('GET', '/api/auth/me', { token: 'x.y.z' })).status, 401);
  await mkUser('temp', 'OA_AGENT');
  const t = await tokenFor('temp');
  assert.equal((await call('GET', '/api/auth/me', { token: t })).status, 200);
  await prisma.user.update({ where: { id: U.temp.id }, data: { active: false } });
  assert.equal((await call('GET', '/api/auth/me', { token: t })).status, 401);
});

// ───────────── permission matrix ─────────────

test('AC-OA-4: no role can pick or claim a lead; an agent may only request a transfer', () => {
  assert.equal(grant('OA_AGENT', 'onboarding.reassign'), 'request');
  assert.ok(!Object.keys(MATRIX).some((p) => /claim|self_assign|pick/.test(p)));
});

test('matrix rows that are easy to get wrong (OA 9.4, AM Appendix A)', () => {
  // read is team-wide, write is own-only — two separate grants
  assert.equal(grant('OA_AGENT', 'onboarding.view_all'), 'team');
  assert.equal(grant('OA_AGENT', 'onboarding.edit'), 'own');
  assert.equal(grant('OA_AGENT', 'onboarding.activate'), 'own_gated');
  assert.equal(grant('OA_AGENT', 'onboarding.bulk_outbound'), false);
  assert.equal(grant('OA_AGENT', 'finance.view_cost'), false);
  // AM: own book only, never configuration, never reassignment
  assert.equal(grant('ACCOUNT_MANAGER', 'seller.view'), 'own_book');
  assert.equal(grant('ACCOUNT_MANAGER', 'seller.assign_am'), false);
  assert.equal(grant('ADMIN', 'am.reply'), 'take_over');
  // onboarding roles have no access to the AM module
  for (const r of ['OA_AGENT', 'SHIFT_LEAD', 'MANAGER', 'READ_ONLY']) assert.equal(grant(r, 'seller.view'), false);
  // every row defines every role
  for (const row of Object.values(MATRIX)) assert.deepEqual(Object.keys(row).sort(), [...ROLES].sort());
});

test('cost / fee / margin / settlement fields are absent for agents, with a withheld marker', () => {
  const rec = { id: 't1', name: 'Shop', platformFee: 12, margin: 0.3, nested: { settlementDate: 'x', ok: 1 }, list: [{ cost: 5, a: 1 }] };
  const agent = redact(rec, 'OA_AGENT');
  assert.deepEqual(agent, { id: 't1', name: 'Shop', nested: { ok: 1, withheld: ['settlementDate'] }, list: [{ a: 1, withheld: ['cost'] }], withheld: ['platformFee', 'margin'] });
  assert.equal(redact(rec, 'MANAGER'), rec);
  assert.equal(redact(rec, 'ACCOUNT_MANAGER'), rec);
});

// ───────────── onboarding scope ─────────────

test('onboarding: agents read every team ticket but act only on their own, with the reason', async () => {
  const c1 = await prisma.contact.create({ data: { name: 'M1', phone: '+218900000101', country: 'LY' } });
  const c2 = await prisma.contact.create({ data: { name: 'M2', phone: '+218900000102', country: 'LY', ownerAgentId: U.yassine.id } });
  const mine = await prisma.ticket.create({ data: { type: 'onboarding_task', contactId: c1.id, assigneeId: U.salma.id, status: 'new' } });
  const theirs = await prisma.ticket.create({ data: { type: 'onboarding_task', contactId: c2.id, assigneeId: U.karim.id, status: 'activated' } });

  const salma = { id: U.salma.id, role: 'OA_AGENT' };
  const readable = await prisma.ticket.findMany({ where: scope.onboardingReadWhere(salma) });
  assert.equal(readable.length, 2);

  assert.equal(scope.onboardingCan(salma, mine, 'onboarding.edit').allowed, true);
  const edit = scope.onboardingCan(salma, theirs, 'onboarding.edit');
  assert.deepEqual([edit.allowed, edit.reason], [false, 'Lead not assigned to you.']);
  assert.equal(scope.onboardingCan(salma, theirs, 'onboarding.note').allowed, true);
  assert.equal(scope.onboardingCan(salma, theirs, 'onboarding.reply').allowed, false);
  assert.match(scope.onboardingCan(salma, mine, 'onboarding.reassign').reason, /request a transfer/);
  assert.equal(scope.onboardingCan(salma, mine, 'onboarding.activate').gated, true);

  // an AM reads only the onboarding history of contacts they own
  const am = { id: U.yassine.id, role: 'ACCOUNT_MANAGER' };
  const amRead = await prisma.ticket.findMany({ where: scope.onboardingReadWhere(am) });
  assert.deepEqual(amRead.map((t) => t.id), [theirs.id]);
  await assert.rejects(scope.findOnboardingTicket(am, mine.id), { status: 404 });
});

// ───────────── AM scope — AC-20 ─────────────

test('AC-20: a seller outside the caller\'s book is not-found, identical to a nonexistent one', async () => {
  const mk = async (n, amId) => {
    const c = await prisma.contact.create({ data: { name: `S${n}`, phone: `+21890000020${n}`, country: 'LY', contactType: 'seller' } });
    return prisma.seller.create({ data: { mdmRef: `MDM-S-T${n}`, contactId: c.id, market: 'LY', assignedAccountManagerId: amId } });
  };
  const own = await mk(1, U.yassine.id);
  const foreign = await mk(2, U.rania.id);
  const yassine = { id: U.yassine.id, role: 'ACCOUNT_MANAGER' };

  assert.equal((await scope.findSellerInScope(yassine, own.id)).id, own.id);
  const errForeign = await scope.findSellerInScope(yassine, foreign.id).catch((e) => e);
  const errMissing = await scope.findSellerInScope(yassine, 'does-not-exist').catch((e) => e);
  assert.equal(errForeign.status, 404);
  assert.deepEqual([errForeign.status, errForeign.message], [errMissing.status, errMissing.message]);

  const listed = await prisma.seller.findMany({ where: scope.sellerWhere(yassine) });
  assert.deepEqual(listed.map((s) => s.id), [own.id]);

  // Admin is unaffected; onboarding roles have no AM access at all
  assert.equal((await scope.findSellerInScope({ id: U.admin.id, role: 'ADMIN' }, foreign.id)).id, foreign.id);
  await assert.rejects(scope.findSellerInScope({ id: U.manager.id, role: 'MANAGER' }, own.id), { status: 404 });

  // am_task scope follows the book
  await prisma.ticket.create({ data: { type: 'am_task', contactId: own.contactId, sellerId: own.id, status: 'open', why: 'test' } });
  await prisma.ticket.create({ data: { type: 'am_task', contactId: foreign.contactId, sellerId: foreign.id, status: 'open', why: 'test' } });
  const tasks = await prisma.ticket.findMany({ where: scope.amTaskWhere(yassine) });
  assert.deepEqual(tasks.map((t) => t.sellerId), [own.id]);
  assert.equal(scope.amTaskWhere({ id: U.salma.id, role: 'OA_AGENT' }), null);
});

// ───────────── configuration over HTTP ─────────────

test('config: everyone reads live values; only owners change them (Appendix D owner column)', async () => {
  const agent = await tokenFor('salma');
  const live = await call('GET', '/api/config', { token: agent });
  assert.equal(live.status, 200);
  assert.equal(live.body.values['oa.no_answer_max'], 5);
  assert.equal((await call('PATCH', '/api/config/draft', { token: agent, body: { changes: { 'oa.no_answer_max': 4 } } })).status, 403);
  assert.equal((await call('PATCH', '/api/config/draft', { token: await tokenFor('yassine'), body: { changes: { 'am.maxBook': 40 } } })).status, 403);

  const mgr = await tokenFor('manager');
  assert.equal((await call('PATCH', '/api/config/draft', { token: mgr, body: { changes: { 'am.maxBook': 40 } } })).status, 403);
  const d = await call('PATCH', '/api/config/draft', { token: mgr, body: { changes: { 'oa.no_answer_max': 4 } } });
  assert.equal(d.status, 200);
  const sim = await call('POST', '/api/config/simulate', { token: mgr });
  assert.equal(sim.body.publishable, true);
  const pub = await call('POST', '/api/config/publish', { token: mgr, body: { note: 'four attempts' } });
  assert.equal(pub.status, 200);
  assert.equal(pub.body.version, 2);
  const v = await call('GET', '/api/config/versions/2', { token: mgr });
  assert.equal(v.body.authorId, U.manager.id);

  const admin = await tokenFor('admin');
  await call('PATCH', '/api/config/draft', { token: admin, body: { changes: { 'am.wActivity': 40 } } });
  const refused = await call('POST', '/api/config/publish', { token: admin });
  assert.equal(refused.status, 422);
  assert.match(refused.body.error.message, /total 110/);
  await call('DELETE', '/api/config/draft', { token: admin });
  const rb = await call('POST', '/api/config/rollback', { token: admin, body: { targetVersion: 1 } });
  assert.equal(rb.status, 200);
  assert.equal((await call('GET', '/api/config', { token: agent })).body.values['oa.no_answer_max'], 5);
});

// ───────────── audit view ─────────────

test('audit trail: Manager, Admin and Read-only may read it; agents and AMs may not; no write route', async () => {
  for (const [k, status] of [['viewer', 200], ['manager', 200], ['admin', 200], ['salma', 403], ['yassine', 403]]) {
    assert.equal((await call('GET', '/api/admin/audit', { token: await tokenFor(k) })).status, status, k);
  }
  const rows = (await call('GET', '/api/admin/audit?entityType=config', { token: await tokenFor('admin') })).body;
  assert.ok(rows.some((r) => r.action === 'config.publish'));
  assert.equal((await call('DELETE', '/api/admin/audit', { token: await tokenFor('admin') })).status, 404);
  const denied = await call('GET', '/api/admin/audit', { token: await tokenFor('salma') });
  assert.equal(denied.body.error.message, 'Not available to the Onboarding Agent role.');
});

// ───────────── temporary elevation (OA 9.3) ─────────────

test('elevation: Admin-only, reason required, time-bound, effective immediately, expiry audited', async () => {
  const admin = await tokenFor('admin');
  const endsAt = new Date(Date.now() + 3_600_000).toISOString();
  assert.equal((await call('POST', '/api/admin/elevations', { token: await tokenFor('manager'), body: { userId: U.karim.id, role: 'SHIFT_LEAD', endsAt, reason: 'leave' } })).status, 403);
  assert.equal((await call('POST', '/api/admin/elevations', { token: admin, body: { userId: U.karim.id, role: 'SHIFT_LEAD', endsAt } })).status, 400);
  const farFuture = new Date(Date.now() + 60 * 86_400_000).toISOString();
  assert.equal((await call('POST', '/api/admin/elevations', { token: admin, body: { userId: U.karim.id, role: 'SHIFT_LEAD', endsAt: farFuture, reason: 'x' } })).status, 400);

  const g = await call('POST', '/api/admin/elevations', { token: admin, body: { userId: U.karim.id, role: 'SHIFT_LEAD', endsAt, reason: 'Covering shift lead leave' } });
  assert.equal(g.status, 201);
  const karim = await tokenFor('karim');
  let me = await call('GET', '/api/auth/me', { token: karim });
  assert.deepEqual([me.body.user.baseRole, me.body.user.role], ['OA_AGENT', 'SHIFT_LEAD']);
  assert.equal(me.body.grants['onboarding.reassign'], true);

  // force the window closed: the role reverts at once, and the sweep audits the reversion once
  await prisma.roleElevation.update({ where: { id: g.body.id }, data: { endsAt: new Date(Date.now() - 1000) } });
  me = await call('GET', '/api/auth/me', { token: karim });
  assert.equal(me.body.user.role, 'OA_AGENT');
  assert.equal(await expireElevations(), 1);
  assert.equal(await expireElevations(), 0);
  const actions = (await prisma.eventLog.findMany({ where: { entityType: 'user', entityId: U.karim.id } })).map((e) => e.action);
  assert.deepEqual(actions.sort(), ['user.elevation_expired', 'user.elevation_granted']);
});

test('unknown API routes and bad JSON get JSON errors', async () => {
  assert.equal((await call('GET', '/api/nope', { token: await tokenFor('admin') })).status, 404);
  assert.equal((await call('GET', '/api/nope')).status, 401);
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
  assert.equal(res.status, 400);
});
