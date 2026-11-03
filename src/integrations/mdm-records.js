// Every piece of data MDM holds for a merchant and for a person (HAKIM, 2 Nov: "the api key must
// grab it with every piece of data and also about the people from mdm"). The records are kept
// exactly as the MDM API returns them (shapes in the MDM Swagger) and shown read-only on the
// "From MDM" card:
//   • seller        POST /api/sellers/search                              (Seller: 31 fields)
//   • store         POST /api/stores/search                               (Store, its seller in `seller`)
//   • team_member   POST /api/sellers/{sellerId}/team-members/search      (the merchant's own staff)
//   • service_fees  GET  /api/sellers/{trackingId}/service-fees?countryId= (plan, call-centre,
//                   fulfilment and shipping pricing, sourcing, exchange — finance only)
//   • user          POST /api/users/search                                (GetUserResponse)
// MDM is never written from here. The finance record is absent from the API response for roles
// without "See cost / fee / margin" (OA Appendix A, finance.view_cost), never blanked.
import { prisma } from '../db.js';
import { grant } from '../auth/permissions.js';
import { notFound, badRequest } from '../http/errors.js';
import { onboardingReadWhere, sellerWhere } from '../auth/scope.js';

export const RECORD_PATHS = {
  stores: '/api/stores/search',
  teamMembers: (sellerRef) => `/api/sellers/${encodeURIComponent(sellerRef)}/team-members/search`,
  serviceFees: (sellerRef) => `/api/sellers/${encodeURIComponent(sellerRef)}/service-fees`,
};

const json = (v, fallback) => { try { return JSON.parse(v); } catch { return fallback; } };

/** Keep one record as MDM returned it (replaced when MDM's copy changes). */
export async function keepRecord(kind, mdmRef, data, { sellerRef = null } = {}, db = prisma) {
  if (!mdmRef || !data) return null;
  const body = JSON.stringify(data);
  return db.mdmRecord.upsert({
    where: { kind_mdmRef: { kind, mdmRef: String(mdmRef) } },
    update: { data: body, sellerRef, fetchedAt: new Date() },
    create: { kind, mdmRef: String(mdmRef), sellerRef, data: body },
  });
}

/**
 * Per-run state: an endpoint MDM refuses (no right for this API key, or not found) is not called
 * again in the same run, and is reported once as a warning.
 */
export function recordState() { return { refused: new Map() }; }
const refusable = (err) => [401, 403, 404, 405].includes(err?.status);

async function guarded(state, key, fn, warn) {
  if (state.refused.has(key)) return null;
  try { return await fn(); } catch (err) {
    if (refusable(err)) { state.refused.set(key, err.message); warn?.(key, err.message); return null; }
    throw err;
  }
}

/**
 * What MDM holds around one seller read in this run: the seller's team members and, for every
 * country MDM lists for the seller, what MDM charges there. Records that disappeared on MDM are
 * removed here too, so the card never shows a team member MDM no longer has.
 */
export async function readSellerExtras(api, raw, places, state, warn, db = prisma) {
  const ref = raw?.trackingId;
  if (!ref) return { teamMembers: 0, fees: 0 };
  let teamMembers = 0; let fees = 0;
  const members = await guarded(state, 'team-members', async () => {
    const list = [];
    for await (const m of api.search(RECORD_PATHS.teamMembers(ref), {})) list.push(m);
    return list;
  }, warn);
  if (members) {
    for (const m of members) { await keepRecord('team_member', m.trackingId, m, { sellerRef: ref }, db); teamMembers++; }
    await db.mdmRecord.deleteMany({ where: { kind: 'team_member', sellerRef: ref, mdmRef: { notIn: members.map((m) => String(m.trackingId)) } } });
  }
  const countryIds = [...new Set([
    ...(places ?? []).map((p) => p?.id),
    ...(raw.servicesByCountry ?? []).map((x) => x?.countryId),
  ].filter(Boolean))];
  for (const countryId of countryIds) {
    const f = await guarded(state, 'service-fees', () => api.call('GET', RECORD_PATHS.serviceFees(ref), { query: `countryId=${encodeURIComponent(countryId)}` }), warn);
    if (f) { await keepRecord('service_fees', `${ref}:${countryId}`, { countryId, ...f }, { sellerRef: ref }, db); fees++; }
  }
  return { teamMembers, fees };
}

