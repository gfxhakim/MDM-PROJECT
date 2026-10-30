// Step 10 — AM Part 14 acceptance criteria, one test per criterion (AC-01 … AC-27).
// Each test is named after its criterion and follows its "Verify" line where the spec gives one.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTestDatabase } from './helpers/db.js';
import { startApp } from './helpers/http.js';

useTestDatabase('acceptance-am');
process.env.JWT_SECRET = 'test-secret';
const { prisma } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const cfg = await import('../src/config/service.js');
const { hashPassword } = await import('../src/auth/service.js');
const { defaultValues, AM_HEALTH_WEIGHT_KEYS } = await import('../src/config/parameters.js');
const { computeHealth, effectiveWeights } = await import('../src/am/health.js');
const { runAmSweep } = await import('../src/am/rules.js');
const { recomputeAll } = await import('../src/am/recompute.js');
const { handover } = await import('../src/am/handover.js');
const { managerCapacity } = await import('../src/am/capacity.js');
const { STEPS } = await import('../src/am/playbook.js');
const { TICKET_TYPES } = await import('../src/core/ticketTypes.js');
const { consoles } = await import('../src/web/consoles.js');
const am = await import('../src/am/service.js');

const PASSWORD = 'pw-123456';
const U = {};
let app;
const tok = (k) => app.login(`${k}@t.local`, PASSWORD);
const call = (...a) => app.call(...a);
const as = (k) => ({ id: U[k].id, role: U[k].role, name: U[k].name });
const D = defaultValues();
const DAY = 86_400_000;
const NOW = new Date();
const ago = (days) => new Date(NOW.getTime() - days * DAY);
const later = (days) => new Date(NOW.getTime() + days * DAY);
let seq = 700;

async function mkSeller(amKey, over = {}, market = 'LY') {
  const n = seq++;
  const contact = await prisma.contact.create({ data: { name: `Seller ${n}`, phone: `+2189500${n}`, country: market, contactType: 'seller', ownerAgentId: amKey ? U[amKey].id : null } });
  await prisma.conversation.create({ data: { contactId: contact.id } });
  return prisma.seller.create({
    data: {
      mdmRef: `MDM-S-${n}`, contactId: contact.id, market, joinStatus: 'accepted', activatedAt: ago(60),
      assignedAccountManagerId: amKey ? U[amKey].id : null, welcomeCallAt: ago(59), totalOrders: 120,
      weeklyOrders: JSON.stringify([10, 10, 10, 10, 10, 10, 10, 10]), lastOrderAt: ago(1), lastContactAt: ago(1),
      deliveryRate: 40, returnRate: 15, wallet: 500, products: 20, marketsServed: 1, momGrowthPct: 0, ...over,
    },
  });
}
const tasksOf = (s) => prisma.ticket.findMany({ where: { type: 'am_task', sellerId: s.id, status: 'open' } });
const CALL_TYPES = ['intervention', 'save', 'checkin'];

before(async () => {
  for (const [k, role, markets] of [['admin', 'ADMIN', []], ['salma', 'OA_AGENT', ['LY']],
    ['yassine', 'ACCOUNT_MANAGER', ['LY']], ['rania', 'ACCOUNT_MANAGER', ['LY', 'LB']], ['omar', 'ACCOUNT_MANAGER', ['IQ']]]) {
    U[k] = await prisma.user.create({ data: { email: `${k}@t.local`, name: k, role, markets: JSON.stringify(markets), passwordHash: await hashPassword(PASSWORD) } });
  }
  app = await startApp(createApp);
});
beforeEach(async () => {
  for (const m of ['notification', 'eventLog', 'message', 'ticket', 'playbookProgress', 'healthHistory', 'seller', 'conversation', 'contact']) await prisma[m].deleteMany();
  await prisma.configDraft.deleteMany();
  await prisma.configVersion.deleteMany();
  await cfg.seedDefaults();
  await prisma.user.updateMany({ data: { lastAssignedAt: null } });
});
after(async () => { app?.close(); await prisma.$disconnect(); });

