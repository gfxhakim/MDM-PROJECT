// Integrations page controls asked by the client on 4 Nov 2026: a date range for what the MDM sync
// brings in (sellers and people), Stop sync (stops the run in progress, pauses the automatic sync
// until Resume), and Delete all data (behind a reason and the number of merchants typed).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTestDatabase } from './helpers/db.js';
import { startApp } from './helpers/http.js';
import { fakeMdm, mdmSeller, mdmUser } from './helpers/fake-mdm.js';

useTestDatabase('mdm-control');
process.env.JWT_SECRET = 'test-secret';
for (const k of ['OPTIONAL_INTEGRATIONS', 'MDM_API_KEY', 'MDM_API_URL', 'MDM_WRITEBACK', 'MDM_PAYMENT_PASSWORD', 'MDM_LEAD_MAX_AGE_DAYS']) delete process.env[k];
const { prisma } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const cfg = await import('../src/config/service.js');
const { hashPassword } = await import('../src/auth/service.js');
const { syncSellers } = await import('../src/integrations/mdm.js');
const ctl = await import('../src/integrations/mdm-control.js');
const { deleteAllData, deleteRecords, listDeleted, restoreDeleted } = await import('../src/core/deletion.js');
const { onboardingBudget } = await import('../src/core/templates.js');
const { onboardingAnalytics } = await import('../src/oa/analytics.js');

const PASSWORD = 'pw-123456';
const U = {};
let app;
const tok = (k) => app.login(`${k}@t.local`, PASSWORD);
const DAY = 86_400_000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();
const sync = async (opts) => { process.env.MDM_API_KEY = 'k'; try { return await syncSellers(opts); } finally { delete process.env.MDM_API_KEY; } };

before(async () => {
  for (const [k, role] of [['admin', 'ADMIN'], ['salma', 'OA_AGENT'], ['yassine', 'ACCOUNT_MANAGER'], ['head', 'HEAD_OF_AM']]) {
    U[k] = await prisma.user.create({ data: { email: `${k}@t.local`, name: k, role, markets: JSON.stringify(['LY']), passwordHash: await hashPassword(PASSWORD) } });
  }
  await cfg.seedDefaults();
  await prisma.template.upsert({ where: { key: 'oa_intro_v2' }, update: {}, create: { key: 'oa_intro_v2', module: 'oa', bodyEn: 'Salam {{1}}', status: 'approved' } });
  app = await startApp(createApp);
});
beforeEach(async () => {
  for (const m of ['notification', 'eventLog', 'message', 'healthHistory', 'playbookProgress', 'ticket', 'seller', 'conversation', 'contact', 'integrationRun',
    'mdmSkipped', 'mdmStaff', 'mdmRecord', 'deletedMerchant', 'appSetting']) await prisma[m].deleteMany();
  await prisma.user.deleteMany({ where: { NOT: { email: { endsWith: '@t.local' } } } });
  ctl.clearStop();
});
after(async () => { app.close(); await prisma.$disconnect(); });

