// What the Administrator controls about the MDM pull, from the Integrations page (asked by the
// client on 4 Nov 2026):
//   • which merchants and which people come in from MDM, by the date MDM recorded for them — a
//     seller's registration (createdAt) and a person's creation on MDM (createdAt): every one,
//     recent ones (the last N days), old ones (before a date) or a custom range;
//   • stopping a sync while it runs, which also pauses the automatic sync until it is resumed.
// The setting lives in one AppSetting row (key mdm.sync); every change is written to the audit log.
//
// A range decides what is BROUGHT IN. Merchants and people already here keep being updated by the
// sync whatever the range, so a seller in a book never goes stale because the range moved. A new
// sellers range makes the next run read MDM from the beginning (sellers that did not change since
// the last run would otherwise never be looked at again).
import { prisma } from '../db.js';
import { badRequest } from '../http/errors.js';
import { logEvent } from '../services/audit.js';
import { normalizePhone } from '../core/contacts.js';
import { marketCode } from './mdm-api.js';
import { countryFromPhone } from './phone.js';

const KEY = 'mdm.sync';
const DAY = 86_400_000;
export const RANGE_MODES = ['all', 'recent', 'old', 'custom'];
export const RECENT_DAYS = [7, 30, 60, 90, 180, 365];
const ALL = { mode: 'all' };
const DEFAULTS = { sellers: ALL, people: ALL, paused: false, pausedAt: null, pausedById: null, fullFrom: null, marketsRule: null };

const parse = (s) => { try { return JSON.parse(s) ?? {}; } catch { return {}; } };

export async function getSyncSettings(db = prisma) {
  const row = await db.appSetting.findUnique({ where: { key: KEY } });
  const v = row ? parse(row.value) : {};
  return { ...DEFAULTS, ...v, sellers: v.sellers ?? ALL, people: v.people ?? ALL, updatedAt: row?.updatedAt ?? null };
}

async function write(user, next, db) {
  const { updatedAt, ...value } = next;
  await db.appSetting.upsert({ where: { key: KEY }, update: { value: JSON.stringify(value), updatedById: user?.id ?? null },
    create: { key: KEY, value: JSON.stringify(value), updatedById: user?.id ?? null } });
  return getSyncSettings(db);
}

const dateOf = (v, what, label) => {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw badRequest(`${what} is not a date.`);
  // a year typed only in part (0002, 0020…) is a mistake, never a range anyone means
  if (d.getUTCFullYear() < 1999 || d.getUTCFullYear() > 2100) throw badRequest(`${label}: choose a date between the years 2000 and 2100.`);
  return d;
};

/** One range as sent by the page → its stored form, or a 400 that says what is wrong. */
export function validRange(r, label) {
  const mode = r?.mode ?? 'all';
  if (!RANGE_MODES.includes(mode)) throw badRequest(`${label}: choose all, recent, old or custom dates.`);
  if (mode === 'all') return { mode };
  if (mode === 'recent') {
    const days = Number(r.days);
    if (!Number.isInteger(days) || days < 1 || days > 3650) throw badRequest(`${label}: the number of days must be between 1 and 3650.`);
    return { mode, days };
  }
  if (mode === 'old') {
    const before = dateOf(r.before, `${label}: "before"`, label);
    if (!before) throw badRequest(`${label}: choose the date the old ones were registered before.`);
    return { mode, before: before.toISOString() };
  }
  const from = dateOf(r.from, `${label}: "from"`, label); const to = dateOf(r.to, `${label}: "to"`, label);
  if (!from && !to) throw badRequest(`${label}: choose a start date, an end date, or both.`);
  if (from && to && from > to) throw badRequest(`${label}: the start of the range is after its end.`);
  return { mode, from: from?.toISOString() ?? null, to: to?.toISOString() ?? null };
}

/** The instants a range covers at `now`: start included, end included (old: before the date). */
export function rangeBounds(r, now = new Date()) {
  if (!r || r.mode === 'all') return { start: null, end: null, endExclusive: false };
  if (r.mode === 'recent') return { start: new Date(now.getTime() - r.days * DAY), end: null, endExclusive: false };
  if (r.mode === 'old') return { start: null, end: new Date(r.before), endExclusive: true };
  return { start: r.from ? new Date(r.from) : null, end: r.to ? new Date(r.to) : null, endExclusive: false };
}

/** True when a date MDM recorded falls in the range. No date on MDM → only "all" lets it in. */
export function inRange(date, r, now = new Date()) {
  if (!r || r.mode === 'all') return true;
  const d = date instanceof Date ? date : date ? new Date(date) : null;
  if (!d || Number.isNaN(d.getTime())) return false;
  const { start, end, endExclusive } = rangeBounds(r, now);
  if (start && d < start) return false;
  if (end && (endExclusive ? d >= end : d > end)) return false;
  return true;
}

