// Step 6 — Account Manager engine: the health formulas (AM 4.2–4.5), lifecycle derivation,
// the rule sweep with precedence/dedup/upgrade (AM 5), playbook gates, capacity (AM 8), scope.
// AC-03, AC-09..AC-14, AC-19, AC-20, AC-23, AC-25, AC-26.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTestDatabase } from './helpers/db.js';
import { startApp } from './helpers/http.js';

useTestDatabase('am');
process.env.JWT_SECRET = 'test-secret';
const { prisma } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const cfg = await import('../src/config/service.js');
const { hashPassword } = await import('../src/auth/service.js');
const { defaultValues } = await import('../src/config/parameters.js');
const { computeHealth, bandOf, effectiveWeights } = await import('../src/am/health.js');
const { deriveStage } = await import('../src/am/lifecycle.js');
const { runAmSweep } = await import('../src/am/rules.js');
const { capacityFor, cadenceRate, coverage } = await import('../src/am/capacity.js');
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
let seq = 100;

/** A healthy, established seller in `amKey`'s book; override any mirror field. */
async function mkSeller(amKey, over = {}) {
  const n = seq++;
  const contact = await prisma.contact.create({ data: { name: `Seller ${n}`, phone: `+2189300${n}`, country: 'LY', contactType: 'seller', ownerAgentId: amKey ? U[amKey].id : null } });
  await prisma.conversation.create({ data: { contactId: contact.id } });
  return prisma.seller.create({
    data: {
      mdmRef: `MDM-S-${n}`, contactId: contact.id, market: 'LY', joinStatus: 'accepted', activatedAt: ago(60),
      assignedAccountManagerId: amKey ? U[amKey].id : null, welcomeCallAt: ago(59), totalOrders: 120,
      weeklyOrders: JSON.stringify([10, 10, 10, 10, 10, 10, 10, 10]), lastOrderAt: ago(1), lastContactAt: ago(1),
      deliveryRate: 40, returnRate: 15, wallet: 500, products: 20, marketsServed: 1, momGrowthPct: 0,
      ...over,
    },
  });
}
const tasksOf = (s) => prisma.ticket.findMany({ where: { type: 'am_task', sellerId: s.id } });

before(async () => {
  for (const [k, role] of [['admin', 'ADMIN'], ['manager', 'MANAGER'], ['salma', 'OA_AGENT'], ['yassine', 'ACCOUNT_MANAGER'], ['rania', 'ACCOUNT_MANAGER']]) {
    U[k] = await prisma.user.create({ data: { email: `${k}@t.local`, name: k, role, markets: JSON.stringify(['LY']), passwordHash: await hashPassword(PASSWORD) } });
  }
  app = await startApp(createApp);
});
beforeEach(async () => {
  for (const m of ['notification', 'eventLog', 'message', 'ticket', 'playbookProgress', 'healthHistory', 'seller', 'conversation', 'contact']) await prisma[m].deleteMany();
  await prisma.configDraft.deleteMany();
  await prisma.configVersion.deleteMany();
  await cfg.seedDefaults();
});
after(async () => { app?.close(); await prisma.$disconnect(); });

// ───────────── health formulas (AM 4.2–4.5) ─────────────

test('AM 4.8 worked example — MDM-S-0207 scores 20, Critical, on the fallback weighting', () => {
  const s = { weeklyOrders: JSON.stringify([40, 40, 40, 39, 15, 15, 15, 15]), lastOrderAt: ago(2), activatedAt: ago(200),
    deliveryRate: 19, returnRate: 44, wallet: -380, walletNegativeDays: 34, products: 23, marketsServed: 1, momGrowthPct: -62 };
  const h = computeHealth(s, 'Recovering', D, NOW);
  const by = Object.fromEntries(h.components.map((c) => [c.key, [c.score, c.weight]]));
  assert.deepEqual(by, { activity: [16, 40], delivery: [27, 35], engagement: [null, 0], financial: [6, 15], growth: [35, 10] });
  assert.deepEqual([h.score, h.band, h.fallback], [20, 'Critical', true]);
  assert.match(h.components[0].why, /15 orders|60 orders in the last four weeks against 159 before/);
});

