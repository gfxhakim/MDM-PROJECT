// Configuration service — AC-22, AC-23, AC-24, AC-25 (AM Part 14.7) and AC-OA-21.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTestDatabase } from './helpers/db.js';

useTestDatabase('config');
const { prisma } = await import('../src/db.js');
const cfg = await import('../src/config/service.js');
const { PARAMETERS, defaultValues } = await import('../src/config/parameters.js');

const ADMIN = { id: 'u-admin', role: 'ADMIN' };
const MANAGER = { id: 'u-mgr', role: 'MANAGER' };
const AGENT = { id: 'u-oa', role: 'OA_AGENT' };

async function reset() {
  await prisma.eventLog.deleteMany();
  await prisma.configDraft.deleteMany();
  await prisma.configVersion.deleteMany();
  await prisma.$executeRawUnsafe("DELETE FROM sqlite_sequence WHERE name = 'ConfigVersion'");
  await cfg.seedDefaults();
}

before(reset);
beforeEach(reset);
after(() => prisma.$disconnect());

async function publishChanges(changes, actor = ADMIN, note) {
  await cfg.updateDraft(changes, actor);
  return cfg.publish({ actor, note });
}

// ───────────── seed ─────────────

test('seed writes v1 with every Appendix D parameter from both specs at its default', async () => {
  const live = await cfg.getLiveConfig();
  assert.equal(live.version, 1);
  assert.deepEqual({ ...live.values }, defaultValues());
  // spot-check the numbers CLAUDE.md calls out
  const v = live.values;
  assert.equal(v['oa.no_answer_max'], 5);
  assert.equal(v['oa.no_answer_gap'], 1);
  assert.equal(v['oa.quiet_max'], 3);
  assert.equal(v['oa.quiet_gap'], 3);
  assert.equal(v['oa.max_open_leads'], 12);
  assert.equal(v['oa.template_per_contact_cap'], 8);
  assert.equal(v['oa.rule.r9.enabled'], false);
  assert.equal(v['am.engagementLive'], false);
  assert.equal(v['am.welcomeCallH'], 24);
  assert.equal(v['am.maxBook'], 50);
  assert.equal(v['am.rule.r11.enabled'], false);
  assert.equal(v['am.rule.r12.enabled'], false);
  assert.deepEqual([v['am.inactiveDays'], v['am.saveDays'], v['am.churnDays']], [7, 14, 30]);
  assert.ok(PARAMETERS.filter((p) => p.key.startsWith('oa.')).length >= 34);
  assert.ok(PARAMETERS.filter((p) => p.key.startsWith('am.')).length >= 50);
});

test('seed is idempotent', async () => {
  const again = await cfg.seedDefaults();
  assert.equal(again.created, false);
  assert.equal(await prisma.configVersion.count(), 1);
});

// ───────────── draft ─────────────

test('draft does not change the live configuration and lists before/after per parameter', async () => {
  const d = await cfg.updateDraft({ 'oa.no_answer_max': 4, 'am.inactiveDays': 5 }, ADMIN);
  assert.deepEqual(d.entries.map((e) => [e.key, e.live, e.draft]), [
    ['am.inactiveDays', 7, 5],
    ['oa.no_answer_max', 5, 4],
  ]);
  assert.equal((await cfg.getLiveConfig()).values['oa.no_answer_max'], 5);
});

test('setting a draft value back to the live value removes it; discard clears the draft', async () => {
  await cfg.updateDraft({ 'oa.quiet_max': 2, 'oa.quiet_gap': 4 }, ADMIN);
  let d = await cfg.updateDraft({ 'oa.quiet_max': 3 }, ADMIN);
  assert.deepEqual(Object.keys(d.changes), ['oa.quiet_gap']);
  d = await cfg.discardDraft(ADMIN);
  assert.deepEqual(d.changes, {});
});

test('draft rejects unknown keys, wrong types and out-of-range values', async () => {
  await assert.rejects(cfg.updateDraft({ 'oa.nope': 1 }, ADMIN), { code: 'invalid_value' });
  await assert.rejects(cfg.updateDraft({ 'oa.no_answer_max': '5' }, ADMIN), { code: 'invalid_value' });
  await assert.rejects(cfg.updateDraft({ 'oa.no_answer_max': 2.5 }, ADMIN), { code: 'invalid_value' });
  await assert.rejects(cfg.updateDraft({ 'am.wActivity': 101 }, ADMIN), { code: 'invalid_value' });
  await assert.rejects(cfg.updateDraft({ 'am.engagementLive': 1 }, ADMIN), { code: 'invalid_value' });
});