const same = (a, b) => JSON.stringify(a ?? ALL) === JSON.stringify(b ?? ALL);

/**
 * { sellers?, people? } — the ranges to use from the next run on. A changed sellers range makes the
 * next run a full one. One audit entry with the ranges before and after.
 */
export async function saveRanges(user, body = {}, db = prisma) {
  const before = await getSyncSettings(db);
  const sellers = body.sellers !== undefined ? validRange(body.sellers, 'Sellers') : before.sellers;
  const people = body.people !== undefined ? validRange(body.people, 'People on MDM') : before.people;
  if (same(sellers, before.sellers) && same(people, before.people)) return { ...before, changed: false, fullNextRun: false };
  const now = new Date();
  const next = { ...before, sellers, people, ...(same(sellers, before.sellers) ? {} : { fullFrom: now.toISOString() }) };
  const saved = await write(user, next, db);
  await logEvent({ actorId: user?.id ?? null, entityType: 'system', entityId: 'mdm.sync', action: 'mdm.sync_range_changed',
    before: { sellers: before.sellers, people: before.people }, after: { sellers, people, fullNextRun: !same(sellers, before.sellers) } }, db);
  return { ...saved, changed: true, fullNextRun: !same(sellers, before.sellers) };
}

/** Pause (or resume) the automatic sync. A manual Sync now / Full resync still runs once. */
export async function setPaused(user, paused, { reason = null } = {}, db = prisma) {
  const before = await getSyncSettings(db);
  if (!!before.paused === !!paused) return before;
  const saved = await write(user, { ...before, paused: !!paused, pausedAt: paused ? new Date().toISOString() : null, pausedById: paused ? user?.id ?? null : null }, db);
  await logEvent({ actorId: user?.id ?? null, entityType: 'system', entityId: 'mdm.sync', action: paused ? 'mdm.sync_paused' : 'mdm.sync_resumed', reason }, db);
  return saved;
}

/** The next run reads MDM from the beginning (after a new sellers range, or after everything was deleted). */
export async function fullNextRun(user, db = prisma) {
  return write(user, { ...(await getSyncSettings(db)), fullFrom: new Date().toISOString() }, db);
}

// ───────── stopping a run in progress (one process runs the sync, so this lives in memory) ─────────
let stop = null; // { at, byId, byName }: asked while a run is in progress; it stops before its next record

export const requestStop = (user) => { stop = { at: new Date().toISOString(), byId: user?.id ?? null, byName: user?.name ?? null }; return stop; };
export const stopRequest = () => stop;
export const clearStop = () => { stop = null; };

/** Thrown inside a run when an Admin pressed Stop sync; the run is then recorded as stopped. */
export class SyncStopped extends Error {
  constructor(by) { super('Stopped by an Administrator.'); this.by = by; }
}

// ───────── only sellers who sell into Libya, Iraq or Lebanon (asked by the client on 5 Nov 2026) ─────────
// "Sync only clients of Libya / Iraq / Lebanon": a seller comes in when MDM lists one of the three
// for it, where it sells (Seller.countries) or its own country, wherever it lives. A seller whose
// market is Algeria, or any other country, is left out: not brought in, not put on the Skipped list,
// not recorded. Stores whose country is Algeria (or any other country outside the three), and the
// fees MDM charges a seller in such a country, are not recorded either. Merchants already here keep
// being updated, as with the date range.
export const MARKETS = ['LY', 'IQ', 'LB'];

/** The seller's market as the import reads it (mdm.js upsertFromMdm): its MDM countries, else its phone. */
export function sellerMarket(row) {
  const fromCountry = marketCode(row?.country ?? row?.market);
  if (fromCountry) return fromCountry;
  try { return row?.phone ? countryFromPhone(normalizePhone(row.phone)) : null; } catch { return null; }
}
/**
 * True when the seller's market is known and is not Libya, Iraq or Lebanon: the markets rule leaves it
 * out. A seller whose market cannot be told (no country on MDM, no usable phone) is not decided by this
 * rule; the import handles it as before (the Skipped list, reason "phone").
 */
export const outsideMarkets = (row) => { const m = sellerMarket(row); return !!m && !MARKETS.includes(m); };

/**
 * A store's country as MDM gives it (Seller.stores: a string; Store: CountryDto {id, name, code}):
 * a country code decides at once; otherwise its id, named through `keepCountry`. No country: kept.
 */