test('fallback redistribution 40/35/0/15/10 while engagementLive=false; configured weights when live', () => {
  assert.deepEqual(effectiveWeights(D), { activity: 40, delivery: 35, engagement: 0, financial: 15, growth: 10 });
  assert.deepEqual(effectiveWeights({ ...D, 'am.engagementLive': true }), { activity: 30, delivery: 25, engagement: 20, financial: 15, growth: 10 });
  // odd engagement weight: round(e/2) to Activity, the rest to Delivery
  assert.deepEqual(effectiveWeights({ ...D, 'am.wEngagement': 15, 'am.wActivity': 35 }), { activity: 43, delivery: 32, engagement: 0, financial: 15, growth: 10 });
});

test('the inactivity floor caps Order Activity at 40 / 20 / 5, overriding a rising trend', () => {
  const rising = { weeklyOrders: JSON.stringify([5, 5, 5, 5, 10, 10, 10, 10]), deliveryRate: 40, returnRate: 15, wallet: 0, walletNegativeDays: 0, products: 10, marketsServed: 1, momGrowthPct: 0, activatedAt: ago(100) };
  const act = (days) => computeHealth({ ...rising, lastOrderAt: ago(days) }, 'Active', D, NOW).components[0].score;
  assert.equal(act(1), 100);
  assert.equal(act(7), 40);
  assert.equal(act(14), 20);
  assert.equal(act(30), 5);
});

test('component edge cases: New scores 50, eight empty weeks 5, first activity 85; delivery and returns knees', () => {
  const base = { deliveryRate: 35, returnRate: 24, wallet: 0, walletNegativeDays: 0, products: 0, marketsServed: 1, momGrowthPct: 0, lastOrderAt: ago(1), activatedAt: ago(30) };
  const comp = (s, stage, k) => computeHealth(s, stage, D, NOW).components.find((c) => c.key === k).score;
  assert.equal(comp({ ...base, weeklyOrders: '[]' }, 'New', 'activity'), 50);
  assert.equal(comp({ ...base, weeklyOrders: '[]' }, 'New', 'delivery'), 50);
  assert.equal(comp({ ...base, weeklyOrders: JSON.stringify([0, 0, 0, 0, 0, 0, 0, 0]) }, 'Active', 'activity'), 5);
  assert.equal(comp({ ...base, weeklyOrders: JSON.stringify([0, 0, 0, 0, 0, 0, 1, 2]) }, 'Active', 'activity'), 85);
  // hitting the delivery target scores 70 on that half; 24% returns lands near 71
  assert.equal(comp({ ...base, weeklyOrders: '[1]' }, 'Active', 'delivery'), Math.round(70 * 0.65 + (100 - 9 * 3.2) * 0.35));
  assert.equal(comp({ ...base, wallet: 0 }, 'Active', 'financial'), 80);
  assert.equal(comp({ ...base, wallet: 10000 }, 'Active', 'financial'), 100);
});

test('bands: Critical ≤40, At Risk ≤60, Healthy ≤80, Thriving above', () => {
  assert.deepEqual([40, 41, 60, 61, 80, 81].map((x) => bandOf(x, D)), ['Critical', 'At Risk', 'At Risk', 'Healthy', 'Healthy', 'Thriving']);
});

test('lifecycle stage is derived: Pending → New → Onboarding → Activated/Active/Growth/Mature, Recovering, Churned', () => {
  const s = { joinStatus: 'accepted', activatedAt: ago(3), welcomeCallAt: null, totalOrders: 0 };
  assert.equal(deriveStage({ ...s, joinStatus: 'pending' }, [], NOW), 'Pending Activation');
  assert.equal(deriveStage(s, [], NOW), 'New');
  assert.equal(deriveStage({ ...s, welcomeCallAt: ago(2) }, [], NOW), 'Onboarding');
  const ordered = { ...s, welcomeCallAt: ago(2), totalOrders: 3 };
  assert.equal(deriveStage(ordered, [], NOW), 'Activated');
  assert.equal(deriveStage({ ...ordered, activatedAt: ago(30) }, [], NOW), 'Active');
  assert.equal(deriveStage({ ...ordered, activatedAt: ago(120) }, [], NOW), 'Growth');
  assert.equal(deriveStage({ ...ordered, activatedAt: ago(200) }, [], NOW), 'Mature');
  assert.equal(deriveStage({ ...ordered, activatedAt: ago(200) }, [{ taskType: 'save' }], NOW), 'Recovering');
  assert.equal(deriveStage({ ...ordered, churnedAt: ago(1) }, [], NOW), 'Churned');
});

