// Sellers the MDM pull could not place, kept aside for an Admin's decision ("Skipped sellers" on
// the Integrations page). The pull records every skip here with what the platform says about the
// seller; the Admin then places it in a book, opens it as an onboarding lead, or leaves it out.
//   • placing follows the import's path: contact + conversation + seller record, owner by AM 3.2
//     (same market, smallest book, no cross-market fallback) unless the Admin names a manager who
//     covers the market and has room; the platform figures are read by the next sync;
//   • opening a lead is capture rule r1 through the pull's own path (openPlatformLead), in the market the Admin chooses;
//   • a seller already here is only reported — a lead is activated in the onboarding console, so
//     the activation gate and the handoff record still apply;
//   • one audit entry per decision run with the full list and each item's result (OA 13.2);
//   • nothing here is written to MDM by this module (an assignment reaches MDM through the
//     write-back, like every other assignment).
import { prisma } from '../db.js';
import { badRequest } from '../http/errors.js';
import { normalizePhone } from '../core/contacts.js';
import { openPlatformLead } from './mdm.js';
import { platformPeople } from './mdm-staff.js';
import { logEvent } from '../services/audit.js';
import { getLiveConfig } from '../config/service.js';
import { createSellerRecord } from './sellers.js';

export const MARKETS = ['LY', 'IQ', 'LB'];
export const MARKET_NAMES = { LY: 'Libya', IQ: 'Iraq', LB: 'Lebanon' };
export const REASONS = {
  market: 'Market outside Libya, Iraq and Lebanon',
  phone: 'No valid phone number',
  rejected: 'Rejected on the platform',
  duplicate: 'Already here',
  phone_changed: 'Phone changed on MDM',
  stale: 'Old registration, never accepted',
  other: 'Other',
};
export const ACTIONS = ['place', 'lead', 'leave_out', 'reopen'];
export const MAX_ITEMS = 200; // the ceiling the other bulk runs use (OA 13.2: a maximum selection size)

const dateOr = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; };
const parse = (s, fallback) => { try { return JSON.parse(s) ?? fallback; } catch { return fallback; } };
const label = (d) => ({ placed: 'placed as a seller', lead: 'opened as a lead', left_out: 'left out', imported: 'imported by the sync' }[d] ?? d);
const suggestMarket = (h) => [h.country, ...parse(h.countries, [])].find((c) => MARKETS.includes(c)) ?? null;
const snapshot = (row) => ({
  mdmRef: row.mdmRef, name: row.name ?? null, phone: row.phone ?? null, country: row.country ?? null, countryId: row.countryId ?? null,
  places: row.places ?? [], joinStatus: row.joinStatus ?? null, joinStatusDate: row.joinStatusDate ?? null, createdAt: row.createdAt ?? null,
  updatedAt: row.updatedAt ?? null, utm: row.utm ?? null, accountManagerRef: row.accountManagerRef ?? null, accountManagerName: row.accountManagerName ?? null,
  responsibleRef: row.responsibleRef ?? null, responsibleName: row.responsibleName ?? null, history: row.history ?? [],
});

/** Refs the pull watches: a waiting or left-out seller that now imports by the normal rules is marked imported. */
export async function watchedRefs(db = prisma) {
  const rows = await db.mdmSkipped.findMany({ where: { OR: [{ decision: null }, { decision: 'left_out' }] }, select: { mdmRef: true } });
  return new Set(rows.map((r) => r.mdmRef));
}

