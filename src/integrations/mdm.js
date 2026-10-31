// MDM platform connector. The client's e-commerce platform (orders, parcels, wallet, catalogue)
// is linked by a webhook and an API key:
//   • events pushed to POST /api/integrations/mdm/events (header X-MDM-Key) — registrations,
//     orders, seller updates and metric updates;
//   • a pull sync from the platform API (MDM_API_URL, default https://api.mdm.express, with
//     MDM_API_KEY): stores and orders, see mdm-api.js. The first run (or a "full" run) reads
//     everything, so existing merchants and sellers come in;
//   • edits made here go back to the platform (mdm-writeback.js).
// The exact wire format is in docs/mdm-integration.md until the client's API docs replace it.
// Until it is configured the app runs on imported or seeded data and says so on the status page.
import { prisma } from '../db.js';
import { emit } from '../core/events.js';
import { normalizePhone } from '../core/contacts.js';
import { registerMerchant } from '../oa/service.js';
import { logEvent } from '../services/audit.js';
import { applyMirror, mirrorData } from './mirror.js';
import { getLiveConfig } from '../config/service.js';
import { createSellerRecord } from './sellers.js';
import { countryFromPhone } from './phone.js';
import { PATHS, client, sellerMetrics, sellersWithOrderChanges, storeToRow } from './mdm-api.js';

export const mdmConfig = () => ({
  url: (process.env.MDM_API_URL || 'https://api.mdm.express').replace(/\/$/, ''),
  apiKey: process.env.MDM_API_KEY || null,
  webhookKey: process.env.MDM_WEBHOOK_SECRET || null,
});

export async function mdmStatus(db = prisma) {
  const c = mdmConfig();
  const last = await db.integrationRun.findFirst({ where: { kind: 'mdm_sync' }, orderBy: { startedAt: 'desc' } });
  return {
    pull: !!c.apiKey, events: !!c.webhookKey,
    lastSync: last ? { at: last.finishedAt ?? last.startedAt, status: last.status, summary: JSON.parse(last.summary) } : null,
    detail: c.apiKey ? `Syncing merchants and sellers from ${c.url}.` : 'Not connected — running on imported or seeded data. Set MDM_API_KEY.',
  };
}

async function sellerFor({ mdmRef, sellerRef, phone }, db) {
  const ref = mdmRef ?? sellerRef;
  if (ref) { const s = await db.seller.findUnique({ where: { mdmRef: String(ref) } }); if (s) return s; }
  if (phone) {
    const contact = await db.contact.findUnique({ where: { phone: normalizePhone(phone) } });
    if (contact) return db.seller.findUnique({ where: { contactId: contact.id } });
  }
  return null;
}

const MARKETS = ['LY', 'IQ', 'LB'];
const ACTIVE = /^(active|activated|accepted|live|seller)$/i;
const dateOr = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; };

async function upsertContext(db) {
  const { values: config } = await getLiveConfig(db);
  return { config };
}

/**
 * One merchant or seller record from the platform, from the pull sync or a seller.upserted event.
 *   • a seller we already have → its platform figures are updated (ownership, health and stage untouched);
 *   • an activated seller we don't have → created and placed in a book (AM 3.2; handover with a
 *     welcome task only when activated in the last 14 days with no welcome call);
 *   • a registered merchant who is not activated and is new here → an onboarding lead (capture r1);
 *   • anything already here as an onboarding lead or contact is left alone: a lead is activated
 *     through the onboarding flow, so the activation gate and handoff record still apply.
 */