// ───────────── AC-03: derived, never writable ─────────────

test('AC-03: health score and lifecycle stage cannot be written through any endpoint, by any role', async () => {
  const s = await mkSeller('yassine');
  const admin = await tok('admin');
  for (const body of [{ healthScore: 99 }, { stage: 'Mature' }, { healthBand: 'Thriving' }]) {
    const r = await call('POST', `/api/am/dev/sellers/${s.id}/metrics`, { token: admin, body });
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /derived, never written/);
  }
  for (const method of ['PATCH', 'PUT']) {
    assert.equal((await call(method, `/api/am/sellers/${s.id}`, { token: admin, body: { healthScore: 99 } })).status, 404);
  }
  const fresh = await prisma.seller.findUnique({ where: { id: s.id } });
  assert.equal(fresh.healthScore, null);
});

// ───────────── the sweep ─────────────

test('AC-09: the sweep is idempotent — a second run opens zero tasks', async () => {
  await mkSeller('yassine', { lastOrderAt: ago(9) }); // r4
  await mkSeller('yassine', { wallet: -200, walletNegativeDays: 40 }); // r8
  await mkSeller('rania', { lastContactAt: ago(40) }); // r13
  const first = await runAmSweep({ now: NOW });
  assert.ok(first.tasksOpened >= 3);
  const second = await runAmSweep({ now: NOW });
  assert.equal(second.tasksOpened, 0);
  assert.equal(second.tasksUpgraded, 0);
});

test('AC-10: one call, one task — save > critical > decline > inactivity', async () => {
  // inactive 20 days (save), and health will also be critical, and last week dropped
  const s = await mkSeller('yassine', { lastOrderAt: ago(20), weeklyOrders: JSON.stringify([20, 20, 20, 20, 20, 20, 10, 0]),
    deliveryRate: 10, returnRate: 45, wallet: -300, walletNegativeDays: 20 });
  const r = await runAmSweep({ now: NOW });
  const tasks = await tasksOf(s);
  const calls = tasks.filter((t) => ['intervention', 'save', 'checkin'].includes(t.taskType));
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].taskType, calls[0].ruleId, calls[0].priority], ['save', 'r5', 'urgent']);
  assert.ok((await prisma.seller.findUnique({ where: { id: s.id } })).healthScore < D['am.healthCritical']);
  assert.equal(r.byRule.r2 ?? 0, 0);
});

test('AC-11: crossing Critical with an open cadence check-in upgrades it in place — no second task', async () => {
  const s = await mkSeller('yassine', { lastContactAt: ago(30) });
  await runAmSweep({ now: NOW });
  let tasks = await tasksOf(s);
  assert.equal(tasks.length, 1);
  assert.deepEqual([tasks[0].ruleId, tasks[0].taskType], ['r13', 'checkin']);
  const id = tasks[0].id;
  await prisma.seller.update({ where: { id: s.id }, data: { deliveryRate: 5, returnRate: 50, wallet: -900, walletNegativeDays: 40, weeklyOrders: JSON.stringify([30, 30, 30, 30, 5, 5, 5, 6]), lastOrderAt: ago(1) } });
  const r = await runAmSweep({ now: NOW });
  tasks = await tasksOf(s);
  const call = tasks.find((t) => t.id === id);
  assert.deepEqual([call.taskType, call.priority, call.ruleId, call.alertKey], ['intervention', 'urgent', 'r2', 'SELLER_HEALTH_CRITICAL']);
  assert.match(call.why, /Upgraded .*below the critical threshold/);
  assert.equal(tasks.filter((t) => ['intervention', 'save', 'checkin'].includes(t.taskType)).length, 1);
  assert.equal(r.tasksUpgraded, 1);
});