async function storeCountryOk(country, keepCountry) {
  const c = country && typeof country === 'object' ? country : { code: country };
  if (c.code && /^[A-Za-z]{2,3}$/.test(String(c.code).trim())) return MARKETS.includes(marketCode(c.code)); // a country code
  const id = c.id ?? c.code; // otherwise MDM's country id
  return !id || keepCountry(String(id));
}

/** A store is recorded when its country (MDM's code, or its id as learnt from the sellers) is one of the three, or unknown. */
export const storeInMarkets = (st, db = prisma) => storeCountryOk(st?.country, countryKeeper([], db));

/** For the fees MDM charges per country: true for Libya, Iraq, Lebanon, or a country the sync cannot name yet. */
export function countryKeeper(places, db = prisma) {
  const byId = new Map((places ?? []).filter((p) => p?.id).map((p) => [String(p.id), p.code]));
  return async (countryId) => {
    const code = byId.get(String(countryId)) ?? (await db.mdmCountry.findUnique({ where: { id: String(countryId) } }).catch(() => null))?.code ?? null;
    return !code || MARKETS.includes(marketCode(code));
  };
}

/**
 * The seller as MDM sends it, to be recorded: its stores (Seller.stores) and per-country services
 * (servicesByCountry) outside the three markets are taken out. A store's country may come as a code
 * or as an id; an id the sync cannot name yet is kept.
 */
export async function sellerForRecord(raw, keepCountry) {
  if (!raw || typeof raw !== 'object') return raw;
  const out = { ...raw };
  if (Array.isArray(raw.stores)) { out.stores = []; for (const st of raw.stores) if (await storeCountryOk(st?.country, keepCountry)) out.stores.push(st); }
  if (Array.isArray(raw.servicesByCountry)) { out.servicesByCountry = []; for (const x of raw.servicesByCountry) if (!x?.countryId || await keepCountry(String(x.countryId))) out.servicesByCountry.push(x); }
  return out;
}

/**
 * A seller in the three markets that this run does not record (outside the sellers date range): what
 * earlier runs kept of it for other countries goes, so its seller record keeps only the three markets
 * and its fees outside them are removed. Its stores are handled by the store pass.
 */
export async function trimOtherCountries(ref, keepCountry, db = prisma) {
  if (!ref) return 0;
  let n = 0;
  const rec = await db.mdmRecord.findUnique({ where: { kind_mdmRef: { kind: 'seller', mdmRef: String(ref) } } });
  if (rec) {
    let data = null; try { data = JSON.parse(rec.data); } catch { /* not JSON: left as it is */ }
    const trimmed = data && await sellerForRecord(data, keepCountry);
    if (trimmed && JSON.stringify(trimmed) !== JSON.stringify(data)) { await db.mdmRecord.update({ where: { id: rec.id }, data: { data: JSON.stringify(trimmed) } }); n++; }
  }
  for (const f of await db.mdmRecord.findMany({ where: { kind: 'service_fees', sellerRef: String(ref) }, select: { id: true, mdmRef: true } })) {
    const countryId = f.mdmRef.slice(String(ref).length + 1);
    if (countryId && !(await keepCountry(countryId))) { await db.mdmRecord.delete({ where: { id: f.id } }); n++; }
  }
  return n;
}

/** A seller left out by the markets rule keeps nothing here: its MDM records from earlier runs go, and so do its rows still waiting on the Skipped list. */
export async function forgetSeller(ref, db = prisma) {
  if (!ref) return { records: 0, skipped: 0 };
  const records = (await db.mdmRecord.deleteMany({ where: { OR: [{ kind: 'seller', mdmRef: String(ref) }, { sellerRef: String(ref) }] } })).count;
  const skipped = (await db.mdmSkipped.deleteMany({ where: { mdmRef: String(ref), decision: null } })).count;
  return { records, skipped };
}

/**
 * The first run under the markets rule reads MDM from the beginning, so every seller, store and fee
 * that earlier runs kept for another market is read again and removed. Once, recorded in mdm.sync.
 */
export async function marketsRuleOnce(settings, db = prisma) {
  if (settings.marketsRule) return settings;
  const saved = await write(null, { ...settings, marketsRule: 1, fullFrom: new Date().toISOString() }, db);
  await logEvent({ actorId: null, entityType: 'system', entityId: 'mdm.sync', action: 'mdm.sync_markets_rule',
    after: { markets: MARKETS, fullNextRun: true }, reason: 'Only sellers who sell into Libya, Iraq or Lebanon are synced (client, 5 Nov 2026).' }, db);
  return saved;
}

/** Waiting rows of the Skipped list for a market outside the three: those sellers are no longer synced. */
export async function clearMarketSkips(db = prisma) {
  return (await db.mdmSkipped.deleteMany({ where: { decision: null, reasonCode: 'market' } })).count;
}