/** The pull skipped this seller: keep its row, or refresh it with what the platform says now. */
export async function rememberSkipped(row, result, { runId = null, now = new Date() } = {}, db = prisma) {
  const mdmRef = String(row.mdmRef);
  const data = {
    reasonCode: REASONS[result.code] ? result.code : 'other', reason: String(result.reason ?? ''),
    name: row.name ?? null, phone: row.phone ?? null, country: row.country ?? null, countries: JSON.stringify(row.countries ?? []), countryId: row.countryId ?? null,
    joinStatus: row.joinStatus ?? null, joinStatusDate: dateOr(row.joinStatusDate), registeredAt: dateOr(row.createdAt), accountManagerRef: row.accountManagerRef ?? null,
    responsibleRef: row.responsibleRef ?? null, utm: row.utm ?? null, platform: JSON.stringify(snapshot(row)), lastSeenAt: now, runId,
  };
  const existing = await db.mdmSkipped.findUnique({ where: { mdmRef } });
  if (!existing) return db.mdmSkipped.create({ data: { mdmRef, firstSeenAt: now, ...data } });
  // A seller we placed or opened as a lead comes back as "already here" on every run: expected, the
  // decision stands. Any other reason means the record it produced is gone — back on the list.
  const reopen = !!existing.decision && existing.decision !== 'left_out' && data.reasonCode !== 'duplicate';
  return db.mdmSkipped.update({ where: { id: existing.id }, data: { ...data, seenCount: { increment: 1 },
    ...(reopen ? { decision: null, decidedById: null, decidedAt: null, decisionNote: null, outcome: '{}', figuresAt: null } : {}) } });
}

/** The pull brought this seller in by its own rules (e.g. the platform changed its country): close the row. */
export function markImported(mdmRef, action, { now = new Date() } = {}, db = prisma) {
  return db.mdmSkipped.updateMany({ where: { mdmRef: String(mdmRef), OR: [{ decision: null }, { decision: 'left_out' }] },
    data: { decision: 'imported', decidedAt: now, decidedById: null, outcome: JSON.stringify({ action }) } });
}

function view(h, users) {
  const platform = parse(h.platform, {});
  return {
    id: h.id, mdmRef: h.mdmRef, name: h.name, phone: h.phone, country: h.country, countries: parse(h.countries, []), places: platform.places ?? [],
    joinStatus: h.joinStatus, joinStatusDate: h.joinStatusDate, registeredAt: h.registeredAt, accountManagerRef: h.accountManagerRef, utm: h.utm,
    reasonCode: h.reasonCode, reasonLabel: REASONS[h.reasonCode] ?? REASONS.other, reason: h.reason,
    seenCount: h.seenCount, firstSeenAt: h.firstSeenAt, lastSeenAt: h.lastSeenAt,
    decision: h.decision, decidedAt: h.decidedAt, decidedBy: h.decidedById ? users.get(h.decidedById) ?? null : null, decisionNote: h.decisionNote,
    outcome: parse(h.outcome, {}), figuresAt: h.figuresAt,
    suggestedMarket: suggestMarket(h),
    // A disabled control states its reason: a seller already here has nothing to place.
    blocked: !h.decision && h.reasonCode === 'duplicate' ? h.reason : null,
  };
}

/**
 * The list for the page. decision: waiting (default) | placed | lead | left_out | imported | all.
 * Also returns the counts for the tabs and what the Admin needs to decide: markets, and each
 * account manager with their book against the ceiling (AM 12.4 shows that against each option).
 */
export async function listSkipped({ decision = 'waiting', reason = null, q = null, from = null, to = null } = {}, db = prisma) {
  const where = decision === 'all' ? {} : decision === 'waiting' ? { decision: null } : { decision: String(decision) };
  if (reason) where.reasonCode = String(reason);
  // the date the seller registered on MDM
  if (from || to) where.registeredAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
  const s = String(q ?? '').trim();
  if (s) where.OR = [{ mdmRef: { contains: s } }, { name: { contains: s } }, { phone: { contains: s } }];
  const [items, people, byReason, byDecision, { values: config }, ams] = await Promise.all([
    db.mdmSkipped.findMany({ where, orderBy: { lastSeenAt: 'desc' }, take: 2000 }),
    db.user.findMany({ select: { id: true, name: true } }),
    db.mdmSkipped.groupBy({ by: ['reasonCode'], where: { decision: null }, _count: { _all: true } }),
    db.mdmSkipped.groupBy({ by: ['decision'], _count: { _all: true } }),
    getLiveConfig(db),
    db.user.findMany({ where: { role: 'ACCOUNT_MANAGER', active: true }, orderBy: { name: 'asc' } }),
  ]);
  const users = new Map(people.map((u) => [u.id, u.name]));
  const counts = { waiting: 0, byReason: {}, placed: 0, lead: 0, left_out: 0, imported: 0 };
  for (const g of byReason) { counts.byReason[g.reasonCode] = g._count._all; counts.waiting += g._count._all; }
  for (const g of byDecision) if (g.decision) counts[g.decision] = g._count._all;
  const managers = await Promise.all(ams.map(async (u) => ({ id: u.id, name: u.name, markets: parse(u.markets, []), bookSize: await db.seller.count({ where: { assignedAccountManagerId: u.id } }) })));
  return { items: items.map((h) => view(h, users)), counts, markets: MARKETS.map((code) => ({ code, name: MARKET_NAMES[code] })), managers, maxBook: config['am.maxBook'], reasons: REASONS, limit: MAX_ITEMS };
}