test('permissions follow the Appendix D owner column, server-side', async () => {
  await assert.rejects(cfg.updateDraft({ 'oa.no_answer_max': 4 }, AGENT), { code: 'forbidden', status: 403 });
  await assert.rejects(cfg.updateDraft({ 'am.wActivity': 35 }, MANAGER), { code: 'forbidden' }); // AM owner: Admin
  await assert.rejects(cfg.updateDraft({ 'oa.marketing_templates': 'prohibited' }, MANAGER), { code: 'forbidden' });
  await cfg.updateDraft({ 'oa.no_answer_max': 4, 'oa.holding_sweep_interval': 10 }, MANAGER); // Manager + manage_automation
  // a manager cannot publish a draft that an admin extended with AM keys
  await cfg.updateDraft({ 'am.maxBook': 45 }, ADMIN);
  await assert.rejects(cfg.publish({ actor: MANAGER }), { code: 'forbidden' });
  await assert.rejects(cfg.updateDraft({ 'oa.no_answer_max': 4 }, null), { code: 'no_actor' });
});

// ───────────── AC-22: weights gate ─────────────

test('AC-22 publish is refused when health weights do not total 100, and the refusal names the total', async () => {
  await cfg.updateDraft({ 'am.wActivity': 35 }, ADMIN);
  await assert.rejects(cfg.publish({ actor: ADMIN }), (err) => {
    assert.equal(err.code, 'publish_refused');
    assert.match(err.message, /total 105/);
    assert.equal(err.details.find((e) => e.code === 'health_weights_total').total, 105);
    return true;
  });
  assert.equal((await cfg.getLiveConfig()).version, 1);
  // a rebalanced draft publishes
  await cfg.updateDraft({ 'am.wGrowth': 5 }, ADMIN);
  const res = await cfg.publish({ actor: ADMIN });
  assert.equal(res.version, 2);
});

test('cross-field gates: band ceilings and inactivity floor steps must ascend', async () => {
  await cfg.updateDraft({ 'am.bandHealthy': 85 }, ADMIN);
  await assert.rejects(cfg.publish({ actor: ADMIN }), { code: 'publish_refused' });
  await cfg.discardDraft(ADMIN);
  await cfg.updateDraft({ 'am.saveDays': 40 }, ADMIN);
  await assert.rejects(cfg.publish({ actor: ADMIN }), { code: 'publish_refused' });
});

test('publishing an empty draft is refused', async () => {
  await assert.rejects(cfg.publish({ actor: ADMIN }), { code: 'empty_draft' });
});

// ───────────── publish ─────────────

test('publish writes a full snapshot, the diff, actor and note, clears the draft and audits once', async () => {
  const res = await publishChanges({ 'oa.no_answer_max': 4 }, ADMIN, 'Try four attempts');
  assert.deepEqual(res.diff, { 'oa.no_answer_max': { before: 5, after: 4 } });
  const v = await cfg.getVersion(res.version);
  assert.equal(v.note, 'Try four attempts');
  assert.equal(v.authorId, ADMIN.id);
  assert.deepEqual(v.snapshot, { ...defaultValues(), 'oa.no_answer_max': 4 }); // full, not a patch
  assert.deepEqual((await cfg.getDraft()).changes, {});
  const events = await prisma.eventLog.findMany({ where: { action: 'config.publish' } });
  assert.equal(events.length, 1);
  assert.equal(events[0].actorId, ADMIN.id);
  assert.deepEqual(JSON.parse(events[0].after).diff, res.diff);
});

test('publish with a stale expectedVersion is refused', async () => {
  await publishChanges({ 'oa.quiet_gap': 4 });
  await cfg.updateDraft({ 'oa.quiet_max': 2 }, ADMIN);
  await assert.rejects(cfg.publish({ actor: ADMIN, expectedVersion: 1 }), { code: 'stale', status: 409 });
  const ok = await cfg.publish({ actor: ADMIN, expectedVersion: 2 });
  assert.equal(ok.version, 3);
});

// ───────────── AC-24 / AC-OA-21: rollback is exact ─────────────

test('AC-24 rollback restores every key to the target snapshot, including keys it did not change', async () => {
  const v2 = await publishChanges({ 'oa.no_answer_max': 4 });
  await publishChanges({ 'am.inactiveDays': 5, 'oa.quiet_gap': 5 });
  const rb = await cfg.rollback({ actor: ADMIN, targetVersion: v2.version, note: 'too many tasks' });
  assert.equal(rb.restoredFrom, v2.version);
  const target = await cfg.getVersion(v2.version);
  const restored = await cfg.getVersion(rb.version);
  assert.deepEqual(restored.snapshot, target.snapshot);
  assert.deepEqual({ ...(await cfg.getLiveConfig()).values }, target.snapshot);
  assert.match(restored.note, /^Rollback to v2 — too many tasks$/);
  assert.equal(await prisma.eventLog.count({ where: { action: 'config.rollback' } }), 1);
});