test('AC-12: rules never send, never close, never reassign', async () => {
  const s = await mkSeller('yassine', { lastOrderAt: ago(9) });
  const manual = await am.createTask(as('yassine'), s.id, { taskType: 'coord', why: 'Stock question' });
  const msgs = await prisma.message.count();
  await runAmSweep({ now: NOW });
  await runAmSweep({ now: new Date(NOW.getTime() + 20 * DAY) });
  assert.equal(await prisma.message.count(), msgs);
  assert.equal((await prisma.ticket.findUnique({ where: { id: manual.id } })).status, 'open');
  assert.equal(await prisma.ticket.count({ where: { type: 'am_task', status: { not: 'open' } } }), 0);
  assert.equal((await prisma.seller.findUnique({ where: { id: s.id } })).assignedAccountManagerId, U.yassine.id);
});

test('r3 decline needs ≥5 orders last week; r4 opens a check-in that r5 upgrades to a save in place', async () => {
  const small = await mkSeller('yassine', { weeklyOrders: JSON.stringify([4, 4, 4, 4, 4, 4, 4, 0]) });
  const big = await mkSeller('yassine', { weeklyOrders: JSON.stringify([10, 10, 10, 10, 10, 10, 10, 5]) });
  await runAmSweep({ now: NOW });
  assert.equal((await tasksOf(small)).length, 0);
  const t = await tasksOf(big);
  assert.deepEqual(t.map((x) => [x.ruleId, x.taskType, x.priority]), [['r3', 'intervention', 'high']]);

  const idle = await mkSeller('rania', { lastOrderAt: ago(8) });
  await runAmSweep({ now: NOW });
  const [checkin] = await tasksOf(idle);
  assert.deepEqual([checkin.ruleId, checkin.taskType, checkin.title], ['r4', 'checkin', 'Check-in · no orders']);
  await runAmSweep({ now: new Date(NOW.getTime() + 7 * DAY) });
  const after = await tasksOf(idle);
  assert.equal(after.length, 1);
  assert.deepEqual([after[0].id, after[0].taskType, after[0].ruleId, after[0].priority], [checkin.id, 'save', 'r5', 'urgent']);
});

test('r6, r8, r9, r10 open their tasks with the spec\'s type, priority and due date', async () => {
  const returns = await mkSeller('yassine', { weeklyReturnRates: JSON.stringify([30, 45, 48]) });
  const wallet = await mkSeller('yassine', { wallet: -100, walletNegativeDays: 30 });
  const mature = await mkSeller('yassine', { activatedAt: ago(200), welcomeCallAt: ago(199), lastReviewAt: ago(95) });
  const young = await mkSeller('yassine', { activatedAt: ago(5), welcomeCallAt: ago(4), totalOrders: 0, lastOrderAt: null, weeklyOrders: '[]', lastContactAt: ago(1) });
  await runAmSweep({ now: NOW });
  const one = async (s) => (await tasksOf(s)).map((t) => [t.ruleId, t.taskType, t.priority]);
  assert.deepEqual(await one(returns), [['r6', 'coach', 'high']]);
  assert.deepEqual(await one(wallet), [['r8', 'coord', 'normal']]);
  assert.deepEqual(await one(mature), [['r9', 'qbr', 'normal']]);
  assert.deepEqual((await one(young)).map((x) => x[0]).sort(), ['r10:d3', 'r10:d5']);
});

// ───────────── AM actions ─────────────

test('AC-14: a playbook step whose gate is false cannot be ticked, by any role', async () => {
  const s = await mkSeller('yassine', { products: 2, totalOrders: 2 });
  const r = await call('POST', `/api/am/sellers/${s.id}/playbook/3/tick`, { token: await tok('yassine') });
  assert.equal(r.status, 422);
  assert.match(r.body.error.message, /gate not met \(≥ 3 products\)/);
  assert.equal((await call('POST', `/api/am/sellers/${s.id}/playbook/3/tick`, { token: await tok('admin') })).status, 422);
  await prisma.seller.update({ where: { id: s.id }, data: { products: 3 } }); // read live, not stored
  assert.equal((await call('POST', `/api/am/sellers/${s.id}/playbook/3/tick`, { token: await tok('yassine') })).status, 200);
  const view = (await call('GET', `/api/am/sellers/${s.id}`, { token: await tok('yassine') })).body;
  assert.equal(view.playbook.find((p) => p.day === 3).tickedAt !== null, true);
  assert.equal(view.playbook.find((p) => p.day === 14).reason, 'Gate not met: ≥ 5 orders.');
});