test('ranges: validated, saved with one audit entry; only a new sellers range makes the next run a full one', async () => {
  const bad = [
    [{ sellers: { mode: 'yesterday' } }, /choose all, recent, old or custom/],
    [{ sellers: { mode: 'recent', days: 0 } }, /between 1 and 3650/],
    [{ sellers: { mode: 'old' } }, /registered before/],
    [{ people: { mode: 'custom' } }, /start date, an end date, or both/],
    [{ people: { mode: 'custom', from: '2026-10-10', to: '2026-10-01' } }, /after its end/],
    [{ sellers: { mode: 'old', before: 'soon' } }, /not a date/],
    [{ sellers: { mode: 'old', before: '0002-03-15' } }, /between the years 2000 and 2100/], // a year typed only in part
    [{ people: { mode: 'custom', from: '2026-01-01', to: '20255-01-01' } }, /between the years 2000 and 2100|not a date/],
  ];
  const admin = await tok('admin');
  for (const [body, re] of bad) {
    const r = await app.call('POST', '/api/integrations/mdm/range', { token: admin, body });
    assert.equal(r.status, 400, JSON.stringify(body)); assert.match(r.body.error.message, re);
  }
  for (const who of ['salma', 'yassine', 'head']) assert.equal((await app.call('POST', '/api/integrations/mdm/range', { token: await tok(who), body: { sellers: { mode: 'all' } } })).status, 403, who);

  const p = await app.call('POST', '/api/integrations/mdm/range', { token: admin, body: { people: { mode: 'recent', days: 30 } } });
  assert.equal(p.status, 200); assert.equal(p.body.fullNextRun, false, 'people are read in full on every run');
  assert.equal(p.body.fullFrom, null);
  const s = await app.call('POST', '/api/integrations/mdm/range', { token: admin, body: { sellers: { mode: 'custom', from: '2026-09-01T00:00:00.000Z', to: '2026-10-31T23:59:59.999Z' } } });
  assert.equal(s.body.fullNextRun, true); assert.ok(s.body.fullFrom);
  assert.deepEqual(s.body.people, { mode: 'recent', days: 30 }, 'the people range is kept');
  const again = await app.call('POST', '/api/integrations/mdm/range', { token: admin, body: { sellers: s.body.sellers } });
  assert.equal(again.body.changed, false);
  const audit = await prisma.eventLog.findMany({ where: { action: 'mdm.sync_range_changed' }, orderBy: { createdAt: 'asc' } });
  assert.equal(audit.length, 2);
  assert.deepEqual(JSON.parse(audit[1].after).sellers, s.body.sellers);
  assert.equal(audit[1].actorId, U.admin.id);

  const st = await app.call('GET', '/api/integrations/status', { token: admin });
  assert.deepEqual(st.body.mdm.sync.sellers, s.body.sellers);
  assert.equal(st.body.mdm.sync.fullNext, true);

  // the bounds: recent counts back from now, old is strictly before its day, custom includes both ends
  const now = new Date('2026-11-04T12:00:00Z');
  assert.equal(ctl.inRange('2026-10-10T00:00:00Z', { mode: 'recent', days: 30 }, now), true);
  assert.equal(ctl.inRange('2026-09-01T00:00:00Z', { mode: 'recent', days: 30 }, now), false);
  assert.equal(ctl.inRange('2026-08-31T23:59:59Z', { mode: 'old', before: '2026-09-01T00:00:00Z' }, now), true);
  assert.equal(ctl.inRange('2026-09-01T00:00:00Z', { mode: 'old', before: '2026-09-01T00:00:00Z' }, now), false);
  assert.equal(ctl.inRange('2026-10-31T23:59:59.999Z', { mode: 'custom', from: '2026-09-01T00:00:00Z', to: '2026-10-31T23:59:59.999Z' }, now), true);
  assert.equal(ctl.inRange(null, { mode: 'recent', days: 30 }, now), false, 'no date on MDM: only "all" brings it in');
  assert.equal(ctl.inRange(null, { mode: 'all' }, now), true);
});