/**
 * One decision run over the selected rows. Each row is handled on its own and reported on its own
 * (partial failure is reported honestly, never as success for the batch); one audit entry carries
 * the full list. Returns { batchId, action, requested, done, failed, results[] }.
 *   action: place (seller in a book) | lead (onboarding lead) | leave_out | reopen (a left-out row back on the list)
 *   market: LY | IQ | LB — needed when the platform names none of the three for the seller
 *   managerId: an account manager to place with; otherwise AM 3.2 picks (or r1, when accepted in the last 14 days)
 *   note: written reason — required for a bulk run and for leaving a seller out
 *   phone: a number to use when the platform has none (one seller at a time)
 */
export async function decideSkipped(user, { ids, action, market = null, managerId = null, note = null, phone = null } = {}, db = prisma) {
  if (!Array.isArray(ids) || !ids.length) throw badRequest('Select at least one seller.');
  if (ids.length > MAX_ITEMS) throw badRequest(`At most ${MAX_ITEMS} sellers per run.`);
  if (!ACTIONS.includes(action)) throw badRequest(`action must be one of ${ACTIONS.join(', ')}.`);
  if (market && !MARKETS.includes(market)) throw badRequest('market must be LY, IQ or LB.');
  const written = String(note ?? '').trim() || null;
  if (ids.length > 1 && !written) throw badRequest('A written note is required for a bulk run.');
  if (action === 'leave_out' && !written) throw badRequest('Say why this seller is left out.');
  if (phone && ids.length !== 1) throw badRequest('A phone number can be given for one seller at a time.');
  const { values: config } = await getLiveConfig(db);
  const managers = await db.user.findMany({ where: { role: 'ACCOUNT_MANAGER', active: true } });
  const named = managerId ? managers.find((m) => m.id === managerId) : null;
  if (managerId && !named) throw badRequest('That account manager does not exist or is not active.');

  const unique = [...new Set(ids.map(String))];
  const rows = new Map((await db.mdmSkipped.findMany({ where: { id: { in: unique } } })).map((h) => [h.id, h]));
  const now = new Date();
  const results = [];
  for (const id of unique) {
    const h = rows.get(id);
    const out = { id, mdmRef: h?.mdmRef ?? null, name: h?.name ?? null, ok: false };
    results.push(out);
    if (!h) { out.reason = 'Not in the list any more.'; continue; }
    try {
      if (action === 'reopen') {
        if (h.decision !== 'left_out') { out.reason = h.decision ? `Already ${label(h.decision)} — nothing to put back.` : 'Already waiting.'; continue; }
        await db.mdmSkipped.update({ where: { id }, data: { decision: null, decidedById: null, decidedAt: null, decisionNote: written, outcome: '{}' } });
        out.ok = true; out.outcome = 'Back on the list.'; continue;
      }
      if (h.decision) { out.reason = `Already ${label(h.decision)}${h.decidedAt ? ` on ${h.decidedAt.toISOString().slice(0, 10)}` : ''}.`; continue; }
      if (action === 'leave_out') {
        await db.mdmSkipped.update({ where: { id }, data: { decision: 'left_out', decidedById: user.id, decidedAt: now, decisionNote: written, outcome: '{}' } });
        out.ok = true; out.outcome = 'Left out.'; continue;
      }
      // place or lead: a market among the three, a phone, and no record with that phone or platform id yet
      const m = market ?? suggestMarket(h);
      if (!m) { out.reason = 'Choose a market (Libya, Iraq or Lebanon) for this seller.'; continue; }
      let e164;
      try { e164 = normalizePhone(phone ?? h.phone); } catch { out.reason = phone ? `"${phone}" is not a phone number in international format (+218…).` : 'No valid phone number on the platform — type one.'; continue; }
      const dup = await db.contact.findUnique({ where: { phone: e164 } });
      if (dup) {
        if (!dup.mdmRef) await db.contact.update({ where: { id: dup.id }, data: { mdmRef: h.mdmRef } });
        out.reason = `Already here as ${dup.name} (${e164})${dup.contactType === 'seller' ? ', a seller.' : ' — a lead is activated in the onboarding console.'}`; continue;
      }
      if (await db.seller.findUnique({ where: { mdmRef: h.mdmRef } })) { out.reason = 'Already a seller here with this platform id.'; continue; }
      const sameRef = await db.contact.findFirst({ where: { mdmRef: h.mdmRef } });
      if (sameRef) { out.reason = `Already here as ${sameRef.name} (${sameRef.phone}) — one contact per merchant; change the number on that contact if MDM is right.`; continue; }
      if (action === 'lead') {
        // the same path as the pull, so MDM's join status, dates, responsible agent and history come too
        const platform = parse(h.platform, {});
        const r = await openPlatformLead({ ...platform, name: h.name ?? platform.name, utm: h.utm ?? platform.utm, createdAt: platform.createdAt ?? h.registeredAt },
          { phone: e164, market: m, ref: h.mdmRef, now }, await platformPeople(db), db);
        const outcome = { market: m, contactId: r.contact.id, ticketId: r.ticket?.id ?? null, assigned: !!r.ticket?.assigneeId, registration: r.outcome };
        await db.mdmSkipped.update({ where: { id }, data: { decision: 'lead', decidedById: user.id, decidedAt: now, decisionNote: written, outcome: JSON.stringify(outcome) } });
        out.ok = true; out.contactId = r.contact.id; out.ticketId = outcome.ticketId;
        out.outcome = r.ticket ? `Onboarding lead in ${MARKET_NAMES[m]}${r.ticket.assigneeId ? ', assigned.' : ' — waiting in the holding queue.'}` : `Contact created in ${MARKET_NAMES[m]}; no onboarding ticket (${r.outcome}).`;
        continue;
      }
      let ownership = null;
      if (named) {
        if (!parse(named.markets, []).includes(m)) { out.reason = `${named.name} does not cover ${MARKET_NAMES[m]}.`; continue; }
        if (await db.seller.count({ where: { assignedAccountManagerId: named.id } }) >= config['am.maxBook']) { out.reason = `${named.name} is at the book ceiling (${config['am.maxBook']}).`; continue; }
        ownership = `Placed with ${named.name} by ${user.name}.`;
      }
      const activatedAt = dateOr(h.joinStatusDate) ?? dateOr(h.registeredAt) ?? now;
      const { seller, ownership: placed } = await createSellerRecord({ phone: e164, name: h.name || e164, market: m, mdmRef: h.mdmRef, source: 'mdm_platform', activatedAt,
        welcomeCallAt: null, mirror: {}, managerId: named?.id ?? null, ownership, lastSyncedAt: null }, { actorId: user.id, config, managers }, db);
      await db.contact.update({ where: { id: seller.contactId }, data: { mdmRef: h.mdmRef, ...(h.registeredAt ? { mdmCreatedAt: h.registeredAt } : {}) } });
      const outcome = { market: m, sellerId: seller.id, contactId: seller.contactId, ownership: placed };
      await db.mdmSkipped.update({ where: { id }, data: { decision: 'placed', decidedById: user.id, decidedAt: now, decisionNote: written, outcome: JSON.stringify(outcome), figuresAt: null } });
      out.ok = true; out.sellerId = seller.id; out.outcome = `${MARKET_NAMES[m]} book · ${placed}`;
    } catch (err) { out.reason = err.message; }
  }
  const done = results.filter((r) => r.ok).length;
  const batchId = `mdm.skipped:${Date.now()}`;
  await logEvent({ actorId: user.id, entityType: 'bulk', entityId: batchId, action: 'mdm.skipped_decided',
    after: { action, market, managerId, requested: unique.length, done, failed: unique.length - done, items: results }, reason: written }, db);
  return { batchId, action, requested: unique.length, done, failed: unique.length - done, results };
}