export async function upsertFromMdm(row, ctx, db = prisma) {
  const ref = row.mdmRef ?? row.sellerRef ?? row.id ?? null;
  const metrics = row.metrics ?? row;
  const existing = await sellerFor({ mdmRef: ref, phone: row.phone }, db);
  if (existing) {
    const { data, errors } = mirrorData(metrics);
    if (errors.length) return { ok: false, action: 'error', ref, reason: errors.join(' ') };
    await applyMirror(existing.id, data, db);
    return { ok: true, action: 'updated', ref, sellerId: existing.id };
  }
  let phone;
  try { phone = normalizePhone(row.phone); } catch { return { ok: false, action: 'skipped', ref, reason: 'No valid phone number.' }; }
  const market = String(row.country ?? row.market ?? '').toUpperCase() || countryFromPhone(phone);
  if (!MARKETS.includes(market)) return { ok: false, action: 'skipped', ref, reason: `Market ${market || 'unknown'} is not Libya, Iraq or Lebanon.` };
  const contact = await db.contact.findUnique({ where: { phone } });
  const activatedAt = dateOr(row.activatedAt) ?? (ACTIVE.test(row.status ?? '') ? new Date() : null);
  if (contact) {
    return { ok: false, action: 'skipped', ref, reason: activatedAt
      ? 'Already an onboarding lead here — activate it in the onboarding console so the handoff record is complete.'
      : 'Already a contact here.' };
  }
  if (!activatedAt) {
    const r = await registerMerchant({ phone, name: row.name, country: market, sourceUtm: row.utm ?? row.sourceUtm ?? 'mdm_platform' }, {}, db);
    return { ok: true, action: 'lead_created', ref, contactId: r.contact.id, ticketId: r.ticket?.id ?? null };
  }
  if (!ref) return { ok: false, action: 'skipped', ref, reason: 'An activated seller needs its MDM seller id (mdmRef).' };
  const { data: mirror, errors } = mirrorData(metrics);
  if (errors.length) return { ok: false, action: 'error', ref, reason: errors.join(' ') };
  const { seller, ownership } = await createSellerRecord({ phone, name: row.name || phone, market, mdmRef: String(ref), source: 'mdm_platform',
    activatedAt, welcomeCallAt: dateOr(row.welcomeCallAt), mirror }, { config: ctx.config }, db);
  return { ok: true, action: 'seller_created', ref, sellerId: seller.id, ownership };
}

/** One pushed event. Returns what happened; unknown or unmatched events are reported, not swallowed. */
export async function handleMdmEvent(evt, db = prisma) {
  const type = evt?.type;
  const d = evt?.data ?? {};
  if (type === 'merchant.registered') {
    const r = await registerMerchant({ phone: d.phone, name: d.name, country: d.country, sourceUtm: d.utm ?? d.sourceUtm ?? 'mdm_platform' }, {}, db);
    return { ok: true, outcome: r.outcome, contactId: r.contact.id };
  }
  if (type === 'order.created') {
    const phone = d.phone ? normalizePhone(d.phone) : null;
    const seller = await sellerFor(d, db);
    const contactId = seller?.contactId ?? (phone ? (await db.contact.findUnique({ where: { phone } }))?.id : null);
    if (!contactId) return { ok: false, reason: 'No contact or seller matches this order.' };
    const at = d.at ? new Date(d.at) : new Date();
    if (seller) {
      await db.seller.update({ where: { id: seller.id }, data: { totalOrders: { increment: 1 }, lastOrderAt: at, healthStale: true, lastSyncedAt: new Date() } });
    }
    await emit('order.created', { contactId, at }); // OA r10: first order closes the onboarding loop
    return { ok: true, contactId };
  }
  if (type === 'seller.metrics') {
    const seller = await sellerFor(d, db);
    if (!seller) return { ok: false, reason: 'Unknown seller.' };
    const { data, ignored, errors } = mirrorData(d.metrics ?? {});
    if (errors.length) return { ok: false, reason: errors.join(' ') };
    await applyMirror(seller.id, data, db);
    return { ok: true, sellerId: seller.id, updated: Object.keys(data), ignored };
  }
  if (type === 'seller.upserted' || type === 'merchant.updated' || type === 'seller.activated') {
    return upsertFromMdm(d, await upsertContext(db), db);
  }
  return { ok: false, reason: `Unknown event type "${type}".` };
}

/**
 * Pull from the MDM platform API. The first run (or full: true) reads every store and every
 * seller we hold; later runs read the stores changed since the last successful run and the sellers
 * whose orders changed. A store whose seller has orders joins the seller book; a store with no
 * orders yet is a merchant still onboarding and becomes a lead.
 */