test('sellers range: new sellers outside it are not brought in or kept aside; one already here is still updated; a new range reads MDM again', async () => {
  // a seller already in a book, registered on MDM long ago
  const oldSeller = mdmSeller('S-OLD-HERE', '+218915550001', { joinStatus: 'accepted', createdAt: ago(500), updatedAt: ago(5) });
  let r = await sync({ full: true, fetchImpl: fakeMdm({ sellers: [oldSeller], orders: { 'S-OLD-HERE': 3 } }).fetchImpl });
  assert.equal(r.sellersCreated, 1);
  assert.equal((await prisma.seller.findUnique({ where: { mdmRef: 'S-OLD-HERE' } })).totalOrders, 3);

  await ctl.saveRanges(U.admin, { sellers: { mode: 'recent', days: 30 } });
  const mdm = fakeMdm({
    sellers: [
      { ...oldSeller, updatedAt: ago(1) },
      mdmSeller('S-NEW', '+218915550002', { createdAt: ago(3), updatedAt: ago(2) }), // registered 3 days ago, still joining
      mdmSeller('S-OLD-NEW', '+218915550003', { createdAt: ago(400), updatedAt: ago(3) }), // registered long ago, not here
      mdmSeller('S-OLD-ACC', '+218915550004', { joinStatus: 'accepted', createdAt: ago(400), updatedAt: ago(4) }),
      mdmSeller('S-NODATE', '+218915550005', { createdAt: null, updatedAt: ago(4) }),
    ],
    orders: { 'S-OLD-HERE': 7, 'S-OLD-ACC': 2 },
  });
  r = await sync({ fetchImpl: mdm.fetchImpl }); // no "full" flag: the new range makes it one
  assert.equal(r.full, true);
  assert.deepEqual(r.range.sellers, { mode: 'recent', days: 30 });
  assert.equal(r.outOfRange.sellers, 3);
  assert.equal(r.leadsCreated, 1); assert.equal(r.sellersCreated, 0); assert.equal(r.updated, 1);
  assert.equal((await prisma.seller.findUnique({ where: { mdmRef: 'S-OLD-HERE' } })).totalOrders, 7, 'already here: updated whatever the range');
  assert.ok(await prisma.contact.findFirst({ where: { mdmRef: 'S-NEW' } }));
  for (const ref of ['S-OLD-NEW', 'S-OLD-ACC', 'S-NODATE']) {
    assert.equal(await prisma.contact.count({ where: { mdmRef: ref } }), 0, ref);
    assert.equal(await prisma.mdmSkipped.count({ where: { mdmRef: ref } }), 0, `${ref} is not kept aside`);
    assert.equal(await prisma.mdmRecord.count({ where: { kind: 'seller', mdmRef: ref } }), 0, `${ref}: nothing recorded`);
  }
  // no metrics were read for sellers left outside the range
  assert.ok(!mdm.calls.some((c) => c.path === '/api/v2/orders/search' && c.body?.filters?.sellerId?.[0] === 'S-OLD-ACC'));
  assert.equal((await prisma.eventLog.findFirst({ where: { action: 'mdm.sync' }, orderBy: { createdAt: 'desc' } })).after.includes('"outOfRange":{"sellers":3'), true);

  // the next run is incremental again
  r = await sync({ fetchImpl: mdm.fetchImpl });
  assert.equal(r.full, false);

  // old ones only: the accepted one comes in as a seller; the old registration never accepted is kept aside as stale (as before)
  await ctl.saveRanges(U.admin, { sellers: { mode: 'old', before: ago(100) } });
  r = await sync({ fetchImpl: mdm.fetchImpl });
  assert.equal(r.full, true);
  assert.equal(r.sellersCreated, 1);
  assert.ok(await prisma.seller.findUnique({ where: { mdmRef: 'S-OLD-ACC' } }));
  assert.equal((await prisma.mdmSkipped.findFirst({ where: { mdmRef: 'S-OLD-NEW' } }))?.reasonCode, 'stale');
  assert.equal(r.outOfRange.sellers, 1, 'S-NODATE has no registration date on MDM');
});

test('people range: someone new created on MDM outside it is not listed; people already listed, or with an account here, are kept up to date', async () => {
  const listed = mdmUser('U-LISTED', 'listed@mdm.express', { createdAt: '2024-01-01T00:00:00Z' });
  await sync({ full: true, fetchImpl: fakeMdm({ users: [listed] }).fetchImpl });
  assert.equal(await prisma.mdmStaff.count(), 1);
  await ctl.saveRanges(U.admin, { people: { mode: 'recent', days: 30 } });
  const r = await sync({ fetchImpl: fakeMdm({ users: [
    { ...listed, restricted: true },
    mdmUser('U-NEW', 'new@mdm.express', { createdAt: ago(10) }),
    mdmUser('U-OLD', 'old@mdm.express', { createdAt: '2023-05-01T00:00:00Z' }),
    mdmUser('U-ACCOUNT', 'salma@t.local', { createdAt: '2023-05-01T00:00:00Z' }), // the same email as an account here
  ] }).fetchImpl });
  assert.equal(r.full, false, 'a new people range does not need a full read: people are read in full every run');
  assert.equal(r.outOfRange.people, 1);
  assert.deepEqual((await prisma.mdmStaff.findMany({ orderBy: { mdmRef: 'asc' } })).map((x) => x.mdmRef), ['U-ACCOUNT', 'U-LISTED', 'U-NEW']);
  assert.equal((await prisma.mdmStaff.findUnique({ where: { mdmRef: 'U-LISTED' } })).restricted, true, 'already listed: updated');
  assert.equal((await prisma.mdmStaff.findUnique({ where: { mdmRef: 'U-ACCOUNT' } })).userId, U.salma.id, 'linked to the account here');
  assert.equal(await prisma.mdmRecord.count({ where: { kind: 'user', mdmRef: 'U-OLD' } }), 0);
});

