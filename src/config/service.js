// Versioned configuration: draft → simulate → publish → (roll back).
// AM Part 11, OA Part 13.4, AC-22..25, AC-OA-21.
//
//  - The live configuration is the snapshot of the latest ConfigVersion. Nothing reads the draft
//    except simulate; the live engines never evaluate a draft.
//  - Publish writes a FULL snapshot (never a patch) plus the diff, actor, timestamp and note,
//    then fires the publish listeners (the rule sweeps) immediately.
//  - Rollback is itself a publish: a new version whose snapshot equals the target's exactly.
//  - Simulate runs inside a database transaction that is always rolled back, so a simulator may
//    call the real rule engine with the proposed config and still mutate nothing (AC-23).
import { prisma } from '../db.js';
import { logEvent } from '../services/audit.js';
import { PARAMETER_MAP, defaultValues } from './parameters.js';
import { validateValue, validateConfig } from './validate.js';

const DRAFT_ID = 'draft';

export class ConfigError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

// ─────────────────────────── permissions ───────────────────────────
// Owner column of Appendix D → user roles. manage_automation is granted to MANAGER by default
// (roles & grants arrive with step 3; ADMIN can change everything).
const OWNER_ROLES = {
  Manager: ['MANAGER', 'ADMIN'],
  manage_automation: ['MANAGER', 'ADMIN'],
  Administrator: ['ADMIN'],
  Admin: ['ADMIN'],
};

export function canEdit(role, key) {
  if (role === 'SYSTEM') return true;
  const def = PARAMETER_MAP[key];
  return !!def && (OWNER_ROLES[def.owner] ?? []).includes(role);
}

function assertActor(actor) {
  if (!actor || !actor.role) throw new ConfigError('no_actor', 'A configuration change needs an actor.', 401);
}

function assertCanEdit(actor, keys) {
  const refused = keys.filter((k) => PARAMETER_MAP[k] && !canEdit(actor.role, k));
  if (refused.length) {
    throw new ConfigError('forbidden',
      `Your role (${actor.role}) may not change: ${refused.map((k) => `${k} (owner: ${PARAMETER_MAP[k].owner})`).join(', ')}.`,
      403, { keys: refused });
  }
}

const actorIdOf = (actor) => (actor.role === 'SYSTEM' ? null : actor.id ?? null);

// ─────────────────────────── hooks ───────────────────────────
const simulators = new Map(); // name → async ({ db, live, proposed, changes }) => result
const publishListeners = new Map(); // name → async ({ db, config, version, previous }) => result

/** Register an impact simulator (e.g. AM band movement, next-sweep task count). Returns an unregister fn. */
export function registerSimulator(name, fn) {
  simulators.set(name, fn);
  return () => simulators.delete(name);
}

/** Register a side effect of publish/rollback (e.g. the immediate rule sweep, AC-25). Returns an unregister fn. */
export function onPublish(name, fn) {
  publishListeners.set(name, fn);
  return () => publishListeners.delete(name);
}

// ─────────────────────────── helpers ───────────────────────────
const sortKeys = (obj) => Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));

function computeDiff(before, after) {
  const diff = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!Object.is(before[key], after[key])) diff[key] = { before: before[key] ?? null, after: after[key] ?? null };
  }
  return sortKeys(diff);
}

/** Read a stored snapshot for use: keys added to the registry since it was written take their default. */
function hydrate(snapshot) {
  const values = defaultValues();
  for (const [k, v] of Object.entries(snapshot)) if (k in values) values[k] = v;
  return values;
}

async function latestVersion(db) {
  const v = await db.configVersion.findFirst({ orderBy: { id: 'desc' } });
  if (!v) throw new ConfigError('not_seeded', 'No configuration has been published. Run the seed (npm run db:seed).', 503);
  return v;
}

async function readDraft(db) {
  const row = await db.configDraft.findUnique({ where: { id: DRAFT_ID } });
  return { changes: row ? JSON.parse(row.changes) : {}, authorId: row?.authorId ?? null, updatedAt: row?.updatedAt ?? null };
}

function versionView(v) {
  return { version: v.id, createdAt: v.createdAt, authorId: v.authorId, note: v.note, diff: JSON.parse(v.diff) };
}

// ─────────────────────────── live configuration ───────────────────────────

/** The live configuration: { version, values } with values frozen. */
export async function getLiveConfig(db = prisma) {
  const v = await latestVersion(db);
  return { version: v.id, publishedAt: v.createdAt, values: Object.freeze(hydrate(JSON.parse(v.snapshot))) };
}

/** Convenience for engines: one live value. */
export async function getValue(key, db = prisma) {
  if (!PARAMETER_MAP[key]) throw new ConfigError('unknown_key', `Unknown configuration parameter "${key}".`, 404);
  return (await getLiveConfig(db)).values[key];
}