/** Every store changed since the last run (all of them on a full run), newest change first. */
export async function readStores(api, since, state, warn, db = prisma) {
  let n = 0;
  await guarded(state, 'stores', async () => {
    for await (const st of api.search(RECORD_PATHS.stores, { sortBy: { updatedAt: 'DESC' } })) {
      const at = st.updatedAt ? new Date(st.updatedAt) : null;
      if (since && at && at < since) break;
      await keepRecord('store', st.trackingId, st, { sellerRef: st.seller?.trackingId ?? null }, db);
      n++;
    }
    return true;
  }, warn);
  return n;
}

// ───────────────────────────── reading it back ─────────────────────────────

const shapeRows = (rows) => rows.map((r) => ({ ...json(r.data, {}), _fetchedAt: r.fetchedAt }));

/** The seller's MDM records for someone allowed to see the merchant. */
export async function sellerRecords(user, mdmRef, db = prisma) {
  const [seller, stores, team, fees] = await Promise.all([
    db.mdmRecord.findUnique({ where: { kind_mdmRef: { kind: 'seller', mdmRef } } }),
    db.mdmRecord.findMany({ where: { kind: 'store', sellerRef: mdmRef }, orderBy: { fetchedAt: 'desc' } }),
    db.mdmRecord.findMany({ where: { kind: 'team_member', sellerRef: mdmRef }, orderBy: { fetchedAt: 'desc' } }),
    db.mdmRecord.findMany({ where: { kind: 'service_fees', sellerRef: mdmRef } }),
  ]);
  const finance = grant(user.role, 'finance.view_cost') === true;
  const out = {
    mdmRef,
    fetchedAt: seller?.fetchedAt ?? null,
    seller: seller ? json(seller.data, {}) : null,
    stores: shapeRows(stores),
    teamMembers: shapeRows(team),
  };
  // absent, not blanked (OA 6.7 / 9.1), with the reason the interface states
  if (finance) out.fees = shapeRows(fees);
  else out.withheld = fees.length ? ['fees'] : [];
  return out;
}

/**
 * The MDM records behind a lead (onboarding ticket), a seller, or a contact — only when the caller
 * may read that merchant: an onboarding ticket they can read, or a seller in their book (a
 * foreign seller is not-found, AC-20).
 */
export async function recordsFor(user, { ticketId, sellerId, contactId } = {}, db = prisma) {
  let contact = null;
  if (ticketId) {
    const t = await db.ticket.findFirst({ where: { id: ticketId, ...onboardingReadWhere(user) }, include: { contact: true } });
    contact = t?.contact ?? null;
  } else if (sellerId) {
    const scope = sellerWhere(user);
    const s = scope === null ? null : await db.seller.findFirst({ where: { id: sellerId, ...scope }, include: { contact: true } });
    contact = s?.contact ?? null;
  } else if (contactId) {
    const scope = sellerWhere(user);
    const s = scope === null ? null : await db.seller.findFirst({ where: { contactId, ...scope }, include: { contact: true } });
    const t = s ? null : await db.ticket.findFirst({ where: { contactId, ...onboardingReadWhere(user) }, include: { contact: true } });
    contact = s?.contact ?? t?.contact ?? null;
  } else throw badRequest('Name a ticketId, sellerId or contactId.');
  if (!contact) throw notFound('Not found.');
  if (!contact.mdmRef) return { mdmRef: null, fetchedAt: null, seller: null, stores: [], teamMembers: [], ...(grant(user.role, 'finance.view_cost') === true ? { fees: [] } : { withheld: [] }) };
  return sellerRecords(user, contact.mdmRef, db);
}

/** One MDM user's record (People on MDM), for the Admin. */
export async function userRecord(mdmRef, db = prisma) {
  const r = await db.mdmRecord.findUnique({ where: { kind_mdmRef: { kind: 'user', mdmRef } } });
  if (!r) throw notFound('MDM has not sent this person yet — it comes with the next sync.');
  return { mdmRef, fetchedAt: r.fetchedAt, user: json(r.data, {}) };
}