test('Stop sync: the run stops before its next seller, is recorded as stopped with who pressed it, and the next run starts from the last completed one', async () => {
  const base = await sync({ full: true, fetchImpl: fakeMdm({}).fetchImpl });
  assert.equal(base.full, true);
  const t = Date.now();
  const sellers = [1, 2, 3, 4].map((i) => mdmSeller(`S-${i}`, `+21891556000${i}`, { joinStatus: 'accepted', createdAt: ago(10), updatedAt: new Date(t + (10 - i) * 1000).toISOString() }));
  const mdm = fakeMdm({ sellers, orders: { 'S-1': 1, 'S-2': 1, 'S-3': 1, 'S-4': 1 } });
  const fetchImpl = async (url, opts) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (new URL(url).pathname === '/api/v2/orders/search' && body?.filters?.sellerId?.[0] === 'S-2' && !ctl.stopRequest()) ctl.requestStop({ id: U.admin.id, name: 'admin' });
    return mdm.fetchImpl(url, opts);
  };
  const stopped = await sync({ full: true, fetchImpl });
  assert.equal(stopped.sellersCreated, 2, 'the seller being read when Stop was pressed is finished; the next is not started');
  assert.equal(stopped.stopped.by, 'admin');
  const run = await prisma.integrationRun.findFirst({ where: { kind: 'mdm_sync' }, orderBy: { startedAt: 'desc' } });
  assert.equal(run.status, 'stopped'); assert.ok(run.finishedAt);
  const log = await prisma.eventLog.findFirst({ where: { action: 'mdm.sync_stopped' } });
  assert.equal(log.actorId, U.admin.id); assert.equal(JSON.parse(log.after).runId, run.id);
  assert.equal(ctl.stopRequest(), null, 'the request ends with the run');
  // the stopped run is never the base of the next one: S-3 and S-4 changed after the last completed run and come in now
  const next = await sync({ fetchImpl: mdm.fetchImpl });
  assert.equal(next.full, false);
  assert.equal(next.sellersCreated, 2);
  assert.equal(await prisma.seller.count(), 4);
});

test('sellers range: the stores of sellers left out by the range are not recorded; stores of sellers brought in, or already here, are', async () => {
  const here = mdmSeller('S-HERE', '+218915550011', { joinStatus: 'accepted', createdAt: ago(500), updatedAt: ago(9) });
  await sync({ full: true, fetchImpl: fakeMdm({ sellers: [here] }).fetchImpl });
  await prisma.mdmRecord.deleteMany(); // only the stores of the next run are looked at
  await ctl.saveRanges(U.admin, { sellers: { mode: 'recent', days: 30 } });
  const store = (id, seller, d) => ({ trackingId: id, name: id, seller: seller ? { trackingId: seller } : null, updatedAt: ago(d) });
  const r = await sync({ fetchImpl: fakeMdm({
    sellers: [here, mdmSeller('S-NEW', '+218915550012', { createdAt: ago(3), updatedAt: ago(2) }), mdmSeller('S-OLD', '+218915550013', { createdAt: ago(400), updatedAt: ago(2) })],
    stores: [store('ST-NEW', 'S-NEW', 1), store('ST-OLD', 'S-OLD', 1), store('ST-HERE', 'S-HERE', 1), store('ST-NONE', null, 1)],
  }).fetchImpl });
  assert.equal(r.full, true);
  assert.equal(r.outOfRange.sellers, 1);
  assert.deepEqual((await prisma.mdmRecord.findMany({ where: { kind: 'store' }, orderBy: { mdmRef: 'asc' } })).map((x) => x.mdmRef), ['ST-HERE', 'ST-NEW']);
  assert.equal(r.records.stores, 2); assert.equal(r.outOfRange.stores, 2, 'the old seller\'s store and the store with no seller');
  // every seller: every store, as before
  await ctl.saveRanges(U.admin, { sellers: { mode: 'all' } });
  const all = await sync({ fetchImpl: fakeMdm({ sellers: [], stores: [store('ST-OLD', 'S-OLD', 1), store('ST-NONE', null, 1)] }).fetchImpl });
  assert.equal(all.records.stores, 2); assert.equal(all.outOfRange.stores, 0);
});