// ─────────────────────────── seed ───────────────────────────

/** Write v1 from the Appendix D defaults. Idempotent: does nothing once any version exists. */
export async function seedDefaults(db = prisma) {
  return db.$transaction(async (tx) => {
    const existing = await tx.configVersion.findFirst({ orderBy: { id: 'desc' } });
    if (existing) return { created: false, version: existing.id };
    const snapshot = defaultValues();
    const errors = validateConfig(snapshot);
    if (errors.length) throw new ConfigError('invalid_defaults', 'The launch defaults do not validate.', 500, errors);
    const v = await tx.configVersion.create({
      data: { authorId: null, note: 'Launch defaults (Appendix D, OA + AM)', diff: '{}', snapshot: JSON.stringify(snapshot) },
    });
    await logEvent({ entityType: 'config', entityId: v.id, action: 'config.seed', after: { version: v.id, keys: Object.keys(snapshot).length } }, tx);
    return { created: true, version: v.id };
  });
}

// ─────────────────────────── draft ───────────────────────────

/** The pending draft: every changed parameter with its live and draft value (AM 11.2). */
export async function getDraft(db = prisma) {
  const [live, draft] = await Promise.all([getLiveConfig(db), readDraft(db)]);
  const entries = Object.entries(draft.changes).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({
    key, label: PARAMETER_MAP[key]?.label ?? key, unit: PARAMETER_MAP[key]?.unit ?? null, live: live.values[key], draft: value,
  }));
  return { baseVersion: live.version, authorId: draft.authorId, updatedAt: draft.updatedAt, changes: draft.changes, entries };
}

/**
 * Merge values into the draft. A value equal to the live value removes that key from the draft.
 * Per-key type and bounds are checked here; cross-field gates (weights = 100 …) at simulate/publish.
 */
export async function updateDraft(changes, actor, db = prisma) {
  assertActor(actor);
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    throw new ConfigError('bad_request', 'Draft changes must be an object of { key: value }.');
  }
  const keys = Object.keys(changes);
  const errors = keys.map((k) => ({ key: k, message: validateValue(k, changes[k]) })).filter((e) => e.message);
  if (errors.length) throw new ConfigError('invalid_value', errors.map((e) => e.message).join(' '), 400, errors);
  assertCanEdit(actor, keys);

  await db.$transaction(async (tx) => {
    const live = await getLiveConfig(tx);
    const draft = await readDraft(tx);
    const next = { ...draft.changes };
    for (const k of keys) {
      if (Object.is(live.values[k], changes[k])) delete next[k];
      else next[k] = changes[k];
    }
    await tx.configDraft.upsert({
      where: { id: DRAFT_ID },
      create: { id: DRAFT_ID, changes: JSON.stringify(sortKeys(next)), authorId: actorIdOf(actor) },
      update: { changes: JSON.stringify(sortKeys(next)), authorId: actorIdOf(actor) },
    });
  });
  return getDraft(db);
}

/** Discard the draft whole. */
export async function discardDraft(actor, db = prisma) {
  assertActor(actor);
  await db.configDraft.deleteMany({ where: { id: DRAFT_ID } });
  return getDraft(db);
}

// ─────────────────────────── simulate ───────────────────────────

class SimulationRollback extends Error {
  constructor(result) { super('simulation rollback'); this.result = result; }
}

/**
 * Evaluate the draft (or explicit `changes`) without changing anything.
 * Returns the diff, the publish gate result, and every registered simulator's impact.
 * Runs inside a transaction that is always rolled back (AC-23).
 */
export async function simulate({ changes } = {}, db = prisma) {
  try {
    await db.$transaction(async (tx) => {
      const live = await getLiveConfig(tx);
      const pending = changes ?? (await readDraft(tx)).changes;
      const valueErrors = Object.entries(pending)
        .map(([k, v]) => ({ key: k, code: 'invalid', message: validateValue(k, v) })).filter((e) => e.message);
      const proposed = Object.freeze({ ...live.values, ...pending });
      const errors = valueErrors.length ? valueErrors : validateConfig(proposed);
      const diff = computeDiff(live.values, proposed);

      const impacts = {};
      if (!errors.length) {
        for (const [name, fn] of simulators) {
          try {
            impacts[name] = await fn({ db: tx, live: live.values, proposed, changes: pending });
          } catch (err) {
            impacts[name] = { error: err.message };
          }
        }
      }
      throw new SimulationRollback({ baseVersion: live.version, diff, publishable: errors.length === 0 && Object.keys(diff).length > 0, errors, impacts });
    }, { timeout: 120_000 });
  } catch (err) {
    if (err instanceof SimulationRollback) return err.result;
    throw err;
  }
  throw new Error('unreachable: simulation transaction committed');
}