// ───────────── 14.1 Data model and handover ─────────────

test('AC-01 — activation assigns by market and lowest book, emits SELLER_ASSIGNED, opens a welcome task due within welcomeCallH', async () => {
  await mkSeller('yassine'); // yassine 1, rania 0 in LY
  for (const [market, expected] of [['LY', 'rania'], ['LB', 'rania'], ['IQ', 'omar']]) {
    const s = await mkSeller(null, { welcomeCallAt: null, activatedAt: NOW }, market);
    const r = await handover(s.id, { config: D, now: NOW });
    assert.equal(r.managerId, U[expected].id, market);
    assert.ok(await prisma.eventLog.findFirst({ where: { entityId: s.id, action: 'SELLER_ASSIGNED' } }));
    assert.ok(await prisma.notification.findFirst({ where: { userId: U[expected].id, kind: 'am.r1.assigned' } }));
    const [task] = await tasksOf(s);
    assert.deepEqual([task.taskType, task.ruleId, task.assigneeId], ['welcome', 'r1', U[expected].id]);
    assert.ok(task.dueAt - NOW <= D['am.welcomeCallH'] * 3_600_000);
  }
});

test('AC-02 — a full market leaves the seller unassigned, alerts the Admin, shows in the quality check; no ceiling breach, no cross-market fallback', async () => {
  const d = await cfg.updateDraft({ 'am.maxBook': 1 }, as('admin'));
  assert.ok(d);
  await cfg.publish({ actor: as('admin'), note: 'Ceiling 1' });
  await mkSeller('yassine'); await mkSeller('rania');
  const s = await mkSeller(null, { welcomeCallAt: null, activatedAt: NOW });
  const r = await handover(s.id, { config: (await cfg.getLiveConfig()).values, now: NOW });
  assert.equal(r.assigned, false);
  assert.match(r.reason, /book ceiling/);
  assert.equal((await prisma.seller.findUnique({ where: { id: s.id } })).assignedAccountManagerId, null); // omar (IQ) not used
  assert.ok(await prisma.notification.findFirst({ where: { userId: U.admin.id, kind: 'am.r1.no_manager' } }));
  const a = await call('GET', '/api/am/analytics', { token: await tok('admin') });
  assert.equal(a.body.quality.unassigned, 1);
  assert.match(consoles().am, /Sellers with no account manager', v:MDM\.quality\('unassigned'\)/);
  for (const m of [U.yassine, U.rania]) assert.ok(await prisma.seller.count({ where: { assignedAccountManagerId: m.id } }) <= 1);
});

test('AC-03 — health score and lifecycle stage cannot be written by any role through any endpoint', async () => {
  const s = await mkSeller('yassine');
  const admin = await tok('admin');
  for (const body of [{ healthScore: 99 }, { stage: 'Mature' }, { healthBand: 'Thriving' }]) {
    assert.equal((await call('POST', `/api/am/dev/sellers/${s.id}/metrics`, { token: admin, body })).status, 400);
  }
  for (const method of ['PATCH', 'PUT', 'POST']) assert.ok((await call(method, `/api/am/sellers/${s.id}`, { token: admin, body: { healthScore: 99, stage: 'Mature' } })).status >= 400);
  const mdm = await fetch(`${app.base}/api/integrations/mdm/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'seller.metrics', data: { mdmRef: s.mdmRef, metrics: { healthScore: 99 } } }) });
  assert.equal(mdm.status, 401);
  const fresh = await prisma.seller.findUnique({ where: { id: s.id } });
  assert.deepEqual([fresh.healthScore, fresh.stage], [null, 'New']);
});

// ───────────── 14.2 Health engine ─────────────

test('AC-04 — every seller scores 0–100 inclusive; the weights in use total exactly 100 whether or not engagementLive is set', () => {
  for (const live of [false, true]) {
    const c = { ...D, 'am.engagementLive': live };
    const w = effectiveWeights(c);
    assert.equal(Object.values(w).reduce((a, b) => a + b, 0), 100);
    const extremes = [
      { weeklyOrders: '[]', lastOrderAt: null, deliveryRate: 0, returnRate: 100, wallet: -5000, walletNegativeDays: 200, products: 0, marketsServed: 1, momGrowthPct: -100, activatedAt: ago(400) },
      { weeklyOrders: JSON.stringify([1, 1, 1, 1, 500, 500, 500, 500]), lastOrderAt: ago(0), deliveryRate: 100, returnRate: 0, wallet: 99999, walletNegativeDays: 0, products: 500, marketsServed: 9, momGrowthPct: 900, activatedAt: ago(400), lastLoginAt: ago(0), lastStoreUpdateAt: ago(0), lastProductAddedAt: ago(0) },
    ];
    for (const s of extremes) {
      const h = computeHealth(s, 'Active', c, NOW);
      assert.ok(h.score >= 0 && h.score <= 100, `${h.score}`);
      assert.equal(h.components.reduce((a, x) => a + x.weight, 0), 100);
    }
  }
});

test('AC-05 — engagementLive=false weights 40/35/0/15/10; true restores 30/25/20/15/10', () => {
  assert.deepEqual(effectiveWeights(D), { activity: 40, delivery: 35, engagement: 0, financial: 15, growth: 10 });
  assert.deepEqual(effectiveWeights({ ...D, 'am.engagementLive': true }), { activity: 30, delivery: 25, engagement: 20, financial: 15, growth: 10 });
});

test('AC-06 — the inactivity floor caps Order Activity at 40/20/5; recent growth with 31 days inactive scores 5', () => {
  const rising = { weeklyOrders: JSON.stringify([2, 2, 2, 2, 20, 20, 20, 20]), deliveryRate: 40, returnRate: 15, wallet: 0, walletNegativeDays: 0, products: 10, marketsServed: 1, momGrowthPct: 80, activatedAt: ago(120) };
  const act = (days) => computeHealth({ ...rising, lastOrderAt: ago(days) }, 'Active', D, NOW).components.find((x) => x.key === 'activity').score;
  assert.equal(act(D['am.inactiveDays']), 40);
  assert.equal(act(D['am.saveDays']), 20);
  assert.equal(act(D['am.churnDays']), 5);
  assert.equal(act(31), 5);
});

test('AC-07 — every component carries a generated sentence naming the values that produced it', async () => {
  const s = await mkSeller('yassine', { deliveryRate: 33, returnRate: 21, wallet: -120, walletNegativeDays: 9 });
  await recomputeAll({ config: D, now: NOW });
  const view = (await call('GET', `/api/am/sellers/${s.id}`, { token: await tok('yassine') })).body;
  assert.equal(view.health.components.length, 5);
  for (const c of view.health.components) {
    assert.ok(typeof c.why === 'string' && c.why.length > 10, c.key);
    if (c.score !== null) assert.match(c.why, /\d/, `${c.key} names its values`);
  }
  assert.match(view.health.components.find((c) => c.key === 'delivery').why, /33/);
});

test('AC-08 — a failed recompute keeps yesterday\'s scores whole, flags them stale and alerts the Admin; nothing partial is written', async () => {
  const a = await mkSeller('yassine'); const b = await mkSeller('yassine', { lastOrderAt: ago(40) });
  await recomputeAll({ config: D, now: ago(1) });
  const before = await prisma.seller.findMany({ orderBy: { id: 'asc' }, select: { id: true, healthScore: true, healthBand: true, stage: true, healthComputedAt: true } });
  const broken = new Proxy(prisma, { get(t, k) {
    if (k === 'ticket') return { findMany: async () => { throw new Error('database unavailable'); } };
    const v = Reflect.get(t, k); return typeof v === 'function' ? v.bind(t) : v;
  } });
  await assert.rejects(recomputeAll({ db: broken, config: D, now: NOW }), /database unavailable/);
  const after = await prisma.seller.findMany({ orderBy: { id: 'asc' }, select: { id: true, healthScore: true, healthBand: true, stage: true, healthComputedAt: true, healthStale: true } });
  assert.deepEqual(after.map(({ healthStale, ...x }) => x), before);
  assert.ok(after.every((x) => x.healthStale));
  assert.ok(await prisma.notification.findFirst({ where: { userId: U.admin.id, kind: 'am.recompute_failed' } }));
  assert.ok(await prisma.eventLog.findFirst({ where: { action: 'health.recompute_failed' } }));
  assert.ok([a, b]);
});

// ───────────── 14.3 Rule engine ─────────────

test('AC-09 — running the sweep twice opens zero tasks the second time', async () => {
  await mkSeller('yassine', { lastOrderAt: ago(9) });
  await mkSeller('yassine', { wallet: -200, walletNegativeDays: 40 });
  await mkSeller('rania', { lastContactAt: ago(40) });
  await mkSeller('rania', { weeklyReturnRates: JSON.stringify([40, 45, 50]) });
  const first = await runAmSweep({ now: NOW });
  assert.ok(first.tasksOpened >= 4);
  const second = await runAmSweep({ now: NOW });
  assert.deepEqual([second.tasksOpened, second.tasksUpgraded], [0, 0]);
});

test('AC-10 — a seller meeting r2, r3, r4 and r5 at once holds exactly one open call task: the save campaign', async () => {
  const s = await mkSeller('yassine', { lastOrderAt: ago(20), weeklyOrders: JSON.stringify([20, 20, 20, 20, 20, 20, 20, 6]),
    deliveryRate: 10, returnRate: 45, wallet: -300, walletNegativeDays: 20, lastContactAt: ago(40) });
  await runAmSweep({ now: NOW });
  await runAmSweep({ now: NOW });
  const calls = (await tasksOf(s)).filter((t) => CALL_TYPES.includes(t.taskType));
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].taskType, calls[0].ruleId], ['save', 'r5']);
});

test('AC-11 — crossing Critical with an open r13 check-in upgrades it in place: intervention, urgent, due today; no second task', async () => {
  const s = await mkSeller('yassine', { lastContactAt: ago(30) });
  await runAmSweep({ now: NOW });
  const [checkin] = await tasksOf(s);
  assert.deepEqual([checkin.ruleId, checkin.taskType], ['r13', 'checkin']);
  await prisma.seller.update({ where: { id: s.id }, data: { deliveryRate: 5, returnRate: 50, wallet: -900, walletNegativeDays: 40, weeklyOrders: JSON.stringify([30, 30, 30, 30, 5, 5, 5, 6]), lastOrderAt: ago(1) } });
  await runAmSweep({ now: NOW });
  const open = await tasksOf(s);
  assert.equal(open.filter((t) => CALL_TYPES.includes(t.taskType)).length, 1);
  const up = open.find((t) => t.id === checkin.id);
  assert.deepEqual([up.taskType, up.priority], ['intervention', 'urgent']);
  assert.equal(up.dueAt.toISOString().slice(0, 10), NOW.toISOString().slice(0, 10));
});

test('AC-12 — no rule sends, spends template budget, closes a task, or changes the account manager', async () => {
  const sellers = [
    await mkSeller('yassine', { lastOrderAt: ago(9) }), await mkSeller('yassine', { lastOrderAt: ago(20) }),
    await mkSeller('rania', { wallet: -100, walletNegativeDays: 40 }), await mkSeller('rania', { activatedAt: ago(4), welcomeCallAt: null, totalOrders: 0 }),
  ];
  const manual = await am.createTask(as('yassine'), sellers[0].id, { taskType: 'coord', why: 'Stock question' });
  const msgs = await prisma.message.count();
  for (const d of [0, 7, 20, 45]) await runAmSweep({ now: later(d) });
  assert.equal(await prisma.message.count(), msgs);
  assert.equal(await prisma.message.count({ where: { billable: true } }), 0);
  assert.equal((await prisma.ticket.findUnique({ where: { id: manual.id } })).status, 'open');
  assert.equal(await prisma.ticket.count({ where: { type: 'am_task', status: { not: 'open' } } }), 0);
  for (const s of sellers) assert.equal((await prisma.seller.findUnique({ where: { id: s.id } })).assignedAccountManagerId, s.assignedAccountManagerId);
  assert.equal(await prisma.eventLog.count({ where: { action: { in: ['seller.reassigned', 'SELLER_ASSIGNED'] }, actorId: null } }), 0);
});

test('AC-13 — escalation sets the flag, notifies the next owner, audits, needs a reason, and leaves ownership and conversation alone', async () => {
  const s = await mkSeller('yassine');
  const t = await am.createTask(as('yassine'), s.id, { taskType: 'coord', why: 'Courier lost three parcels' });
  const y = await tok('yassine');
  assert.equal((await call('POST', `/api/am/tasks/${t.id}/escalate`, { token: y, body: {} })).status, 400);
  const msgs = await prisma.message.count();
  const r = await call('POST', `/api/am/tasks/${t.id}/escalate`, { token: y, body: { reason: 'Needs Operations — repeated loss' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const task = await prisma.ticket.findUnique({ where: { id: t.id } });
  assert.deepEqual([task.escalated, task.assigneeId], [true, U.yassine.id]);
  assert.ok(await prisma.notification.findFirst({ where: { userId: U.admin.id, kind: 'am.task_escalated', ticketId: t.id } }));
  assert.ok(await prisma.eventLog.findFirst({ where: { entityId: t.id, action: 'am_task.escalated', reason: 'Needs Operations — repeated loss' } }));
  assert.equal((await prisma.seller.findUnique({ where: { id: s.id } })).assignedAccountManagerId, U.yassine.id);
  assert.equal(await prisma.message.count(), msgs);
});

// ───────────── 14.4 Playbooks ─────────────

test('AC-14 — a step whose gate is false cannot be ticked through any interface, and the refusal names the gate', async () => {
  const s = await mkSeller('yassine', { products: 2, totalOrders: 2 });
  for (const who of ['yassine', 'admin']) {
    const r = await call('POST', `/api/am/sellers/${s.id}/playbook/3/tick`, { token: await tok(who) });
    assert.equal(r.status, 422);
    assert.match(r.body.error.message, /≥ 3 products/);
  }
  await assert.rejects(am.tickStep(as('admin'), s.id, 3), { status: 422 });
  assert.equal(await prisma.playbookProgress.count({ where: { sellerId: s.id } }), 0);
});

test('AC-15 — each playbook step opens its own task on the day it comes due; a late step opens at high priority', async () => {
  const s = await mkSeller('yassine', { activatedAt: NOW, welcomeCallAt: NOW, totalOrders: 0, lastOrderAt: null, weeklyOrders: '[]', products: 0, lastContactAt: NOW });
  const taskDays = STEPS.filter((x) => x.taskType).map((x) => x.day);
  const opened = new Map();
  for (let d = 0; d <= 31; d++) {
    await runAmSweep({ now: later(d) });
    for (const t of await prisma.ticket.findMany({ where: { sellerId: s.id, ruleId: { startsWith: 'r10:' } } })) {
      const day = Number(t.ruleId.slice(5));
      if (!opened.has(day)) opened.set(day, { on: d, priority: t.priority, type: t.taskType });
    }
  }
  for (const day of taskDays) {
    assert.ok(opened.has(day), `day ${day} opened`);
    assert.equal(opened.get(day).on, day, `day ${day} opened on its day`);
    assert.equal(opened.get(day).priority, 'normal');
    assert.equal(opened.get(day).type, STEPS.find((x) => x.day === day).taskType);
  }
  assert.equal(new Set([...opened.keys()]).size, taskDays.length); // one task per step
  // day 0 is the assignment and day 1 the r1 welcome task — both opened by the handover, not r10
  assert.deepEqual(STEPS.filter((x) => !x.taskType).map((x) => x.day), [0, 1]);
  const late = await mkSeller('rania', { activatedAt: ago(10), welcomeCallAt: ago(9), totalOrders: 0, lastOrderAt: null, weeklyOrders: '[]', products: 0, lastContactAt: NOW });
  await runAmSweep({ now: NOW });
  const lateTasks = await prisma.ticket.findMany({ where: { sellerId: late.id, ruleId: { startsWith: 'r10:' } } });
  assert.deepEqual(lateTasks.map((t) => [t.ruleId, t.priority]).sort(), [['r10:d3', 'high'], ['r10:d5', 'high'], ['r10:d7', 'high']]);
});

// ───────────── 14.5 Capacity ─────────────

test('AC-16 — cadence is counted once, as a weekly rate: an open r13 check-in does not change committed', async () => {
  const s = await mkSeller('yassine', { lastContactAt: ago(40) });
  await recomputeAll({ config: D, now: NOW });
  const before = await managerCapacity(U.yassine, D, NOW);
  await runAmSweep({ now: NOW });
  const [checkin] = await tasksOf(s);
  assert.equal(checkin.ruleId, 'r13');
  const after = await managerCapacity(U.yassine, D, NOW);
  assert.equal(after.committed, before.committed);
  assert.equal(after.taskMins, 0);
});

test('AC-17 — completing a task reduces committed for that manager', async () => {
  const s = await mkSeller('yassine');
  await recomputeAll({ config: D, now: NOW });
  const t = await am.createTask(as('yassine'), s.id, { taskType: 'coord', why: 'Finance follow-up', dueAt: later(1) });
  const open = await managerCapacity(U.yassine, D, NOW);
  await am.closeTask(as('yassine'), t.id, 'Finance confirmed the payout');
  const closed = await managerCapacity(U.yassine, D, NOW);
  assert.ok(closed.committed < open.committed, `${closed.committed} < ${open.committed}`);
});

test('AC-18 — the capacity display names the binding constraint and reports free time and remaining seats together', async () => {
  await mkSeller('yassine');
  const r = await call('GET', '/api/am/capacity', { token: await tok('yassine') });
  assert.equal(r.status, 200);
  const rows = Array.isArray(r.body) ? r.body : [r.body];
  for (const c of rows.map((x) => x.capacity ?? x)) {
    assert.ok(['time', 'book ceiling'].includes(c.binding), JSON.stringify(c));
    assert.equal(typeof c.free, 'number');
    assert.equal(typeof c.headroom, 'number');
    assert.equal(typeof c.slots, 'number');
  }
});

// ───────────── 14.6 Permissions and scope ─────────────

test('AC-19 — every saved view returns only the account manager\'s own book', async () => {
  const mine = [await mkSeller('yassine'), await mkSeller('yassine', { lastOrderAt: ago(20) })];
  await mkSeller('rania'); await mkSeller('rania', { lastOrderAt: ago(20) });
  await recomputeAll({ config: D, now: NOW });
  const y = await tok('yassine');
  const ids = new Set(mine.map((s) => s.id));
  for (const q of ['', '?band=Critical', '?band=Healthy', '?band=At%20Risk', '?stage=Active', '?stage=Recovering', '?q=Seller']) {
    const r = await call('GET', `/api/am/book${q}`, { token: y });
    assert.equal(r.status, 200);
    assert.ok(r.body.every((s) => ids.has(s.id)), q);
  }
  const bundle = (await call('GET', '/api/am/console', { token: y })).body;
  assert.ok(bundle.sellers.length === 2 && bundle.sellers.every((s) => ids.has(s.id)));
});

test('AC-20 — a seller outside the caller\'s book is not-found at the API; the Admin is unaffected', async () => {
  const theirs = await mkSeller('rania');
  const t = await am.createTask(as('rania'), theirs.id, { taskType: 'coord', why: 'x' });
  const y = await tok('yassine');
  for (const [m, p, body] of [['GET', `/api/am/sellers/${theirs.id}`], ['GET', `/api/am/sellers/${theirs.id}/health-history`],
    ['POST', `/api/am/sellers/${theirs.id}/tasks`, { taskType: 'coord', why: 'x' }], ['POST', `/api/am/tasks/${t.id}/close`, { outcome: 'x' }],
    ['POST', `/api/am/sellers/${theirs.id}/playbook/3/tick`], ['POST', `/api/am/sellers/${theirs.id}/calls`, { outcome: 'done' }]]) {
    const r = await call(m, p, { token: y, body });
    assert.equal(r.status, 404, `${m} ${p}`);
  }
  const ghost = await call('GET', '/api/am/sellers/does-not-exist', { token: y });
  assert.deepEqual(ghost.body, (await call('GET', `/api/am/sellers/${theirs.id}`, { token: y })).body); // indistinguishable
  assert.equal((await call('GET', `/api/am/sellers/${theirs.id}`, { token: await tok('admin') })).status, 200);
});

test('AC-21 — controls an AM may not use carry their reason; sellers outside the book are not sent to the page at all', async () => {
  const mine = await mkSeller('yassine');
  await mkSeller('rania');
  const t = await am.createTask(as('yassine'), mine.id, { taskType: 'coord', why: 'x' });
  await am.closeTask(as('yassine'), t.id, 'done');
  const y = await tok('yassine');
  const me = (await call('GET', '/api/auth/me', { token: y })).body;
  assert.equal(me.grants['seller.assign_am'], false);
  const reassign = await call('POST', '/api/am/reassign', { token: y, body: { sellerIds: [mine.id], toManagerId: U.rania.id, reason: 'x' } });
  assert.equal(reassign.status, 403); assert.ok(reassign.body.error.message);
  const bundle = (await call('GET', '/api/am/console', { token: y })).body;
  assert.deepEqual(bundle.sellers.map((s) => s.id), [mine.id]);
  const closed = bundle.sellers[0].tasks.find((x) => x.id === t.id);
  assert.deepEqual(closed.can.close, { allowed: false, reason: 'Already closed.' });
});

// ───────────── 14.7 Configuration ─────────────

test('AC-22 — publishing is refused when the five health weights do not total 100, and the refusal names the total', async () => {
  const admin = await tok('admin');
  await call('PATCH', '/api/config/draft', { token: admin, body: { changes: { 'am.wActivity': 35 } } });
  const r = await call('POST', '/api/config/publish', { token: admin, body: {} });
  assert.ok(r.status >= 400);
  assert.match(r.body.error.message, /105/);
  assert.equal(AM_HEALTH_WEIGHT_KEYS.reduce((a, k) => a + D[k], 0), 100);
});

test('AC-23 — simulation mutates nothing: no seller, task, counter or timestamp', async () => {
  for (let i = 0; i < 3; i++) await mkSeller('yassine', { lastOrderAt: ago(3) });
  await runAmSweep({ now: NOW });
  const snap = async () => JSON.stringify({
    t: await prisma.ticket.findMany({ orderBy: { id: 'asc' } }), s: await prisma.seller.findMany({ orderBy: { id: 'asc' } }),
    n: await prisma.notification.count(), e: await prisma.eventLog.count(), h: await prisma.healthHistory.count(), m: await prisma.message.count(),
  });
  const before = await snap();
  const sim = await call('POST', '/api/config/simulate', { token: await tok('admin'), body: { changes: { 'am.inactiveDays': 2, 'am.welcomeCallH': 4 } } });
  assert.equal(sim.status, 200, JSON.stringify(sim.body));
  assert.ok(sim.body.impacts.accountManagement.tasksOpened > 0);
  assert.equal(await snap(), before);
});

test('AC-24 — rollback restores every key to the target snapshot, including keys that version did not change', async () => {
  const admin = await tok('admin');
  const pub = async (changes) => { await call('PATCH', '/api/config/draft', { token: admin, body: { changes } }); return (await call('POST', '/api/config/publish', { token: admin, body: {} })).body; };
  const first = await pub({ 'am.maxBook': 45 });
  const snapshot = (await cfg.getLiveConfig()).values;
  await pub({ 'am.inactiveDays': 9 });
  await pub({ 'am.welcomeCallH': 12, 'am.maxBook': 40 });
  const r = await call('POST', '/api/config/rollback', { token: admin, body: { targetVersion: first.version, note: 'Back' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((await cfg.getLiveConfig()).values, snapshot);
});

test('AC-25 — publishing triggers a sweep whose task count matches the simulation', async () => {
  for (let i = 0; i < 5; i++) await mkSeller('yassine', { lastOrderAt: ago(3) });
  await runAmSweep({ now: NOW });
  const admin = await tok('admin');
  const sim = await call('POST', '/api/config/simulate', { token: admin, body: { changes: { 'am.inactiveDays': 2 } } });
  await call('PATCH', '/api/config/draft', { token: admin, body: { changes: { 'am.inactiveDays': 2 } } });
  const before = await prisma.ticket.count({ where: { type: 'am_task' } });
  const pub = await call('POST', '/api/config/publish', { token: admin, body: { note: 'Earlier check-ins' } });
  assert.equal(pub.status, 200);
  const opened = (await prisma.ticket.count({ where: { type: 'am_task' } })) - before;
  assert.equal(opened, sim.body.impacts.accountManagement.tasksOpened);
  assert.equal(pub.body.effects.accountManagement.tasksOpened, opened);
});

// ───────────── 14.8 Metrics ─────────────

test('AC-26 — no am_task appears in support SLA, first-response or CSAT reporting', async () => {
  assert.equal(TICKET_TYPES.am_task.countsToward, 'none');
  const s = await mkSeller('yassine', { lastOrderAt: ago(9) });
  await runAmSweep({ now: NOW });
  const view = (await call('GET', `/api/am/sellers/${s.id}`, { token: await tok('yassine') })).body;
  assert.ok(view.tasks.length && view.tasks.every((t) => t.countsToward === 'none'));
  const oaReport = (await call('GET', '/api/oa/analytics', { token: await tok('admin') })).body;
  assert.equal(oaReport.registrants, 0); // AM tasks are not onboarding work either
});

test('AC-27 — every indicator states its source; one with no source says so instead of showing a number', async () => {
  await mkSeller('yassine');
  const a = (await call('GET', '/api/am/analytics', { token: await tok('admin') })).body;
  const row = a.perf[U.yassine.id];
  for (const k of ['nrr', 'upgrades', 'csat']) assert.equal(row[k], null, `${k} has no source and is not invented`);
  const html = consoles().am;
  assert.match(html, /derived from your book/);
  assert.match(html, /sourced from \$\{r\.src\}\$\{\(r\.src==='survey'\|\|kpiVal\(P,r\.k\)==='—'\)\?' — not wired yet':''\}/);
  const adapter = (await import('node:fs')).readFileSync('public/assets/am-adapter.js', 'utf8');
  assert.match(adapter, /window\.kpiVal = \(P, k\) => \(P\[k\] === null \|\| P\[k\] === undefined \? '—'/);
});