test('Stop sync acts during the scan of changed orders too, even when none of those sellers is here', async () => {
  await sync({ full: true, fetchImpl: fakeMdm({}).fetchImpl });
  const orders = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`S-ELSEWHERE-${i}`, 1]));
  const mdm = fakeMdm({ orders });
  const fetchImpl = async (url, opts) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (new URL(url).pathname === '/api/v2/orders/search' && body?.filters?.updatedAt && !ctl.stopRequest()) ctl.requestStop({ id: U.admin.id, name: 'admin' });
    return mdm.fetchImpl(url, opts);
  };
  const r = await sync({ fetchImpl });
  assert.equal(r.full, false);
  assert.equal(r.stopped?.by, 'admin');
  assert.equal((await prisma.integrationRun.findFirst({ where: { kind: 'mdm_sync' }, orderBy: { startedAt: 'desc' } })).status, 'stopped', 'not recorded as completed');
});

test('After Delete all data, a person imported earlier is linked again to the same account by their MDM id, even with a new email and outside the people range', async () => {
  const alice = await prisma.user.create({ data: { email: 'alice@old.example', name: 'Alice', role: 'OA_AGENT', markets: JSON.stringify(['LY']), mdmRef: 'U-ALICE', active: true, passwordHash: await hashPassword(PASSWORD) } });
  await ctl.saveRanges(U.admin, { people: { mode: 'recent', days: 30 } });
  const r = await sync({ fetchImpl: fakeMdm({ users: [mdmUser('U-ALICE', 'alice@new.example', { createdAt: '2023-01-01T00:00:00Z', restricted: true })] }).fetchImpl });
  assert.equal(r.outOfRange.people, 0, 'an account here tied to them: always kept up to date');
  const row = await prisma.mdmStaff.findUnique({ where: { mdmRef: 'U-ALICE' } });
  assert.equal(row.userId, alice.id); assert.equal(row.decision, 'imported');
  assert.equal((await prisma.user.findUnique({ where: { id: alice.id } })).active, false, 'a restriction on MDM reaches the account again');
  assert.equal(await prisma.user.count({ where: { mdmRef: 'U-ALICE' } }), 1, 'no second account');
});

test('Stop sync pauses the automatic sync until Resume; Sync now still runs once while paused', async () => {
  const admin = await tok('admin');
  assert.equal((await app.call('POST', '/api/integrations/mdm/stop', { token: await tok('salma') })).status, 403);
  const r = await app.call('POST', '/api/integrations/mdm/stop', { token: admin });
  assert.equal(r.status, 200); assert.deepEqual(r.body, { stopping: false, paused: true });
  let st = (await app.call('GET', '/api/integrations/status', { token: admin })).body.mdm;
  assert.equal(st.sync.paused, true); assert.equal(st.sync.pausedBy, 'admin'); assert.equal(st.running, false);
  await assert.rejects(sync({ automatic: true, fetchImpl: fakeMdm({}).fetchImpl }), (e) => e.code === 'sync_paused');
  assert.equal(await prisma.integrationRun.count(), 0, 'nothing ran');
  const manual = await sync({ fetchImpl: fakeMdm({}).fetchImpl });
  assert.equal(manual.errorCount, 0);
  assert.equal((await ctl.getSyncSettings()).paused, true, 'a manual run leaves the pause on');
  assert.equal((await app.call('POST', '/api/integrations/mdm/resume', { token: admin })).status, 200);
  st = (await app.call('GET', '/api/integrations/status', { token: admin })).body.mdm;
  assert.equal(st.sync.paused, false);
  await sync({ automatic: true, fetchImpl: fakeMdm({}).fetchImpl });
  assert.deepEqual((await prisma.eventLog.findMany({ where: { action: { in: ['mdm.sync_paused', 'mdm.sync_resumed'] } }, orderBy: { createdAt: 'asc' } })).map((e) => e.action), ['mdm.sync_paused', 'mdm.sync_resumed']);
});