// ─────────────────────────── publish / rollback ───────────────────────────

async function runPublishListeners(config, version, previous) {
  const effects = {};
  for (const [name, fn] of publishListeners) {
    try {
      effects[name] = await fn({ db: prisma, config, version, previous });
    } catch (err) {
      effects[name] = { error: err.message };
      await logEvent({ entityType: 'config', entityId: version, action: 'config.publish_effect_failed', reason: `${name}: ${err.message}` });
    }
  }
  return effects;
}

/**
 * Publish the draft as a new version.
 * @param {{ actor: {id?: string, role: string}, note?: string, expectedVersion?: number }} opts
 *   expectedVersion — refuse if someone else published since the caller last looked.
 */
export async function publish({ actor, note, expectedVersion } = {}, db = prisma) {
  assertActor(actor);
  const result = await db.$transaction(async (tx) => {
    const live = await getLiveConfig(tx);
    if (expectedVersion != null && expectedVersion !== live.version) {
      throw new ConfigError('stale', `Configuration is at v${live.version}, not v${expectedVersion}. Review the latest version and publish again.`, 409);
    }
    const { changes } = await readDraft(tx);
    const snapshot = sortKeys({ ...live.values, ...changes });
    const diff = computeDiff(live.values, snapshot);
    if (!Object.keys(diff).length) throw new ConfigError('empty_draft', 'Nothing to publish: the draft has no changes.', 409);
    assertCanEdit(actor, Object.keys(diff));

    const errors = validateConfig(snapshot);
    if (errors.length) throw new ConfigError('publish_refused', errors.map((e) => e.message).join(' '), 422, errors);

    const v = await tx.configVersion.create({
      data: { authorId: actorIdOf(actor), note: note ?? null, diff: JSON.stringify(diff), snapshot: JSON.stringify(snapshot) },
    });
    await tx.configDraft.deleteMany({ where: { id: DRAFT_ID } });
    await logEvent({
      actorId: actorIdOf(actor), entityType: 'config', entityId: v.id, action: 'config.publish',
      before: { version: live.version }, after: { version: v.id, diff }, reason: note,
    }, tx);
    return { version: v.id, previous: live.version, diff, snapshot };
  });

  const effects = await runPublishListeners(Object.freeze(hydrate(result.snapshot)), result.version, result.previous);
  return { version: result.version, previous: result.previous, diff: result.diff, effects };
}

/**
 * Roll back to a published version: a new version whose snapshot equals the target's exactly
 * (every key, including keys the target did not itself change — AC-24 / AC-OA-21).
 */
export async function rollback({ actor, targetVersion, note } = {}, db = prisma) {
  assertActor(actor);
  const result = await db.$transaction(async (tx) => {
    const target = await tx.configVersion.findUnique({ where: { id: Number(targetVersion) } });
    if (!target) throw new ConfigError('not_found', `Version v${targetVersion} does not exist.`, 404);
    const live = await getLiveConfig(tx);
    const targetSnapshot = JSON.parse(target.snapshot);
    const diff = computeDiff(live.values, hydrate(targetSnapshot));
    if (!Object.keys(diff).length) throw new ConfigError('no_change', `The live configuration already equals v${target.id}.`, 409);
    assertCanEdit(actor, Object.keys(diff));

    const text = `Rollback to v${target.id}${note ? ` — ${note}` : ''}`;
    const v = await tx.configVersion.create({
      data: { authorId: actorIdOf(actor), note: text, diff: JSON.stringify(diff), snapshot: target.snapshot },
    });
    await logEvent({
      actorId: actorIdOf(actor), entityType: 'config', entityId: v.id, action: 'config.rollback',
      before: { version: live.version }, after: { version: v.id, restoredFrom: target.id, diff }, reason: note,
    }, tx);
    return { version: v.id, previous: live.version, restoredFrom: target.id, diff, snapshot: targetSnapshot };
  });

  const effects = await runPublishListeners(Object.freeze(hydrate(result.snapshot)), result.version, result.previous);
  return { version: result.version, previous: result.previous, restoredFrom: result.restoredFrom, diff: result.diff, effects };
}

// ─────────────────────────── history ───────────────────────────

export async function listVersions({ limit = 50 } = {}, db = prisma) {
  const rows = await db.configVersion.findMany({ orderBy: { id: 'desc' }, take: limit });
  const liveId = rows[0]?.id;
  return rows.map((v) => ({ ...versionView(v), live: v.id === liveId }));
}

export async function getVersion(version, db = prisma) {
  const v = await db.configVersion.findUnique({ where: { id: Number(version) } });
  if (!v) throw new ConfigError('not_found', `Version v${version} does not exist.`, 404);
  return { ...versionView(v), snapshot: JSON.parse(v.snapshot) };
}