test('AC-OA-21 publish two changes to different parameters, roll back to before both, both restored', async () => {
  await publishChanges({ 'oa.no_answer_max': 4 });
  await publishChanges({ 'oa.template_per_contact_cap': 6 });
  await cfg.rollback({ actor: ADMIN, targetVersion: 1 });
  const v = (await cfg.getLiveConfig()).values;
  assert.equal(v['oa.no_answer_max'], 5);
  assert.equal(v['oa.template_per_contact_cap'], 8);
  assert.deepEqual({ ...v }, defaultValues());
  // history is append-only: 1, 2, 3, rollback = 4
  assert.deepEqual((await cfg.listVersions()).map((x) => x.version), [4, 3, 2, 1]);
});

test('rollback to the live configuration or a missing version is refused', async () => {
  await assert.rejects(cfg.rollback({ actor: ADMIN, targetVersion: 1 }), { code: 'no_change' });
  await assert.rejects(cfg.rollback({ actor: ADMIN, targetVersion: 99 }), { code: 'not_found' });
});

// ───────────── AC-23: simulation mutates nothing ─────────────

async function fingerprint() {
  const [versions, draft, events, tickets, sellers] = await Promise.all([
    prisma.configVersion.findMany({ orderBy: { id: 'asc' } }),
    prisma.configDraft.findMany(),
    prisma.eventLog.findMany({ orderBy: { id: 'asc' } }),
    prisma.ticket.findMany({ orderBy: { id: 'asc' } }),
    prisma.seller.findMany({ orderBy: { id: 'asc' } }),
  ]);
  return JSON.stringify({ versions, draft, events, tickets, sellers });
}

test('AC-23 simulate mutates nothing, even when a simulator writes', async () => {
  const contact = await prisma.contact.create({ data: { name: 'Seller A', phone: '+218900000001', country: 'LY' } });
  await prisma.seller.create({ data: { mdmRef: 'MDM-S-0001', contactId: contact.id, market: 'LY' } });
  await cfg.updateDraft({ 'am.inactiveDays': 2, 'am.healthCritical': 90 }, ADMIN); // aggressive

  // A simulator that behaves like a real sweep: it writes tasks and touches the seller.
  const off = cfg.registerSimulator('sweep', async ({ db, proposed }) => {
    const sellers = await db.seller.findMany();
    for (const s of sellers) {
      await db.ticket.create({ data: { type: 'am_task', contactId: s.contactId, sellerId: s.id, status: 'open', taskType: 'checkin', why: `inactiveDays=${proposed['am.inactiveDays']}` } });
      await db.seller.update({ where: { id: s.id }, data: { healthScore: 10, lastContactAt: new Date() } });
    }
    return { tasksOpened: await db.ticket.count() };
  });
  try {
    const beforeFp = await fingerprint();
    const sim = await cfg.simulate();
    assert.equal(sim.publishable, true);
    assert.deepEqual(sim.impacts.sweep, { tasksOpened: 1 });
    assert.deepEqual(Object.keys(sim.diff), ['am.healthCritical', 'am.inactiveDays']);
    assert.equal(await fingerprint(), beforeFp);
    assert.equal(await prisma.ticket.count(), 0);
  } finally {
    off();
  }
});

test('simulate reports the publish gate without throwing', async () => {
  const sim = await cfg.simulate({ changes: { 'am.wActivity': 20 } });
  assert.equal(sim.publishable, false);
  assert.ok(sim.errors.some((e) => e.code === 'health_weights_total' && e.total === 90));
  assert.deepEqual(sim.impacts, {});
});

// ───────────── AC-25: publish triggers the sweep ─────────────

test('AC-25 publish and rollback fire the publish listeners immediately with the new config', async () => {
  const calls = [];
  const off = cfg.onPublish('sweep', async ({ config, version }) => {
    calls.push([version, config['am.inactiveDays']]);
    return { tasksOpened: 0 };
  });
  try {
    const res = await publishChanges({ 'am.inactiveDays': 5 });
    assert.deepEqual(res.effects, { sweep: { tasksOpened: 0 } });
    await cfg.rollback({ actor: ADMIN, targetVersion: 1 });
    assert.deepEqual(calls, [[2, 5], [3, 7]]);
  } finally {
    off();
  }
});

test('a failing publish listener does not undo the publish and is audited', async () => {
  const off = cfg.onPublish('boom', async () => { throw new Error('engine down'); });
  try {
    const res = await publishChanges({ 'oa.quiet_gap': 4 });
    assert.deepEqual(res.effects, { boom: { error: 'engine down' } });
    assert.equal((await cfg.getLiveConfig()).version, 2);
    assert.equal(await prisma.eventLog.count({ where: { action: 'config.publish_effect_failed' } }), 1);
  } finally {
    off();
  }
});

test('live values are frozen — engines cannot mutate configuration in memory', async () => {
  const { values } = await cfg.getLiveConfig();
  assert.throws(() => { 'use strict'; values['oa.no_answer_max'] = 99; }, TypeError);
});