let n = 0;
async function merchant({ seller = false, sends = 0, mdmRef = null } = {}) {
  n++;
  const c = await prisma.contact.create({ data: { name: `M ${n}`, phone: `+21891999${String(n).padStart(4, '0')}`, country: 'LY', mdmRef } });
  const conv = await prisma.conversation.create({ data: { contactId: c.id } });
  await prisma.message.create({ data: { conversationId: conv.id, direction: 'in', body: 'hello' } });
  for (let i = 0; i < sends; i++) await prisma.message.create({ data: { conversationId: conv.id, direction: 'out', kind: 'template', templateKey: 'oa_intro_v2', body: 'Salam', billable: true } });
  const t = await prisma.ticket.create({ data: { type: 'onboarding_task', contactId: c.id, assigneeId: U.salma.id, status: 'prequalified', stage: 'first_contact', dueAt: new Date(Date.now() + DAY) } });
  await prisma.notification.create({ data: { userId: U.salma.id, kind: 'x', title: 'x', ticketId: t.id } });
  if (seller) {
    const s = await prisma.seller.create({ data: { mdmRef: mdmRef ?? `LOCAL-${n}`, contactId: c.id, market: 'LY', joinStatus: 'accepted', activatedAt: new Date(), assignedAccountManagerId: U.yassine.id } });
    await prisma.healthHistory.create({ data: { sellerId: s.id, date: new Date(), score: 60, band: 'healthy', components: '{}' } });
    await prisma.playbookProgress.create({ data: { sellerId: s.id, stepDay: 0, tickedAt: new Date() } });
    await prisma.ticket.create({ data: { type: 'am_task', contactId: c.id, sellerId: s.id, assigneeId: U.yassine.id, status: 'open', taskType: 'checkin', title: 't', why: 'w' } });
  }
  return { contact: c, conv, ticket: t };
}