test('closing needs an outcome and is a human act; the welcome call moves the seller to Onboarding', async () => {
  const s = await mkSeller('yassine', { welcomeCallAt: null, totalOrders: 0, lastOrderAt: null, weeklyOrders: '[]', activatedAt: ago(0) });
  const task = await prisma.ticket.create({ data: { type: 'am_task', contactId: s.contactId, sellerId: s.id, assigneeId: U.yassine.id, status: 'open', taskType: 'welcome', why: 'r1', ruleId: 'r1' } });
  const y = await tok('yassine');
  assert.equal((await call('POST', `/api/am/tasks/${task.id}/close`, { token: y, body: {} })).status, 400);
  assert.equal((await call('POST', `/api/am/tasks/${task.id}/close`, { token: await tok('rania'), body: { outcome: 'x' } })).status, 404);
  assert.equal((await call('POST', `/api/am/tasks/${task.id}/close`, { token: y, body: { outcome: 'Walked through the store setup' } })).status, 200);
  await runAmSweep({ now: NOW });
  const after = await prisma.seller.findUnique({ where: { id: s.id } });
  assert.ok(after.welcomeCallAt);
  assert.equal(after.stage, 'Onboarding');
});

test('escalation moves the problem, not the seller: reason required, priority up, audited', async () => {
  const s = await mkSeller('yassine');
  const t = await am.createTask(as('yassine'), s.id, { taskType: 'coord', why: 'Courier lost 3 parcels', priority: 'normal' });
  await assert.rejects(am.escalateTask(as('yassine'), t.id, ''), { status: 400 });
  const e = await am.escalateTask(as('yassine'), t.id, 'Needs Operations');
  assert.deepEqual([e.escalated, e.priority, e.assigneeId], [true, 'high', U.yassine.id]);
  assert.ok(await prisma.eventLog.findFirst({ where: { entityId: t.id, action: 'am_task.escalated', reason: 'Needs Operations' } }));
  await assert.rejects(am.createTask(as('yassine'), s.id, { taskType: 'coord' }), /why is required/);
});

// ───────────── scope (AC-19, AC-20) ─────────────

test('AC-19/AC-20: an AM\'s book holds only their sellers; a foreign seller is not-found; Admin sees all', async () => {
  const mine = await mkSeller('yassine');
  const theirs = await mkSeller('rania');
  await runAmSweep({ now: NOW });
  const y = await tok('yassine');
  const book = (await call('GET', '/api/am/book', { token: y })).body;
  assert.deepEqual(book.map((s) => s.id), [mine.id]);
  assert.equal((await call('GET', `/api/am/sellers/${theirs.id}`, { token: y })).status, 404);
  assert.equal((await call('GET', `/api/am/sellers/${theirs.id}/health-history`, { token: y })).status, 404);
  assert.equal((await call('POST', `/api/am/sellers/${theirs.id}/tasks`, { token: y, body: { taskType: 'coord', why: 'x' } })).status, 404);
  assert.equal((await call('GET', `/api/am/sellers/${theirs.id}`, { token: await tok('admin') })).status, 200);
  assert.equal((await call('GET', '/api/am/book', { token: await tok('salma') })).status, 403);
  const view = (await call('GET', `/api/am/sellers/${mine.id}`, { token: y })).body;
  assert.match(view.health.weighting, /split between Order Activity and Delivery/);
  assert.equal(view.health.components.length, 5);
});