export async function syncSellers({ actorId = null, full = false, fetchImpl = fetch, db = prisma, now = new Date() } = {}) {
  const c = mdmConfig();
  if (!c.apiKey) throw Object.assign(new Error('The MDM platform connector is not configured (MDM_API_KEY).'), { status: 503, code: 'not_configured' });
  const last = full ? null : await db.integrationRun.findFirst({ where: { kind: 'mdm_sync', status: 'completed' }, orderBy: { startedAt: 'desc' } });
  const ctx = await upsertContext(db);
  const api = client({ url: c.url, apiKey: c.apiKey, fetchImpl });
  const run = await db.integrationRun.create({ data: { kind: 'mdm_sync', status: 'running', actorId } });
  const summary = { full: !last, fetched: 0, updated: 0, leadsCreated: 0, sellersCreated: 0, skipped: [], errors: [] };
  const done = new Set();
  const record = (r, row) => {
    if (r.action === 'updated') summary.updated++;
    else if (r.action === 'lead_created') summary.leadsCreated++;
    else if (r.action === 'seller_created') summary.sellersCreated++;
    else if (r.action === 'skipped') summary.skipped.push({ ref: r.ref ?? row?.phone ?? null, reason: r.reason });
    else summary.errors.push({ ref: r.ref ?? null, error: r.reason });
  };
  try {
    const since = last?.startedAt ?? null;
    const storeFilter = since ? { updatedAt: { start: since.toISOString(), end: now.toISOString() } } : {};
    for await (const store of api.search(PATHS.stores, storeFilter)) {
      summary.fetched++;
      const row = storeToRow(store);
      if (!row.mdmRef || done.has(String(row.mdmRef))) continue;
      done.add(String(row.mdmRef));
      try {
        const known = await sellerFor({ mdmRef: row.mdmRef, phone: row.phone }, db).catch(() => null);
        const orders = known ? 1 : await api.count(PATHS.orders, { sellerId: [String(row.mdmRef)] });
        const metrics = orders ? await sellerMetrics(api, row.mdmRef, now) : {};
        record(await upsertFromMdm({ ...row, metrics, activatedAt: orders ? (row.createdAt ?? now) : null }, ctx, db), row);
      } catch (err) { record({ action: 'error', ref: row.mdmRef, reason: err.message }); }
    }
    const refs = since
      ? [...await sellersWithOrderChanges(api, since, now)]
      : (await db.seller.findMany({ select: { mdmRef: true } })).map((x) => x.mdmRef);
    for (const ref of refs) {
      if (done.has(ref)) continue;
      done.add(ref);
      const seller = await db.seller.findUnique({ where: { mdmRef: ref } });
      if (!seller) continue; // a seller we don't hold yet arrives with its store
      try {
        const { data, errors } = mirrorData(await sellerMetrics(api, ref, now));
        if (errors.length) { record({ action: 'error', ref, reason: errors.join(' ') }); continue; }
        await applyMirror(seller.id, data, db);
        summary.updated++;
      } catch (err) { record({ action: 'error', ref, reason: err.message }); }
    }
    await db.integrationRun.update({ where: { id: run.id }, data: { status: 'completed', finishedAt: new Date(), summary: JSON.stringify(summary) } });
  } catch (err) {
    summary.errors.push({ error: err.message });
    await db.integrationRun.update({ where: { id: run.id }, data: { status: 'failed', finishedAt: new Date(), summary: JSON.stringify(summary) } });
    await logEvent({ actorId, entityType: 'system', entityId: 'mdm.sync', action: 'mdm.sync_failed', reason: err.message }, db);
    throw err;
  }
  await logEvent({ actorId, entityType: 'system', entityId: 'mdm.sync', action: 'mdm.sync', after: { full: summary.full, fetched: summary.fetched, updated: summary.updated, leadsCreated: summary.leadsCreated, sellersCreated: summary.sellersCreated, skipped: summary.skipped.length } }, db);
  return summary;
}