test('Delete all data: Administrator only, a reason and the number typed; merchants and the MDM lists go, accounts, settings and the audit log stay', async () => {
  const gone = await merchant({ seller: false, mdmRef: 'MDM-GONE' });
  await deleteRecords(U.admin, { kind: 'leads', ids: [gone.ticket.id], reason: 'Test' }); // on the Deleted merchants list, kept out of the sync
  await merchant({ sends: 2 });
  await merchant({ seller: true, mdmRef: 'MDM-S-1' });
  await prisma.mdmSkipped.create({ data: { mdmRef: 'SK-1', name: 'Skipped', reason: 'x', reasonCode: 'market' } });
  await prisma.mdmStaff.create({ data: { mdmRef: 'U-1', name: 'Amal' } });
  await prisma.mdmRecord.create({ data: { kind: 'seller', mdmRef: 'MDM-S-1', data: '{}' } });
  await prisma.integrationRun.create({ data: { kind: 'mdm_sync', status: 'completed', finishedAt: new Date() } });
  const configs = await prisma.configVersion.count();
  const admin = await tok('admin');

  for (const who of ['salma', 'yassine', 'head']) {
    assert.equal((await app.call('GET', '/api/admin/delete-all', { token: await tok(who) })).status, 403, who);
    assert.equal((await app.call('POST', '/api/admin/delete-all', { token: await tok(who), body: { reason: 'x', confirm: '2' } })).status, 403, who);
  }
  const pre = await app.call('GET', '/api/admin/delete-all', { token: admin });
  assert.equal(pre.status, 200);
  assert.deepEqual(pre.body.counts, { merchants: 2, sellers: 1, onboarding: 2, amTasks: 1, messages: 4, skipped: 1, people: 1, records: 1, deletedList: 1 });
  assert.equal(pre.body.confirmWith, 2); assert.equal(pre.body.syncRunning, false);

  assert.equal((await app.call('POST', '/api/admin/delete-all', { token: admin, body: { reason: ' ', confirm: '2' } })).status, 400);
  const wrong = await app.call('POST', '/api/admin/delete-all', { token: admin, body: { reason: 'Start again', confirm: '3' } });
  assert.equal(wrong.status, 400); assert.match(wrong.body.error.message, /type 2/);
  await assert.rejects(deleteAllData(U.admin, { reason: 'x', confirm: '2' }, { syncRunning: true }), (e) => e.status === 409);
  assert.equal(await prisma.contact.count(), 2, 'nothing deleted by a refused call');
  assert.equal((await ctl.getSyncSettings()).paused, false, 'a refused call does not pause the sync');
  const budgetBefore = (await onboardingBudget('none')).used;
  assert.equal(budgetBefore, 2);

  const r = await app.call('POST', '/api/admin/delete-all', { token: admin, body: { reason: 'Start again with recent sellers', confirm: '2' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.deleted.merchants, 2); assert.equal(r.body.deleted.deletedList, 0); assert.equal(r.body.syncPaused, true);
  for (const m of ['contact', 'conversation', 'message', 'ticket', 'seller', 'healthHistory', 'playbookProgress', 'notification', 'mdmSkipped', 'mdmStaff', 'mdmRecord']) {
    assert.equal(await prisma[m].count(), 0, m);
  }
  assert.equal(await prisma.user.count({ where: { email: { endsWith: '@t.local' } } }), 4, 'accounts stay');
  assert.equal(await prisma.configVersion.count(), configs, 'configuration stays');
  assert.equal(await prisma.integrationRun.count({ where: { kind: 'mdm_sync' } }), 1, 'run history stays');
  assert.ok(await prisma.eventLog.count({ where: { action: 'records.deleted' } }), 'the audit log is never deleted');
  // the Deleted merchants list is kept: that merchant stays out of the sync
  assert.equal((await listDeleted()).total, 1);
  assert.equal((await listDeleted()).items.length, 1, 'the bookkeeping row of the run is not listed');
  // spent template sends stay spent
  assert.equal((await onboardingBudget('none')).used, budgetBefore);
  // paused, and the next run reads MDM from the beginning
  const s = await ctl.getSyncSettings();
  assert.equal(s.paused, true);
  const st = (await app.call('GET', '/api/integrations/status', { token: admin })).body.mdm.sync;
  assert.equal(st.fullNext, true);
  const next = await sync({ fetchImpl: fakeMdm({}).fetchImpl });
  assert.equal(next.full, true);
  const log = await prisma.eventLog.findFirst({ where: { action: 'records.deleted_all' } });
  assert.equal(log.actorId, U.admin.id); assert.equal(log.reason, 'Start again with recent sellers');
  const after = JSON.parse(log.after);
  assert.equal(after.merchants.length, 2); assert.ok(after.merchants.some((m) => m.mdmRef === 'MDM-S-1' && m.seller));
  assert.ok(after.kept.includes('audit log'));
});

test('Delete all data can empty the Deleted merchants list too; their spent template sends still count', async () => {
  const a = await merchant({ sends: 3, mdmRef: 'MDM-A' });
  await deleteRecords(U.admin, { kind: 'leads', ids: [a.ticket.id], reason: 'Test' });
  await merchant({ sends: 1 });
  assert.equal((await onboardingBudget('none')).used, 4);
  const r = await deleteAllData(U.admin, { reason: 'Clean slate', confirm: '1', emptyDeletedList: true });
  assert.equal(r.deleted.deletedList, 1);
  assert.equal((await listDeleted()).total, 0);
  assert.equal(await prisma.deletedMerchant.count({ where: { keepOut: true } }), 0, 'nothing is kept out of the sync any more');
  assert.equal((await onboardingBudget('none')).used, 4, 'all four sends stay spent this month');
  assert.equal((await onboardingAnalytics()).tplUsed, 4, 'the Operations figure counts them too');
  const row = await prisma.deletedMerchant.findFirst({ where: { kind: 'all' } });
  const res = await restoreDeleted(U.admin, { ids: [row.id], reason: 'x' });
  assert.equal(res.done, 0, 'the bookkeeping row cannot be restored');
  // nothing to delete: confirm with 0
  const empty = await deleteAllData(U.admin, { reason: 'Again', confirm: '0' });
  assert.equal(empty.deleted.merchants, 0);
});