test('reassignment is Admin-only, needs a reason, reports per-seller results, writes one bulk audit entry', async () => {
  const a = await mkSeller('yassine');
  const b = await mkSeller('yassine');
  assert.equal((await call('POST', '/api/am/reassign', { token: await tok('yassine'), body: { sellerIds: [a.id], toManagerId: U.rania.id, reason: 'x' } })).status, 403);
  const r = await call('POST', '/api/am/reassign', { token: await tok('admin'), body: { sellerIds: [a.id, 'missing', b.id], toManagerId: U.rania.id, reason: 'Language match' } });
  assert.deepEqual([r.body.succeeded, r.body.failed], [2, 1]);
  assert.equal((await prisma.seller.findUnique({ where: { id: a.id } })).assignedAccountManagerId, U.rania.id);
  assert.equal(await prisma.eventLog.count({ where: { action: 'bulk.seller_reassign' } }), 1);
  assert.equal(await prisma.eventLog.count({ where: { action: 'seller.reassigned' } }), 2);
});

// ───────────── capacity (AM 8) ─────────────

test('capacity: cadence is a weekly rate (18 / 8 / 5 min), the week is 34 h assignable, the binding constraint is named', () => {
  assert.deepEqual(['Critical', 'At Risk', 'Healthy', 'Thriving'].map((b) => cadenceRate('Active', b, D)), [18, 18, 8, 5]);
  assert.equal(cadenceRate('Onboarding', 'Critical', D), 0);
  const full = capacityFor(Array(50).fill({ stage: 'Active', band: 'Healthy' }), [], D, NOW);
  assert.deepEqual([full.assignable, full.baseline, full.cadence], [2040, 400, 400]);
  assert.equal(full.committed, Math.round(800 * 1.12));
  assert.deepEqual([full.binding, full.slots], ['book ceiling', 0]);
  const heavy = capacityFor(Array(30).fill({ stage: 'Onboarding', band: 'At Risk' }), [{ taskType: 'save', ruleId: 'r5', dueAt: NOW }], D, NOW);
  assert.equal(heavy.binding, 'time');
  assert.ok(heavy.mix.onboarding > 0);
  // r13 tasks are already counted as cadence
  const r13 = capacityFor([], [{ taskType: 'checkin', ruleId: 'r13', dueAt: NOW }], D, NOW);
  assert.equal(r13.taskMins, 0);
});

test('coverage states the gap in full', async () => {
  await mkSeller('yassine');
  await mkSeller(null);
  const c = await coverage(D);
  assert.deepEqual([c.acceptedSellers, c.withManager, c.withoutManager, c.accountManagers], [2, 1, 1, 2]);
  assert.match(c.statement, /2 accepted sellers; 1 have a named account manager and 1 do not/);
});

// ───────────── configuration: simulate & publish (AC-23, AC-25) ─────────────

test('AC-23/AC-25: simulating an aggressive draft mutates nothing; publishing opens exactly what simulate predicted', async () => {
  for (let i = 0; i < 4; i++) await mkSeller('yassine', { lastOrderAt: ago(3) });
  await runAmSweep({ now: NOW });
  const snapshot = async () => JSON.stringify({
    tickets: await prisma.ticket.findMany({ orderBy: { id: 'asc' } }),
    sellers: await prisma.seller.findMany({ orderBy: { id: 'asc' } }),
    events: await prisma.eventLog.count(),
  });
  const before = await snapshot();
  await cfg.updateDraft({ 'am.inactiveDays': 2 }, { id: U.admin.id, role: 'ADMIN' });
  const sim = await cfg.simulate();
  assert.equal(sim.impacts.accountManagement.tasksOpened, 4);
  assert.ok(sim.impacts.accountManagement.hoursAdded > 0);
  assert.equal(await snapshot(), before);
  const pub = await cfg.publish({ actor: { id: U.admin.id, role: 'ADMIN' } });
  assert.equal(pub.effects.accountManagement.tasksOpened, sim.impacts.accountManagement.tasksOpened);
  assert.equal(await prisma.ticket.count({ where: { type: 'am_task', ruleId: 'r4' } }), 4);
});

test('AC-26: am_task carries counts_toward none', async () => {
  const s = await mkSeller('yassine', { lastOrderAt: ago(9) });
  await runAmSweep({ now: NOW });
  const view = (await call('GET', `/api/am/sellers/${s.id}`, { token: await tok('yassine') })).body;
  assert.ok(view.tasks.length && view.tasks.every((t) => t.countsToward === 'none'));
  assert.equal(view.tasks[0].escalation.escalatesTo, 'Save campaign at saveDays; Admin notified');
});
