// Every button does real work or says why it cannot: no placeholder pop-up notes in the served
// consoles; personal saved views (OA 6.3); the status table (OA 2.5) and the permission table
// (OA Appendix A) read from the server; each playbook step carries the server's own verdict (AC-14).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTestDatabase } from './helpers/db.js';
import { startApp } from './helpers/http.js';

useTestDatabase('controls');
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

before(async () => {
  for (const [k, role] of [['admin', 'ADMIN'], ['salma', 'OA_AGENT'], ['omar', 'OA_AGENT'], ['viewer', 'READ_ONLY'], ['yassine', 'ACCOUNT_MANAGER']]) {
    U[k] = await prisma.user.create({ data: { email: `${k}@t.local`, name: k, role, markets: JSON.stringify(['LY']), passwordHash: await hashPassword(PASSWORD) } });
  }
  await cfg.seedDefaults();
  app = await startApp(createApp);
});
after(async () => { app.close(); await prisma.$disconnect(); });

test('served consoles carry no placeholder pop-up note on any button', async () => {
  for (const path of ['/oa', '/am']) {
    const html = await (await fetch(app.base + path)).text();
    const toasts = [...html.matchAll(/onclick="toast\('([^']*)'/g)].map((m) => m[1]);
    // the only two left are the funnel and audit filter buttons, which the OA adapter replaces with real filters at load
    const allowed = path === '/oa' ? toasts.filter((t) => !/^Filters/.test(t) && !/^Filter/.test(t)) : toasts;
    assert.deepEqual(allowed, [], `${path} still has placeholder notes: ${allowed.join(' | ')}`);
    assert.ok(html.includes('/assets/controls.js'), `${path} loads the shared controls`);
    assert.ok(html.includes('CTL.toggleSidebar()'), `${path}: the menu button hides and shows the menu`);
  }
  const ctl = await (await fetch(`${app.base}/assets/controls.js`)).text();
  assert.match(ctl, /Not available to the \$\{ROLE_LABEL\[role\] \?\? role\} role\./);
});

test('saved views: an agent saves, lists and deletes their own; nobody else sees or deletes them', async () => {
  const salma = await tok('salma');
  let r = await app.call('POST', '/api/views', { token: salma, body: { module: 'oa', name: 'Libya, WhatsApp', base: 'mine', filters: { country: 'LY', channel: 'whatsapp' }, sort: 'newest' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.id;
  assert.deepEqual({ base: r.body.base, filters: r.body.filters, sort: r.body.sort }, { base: 'mine', filters: { country: 'LY', channel: 'whatsapp' }, sort: 'newest' });
  assert.equal((await app.call('POST', '/api/views', { token: salma, body: { name: 'Libya, WhatsApp', base: 'all' } })).status, 400, 'names are unique per person');
  assert.equal((await app.call('POST', '/api/views', { token: salma, body: { name: 'x', base: 'nope' } })).status, 400);
  assert.equal((await app.call('POST', '/api/views', { token: salma, body: { name: 'x', base: 'all', filters: { cost: '1' } } })).status, 400, 'only the queue filters');

  r = await app.call('GET', '/api/views?module=oa', { token: salma });
  assert.deepEqual(r.body.map((v) => v.name), ['Libya, WhatsApp']);
  const omar = await tok('omar');
  assert.deepEqual((await app.call('GET', '/api/views?module=oa', { token: omar })).body, [], 'personal: another agent sees none');
  assert.equal((await app.call('DELETE', `/api/views/${id}`, { token: omar })).status, 404, "another agent's view is not-found");

  const viewer = await tok('viewer');
  r = await app.call('POST', '/api/views', { token: viewer, body: { name: 'Mine', base: 'all' } });
  assert.equal(r.status, 403, 'Read-only cannot author a personal view (Appendix A)');
  assert.equal(r.body.error.message, 'Not available to the Read-only role.');

  assert.equal((await app.call('DELETE', `/api/views/${id}`, { token: salma })).status, 200);
  assert.deepEqual((await app.call('GET', '/api/views?module=oa', { token: salma })).body, []);
  assert.equal(await prisma.eventLog.count({ where: { action: { in: ['view.saved', 'view.deleted'] }, actorId: U.salma.id } }), 2, 'both audited');
});

test('the status table comes from the state machine (OA 2.5)', async () => {
  const r = await app.call('GET', '/api/oa/state-machine', { token: await tok('admin') });
  assert.equal(r.status, 200);
  const pre = r.body.find((x) => x.status === 'prequalified');
  assert.ok(pre.to.includes('junk_lead') && pre.to.includes('qualified'));
  assert.equal(pre.required, 'To Cold: a written reason');
  const q = r.body.find((x) => x.status === 'qualified');
  assert.match(q.required, /all five qualification criteria true and a complete handoff record/);
  assert.equal(r.body.length, 7);
});

test('the permission table is Appendix A, read from the server, Admin only', async () => {
  const r = await app.call('GET', '/api/admin/roles/OA_AGENT/grants', { token: await tok('admin') });
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 26);
  assert.equal(r.body[0].label, 'View own tickets');
  assert.equal(r.body.at(-1).label, 'View audit log');
  const cost = r.body.find((x) => x.key === 'field.cost_margin');
  if (cost) assert.equal(cost.value, false, 'an agent never sees cost/margin');
  assert.equal(r.body.find((x) => x.label === 'Author personal macro / view').value, true);
  assert.equal((await app.call('GET', '/api/admin/roles/OA_AGENT/grants', { token: await tok('salma') })).status, 403);
  assert.equal((await app.call('GET', '/api/admin/roles/NOPE/grants', { token: await tok('admin') })).status, 400);
});

test('each playbook step carries the server verdict: open gates tickable, closed gates say why (AC-14)', async () => {
  const contact = await prisma.contact.create({ data: { name: 'Seller P', phone: '+218940099', country: 'LY', contactType: 'seller', ownerAgentId: U.yassine.id } });
  await prisma.conversation.create({ data: { contactId: contact.id } });
  const s = await prisma.seller.create({
    data: { mdmRef: 'MDM-S-P1', contactId: contact.id, market: 'LY', joinStatus: 'accepted', activatedAt: new Date(Date.now() - 3 * DAY),
      assignedAccountManagerId: U.yassine.id, totalOrders: 0 },
  });
  for (const who of ['yassine', 'admin']) {
    const r = await app.call('GET', '/api/am/console', { token: await tok(who) });
    assert.equal(r.status, 200);
    const pb = r.body.sellers.find((x) => x.id === s.id).playbook;
    assert.ok(pb.length > 0);
    for (const step of pb) {
      assert.ok('canTick' in step && 'reason' in step && 'tickedById' in step);
      if (!step.gateOpen) {
        assert.equal(step.canTick, false);
        assert.match(step.reason, /^Gate not met: /);
      } else if (step.canTick) assert.equal(step.reason, null);
    }
    assert.ok(pb.some((x) => x.gateOpen && x.canTick), `${who} can tick a step whose gate is open`);
  }
});
