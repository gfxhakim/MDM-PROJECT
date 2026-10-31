// MDM platform connector. The client's e-commerce platform (orders, parcels, wallet, catalogue)
// is linked by a webhook and an API key:
//   • events pushed to POST /api/integrations/mdm/events (header X-MDM-Key) — registrations,
//     orders, seller updates and metric updates;
//   • a pull sync from the platform API (MDM_API_URL, default https://api.mdm.express, with
//     MDM_API_KEY): sellers, orders and wallets, see mdm-api.js. The first run (or a "full" run)
//     reads everything, so existing merchants and sellers come in;
//   • work done here goes back to the platform (mdm-writeback.js, when MDM_WRITEBACK=on).
// The platform has no outbound webhooks for sellers or orders, so the pull runs every
// MDM_SYNC_MINUTES; the webhook below is ready for when the MDM team adds them.
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
import { PATHS, client, isAccepted, isRejected, managersByEmail, sellerMetrics, sellersWithOrderChanges, sellerToRow } from './mdm-api.js';

export const mdmConfig = () => ({
  url: (process.env.MDM_API_URL || 'https://api.mdm.express').replace(/\/$/, ''),
  apiKey: process.env.MDM_API_KEY || null,
  webhookKey: process.env.MDM_WEBHOOK_SECRET || null,
  paymentPassword: process.env.MDM_PAYMENT_PASSWORD || null,
  leadMaxAgeDays: Number(process.env.MDM_LEAD_MAX_AGE_DAYS) || 60,
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
  if (ref) {
    const s = await db.seller.findUnique({ where: { mdmRef: String(ref) } }) ?? await db.seller.findFirst({ where: { contact: { mdmRef: String(ref) } } });
    if (s) return s;
  }
  if (phone) {
    const contact = await db.contact.findUnique({ where: { phone: normalizePhone(phone) } });
    if (contact) return db.seller.findUnique({ where: { contactId: contact.id } });
  }
  return null;
}

const MARKETS = ['LY', 'IQ', 'LB'];
const DAY = 86_400_000;
const dateOr = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; };

async function upsertContext(db) {
  const { values: config } = await getLiveConfig(db);
  const managers = await db.user.findMany({ where: { role: 'ACCOUNT_MANAGER', active: true } });
  return { config, managers, leadMaxAgeDays: mdmConfig().leadMaxAgeDays };
}

/**
 * One merchant from the platform (the pull sync, or a seller.upserted event).
 *   • a seller we already have → its platform figures are updated (owner, health and stage untouched);
 *   • accepted on the platform and new here → joins the book: the platform's account manager is
 *     kept when they are one of ours (same email), cover the market and have room; otherwise
 *     AM 3.2 (same market, smallest book, no cross-market fallback). A welcome task is opened only
 *     when accepted in the last 14 days;
 *   • still joining on the platform and new here → an onboarding lead (capture r1), unless the
 *     registration is older than MDM_LEAD_MAX_AGE_DAYS; rejected merchants are not brought in;
 *   • already here as a lead → linked to its platform id and left alone: a lead is activated
 *     through the onboarding flow, so the activation gate and handoff record still apply.
 */
export async function upsertFromMdm(row, ctx, db = prisma) {
  const ref = row.mdmRef ?? row.sellerRef ?? row.id ?? null;
  const metrics = row.metrics ?? {};
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
  if (isRejected(row.joinStatus)) return { ok: false, action: 'skipped', ref, reason: `Rejected on the platform (${row.joinStatus}).` };
  const accepted = isAccepted(row.joinStatus) || !!row.activatedAt;
  const activatedAt = dateOr(row.activatedAt) ?? (accepted ? (dateOr(row.joinStatusDate) ?? dateOr(row.createdAt) ?? new Date()) : null);
  const contact = await db.contact.findUnique({ where: { phone } });
  if (contact) {
    if (ref && !contact.mdmRef) await db.contact.update({ where: { id: contact.id }, data: { mdmRef: String(ref) } });
    return { ok: false, action: 'skipped', ref, reason: accepted
      ? 'Already an onboarding lead here — activate it in the onboarding console so the handoff record is complete.'
      : 'Already a contact here — linked to its platform id.' };
  }
  if (!accepted) {
    const created = dateOr(row.createdAt);
    const maxAge = ctx.leadMaxAgeDays ?? mdmConfig().leadMaxAgeDays;
    if (created && Date.now() - created.getTime() > maxAge * DAY) {
      return { ok: false, action: 'skipped', ref, reason: `Registered ${created.toISOString().slice(0, 10)}, more than ${maxAge} days ago and never accepted — not opened as a lead.` };
    }
    const r = await registerMerchant({ phone, name: row.name, country: market, sourceUtm: row.utm ?? row.sourceUtm ?? 'mdm_platform' }, {}, db);
    if (ref) await db.contact.update({ where: { id: r.contact.id }, data: { mdmRef: String(ref) } });
    return { ok: true, action: 'lead_created', ref, contactId: r.contact.id, ticketId: r.ticket?.id ?? null };
  }
  if (!ref) return { ok: false, action: 'skipped', ref, reason: 'An activated seller needs its MDM seller id (mdmRef).' };
  const { data: mirror, errors } = mirrorData(metrics);
  if (errors.length) return { ok: false, action: 'error', ref, reason: errors.join(' ') };
  // keep the platform's account manager when they are ours, cover the market and have room
  let managerId = null; let ownership;
  const named = row.managerEmail ? ctx.managers?.find((m) => m.email.toLowerCase() === row.managerEmail.toLowerCase()) : null;
  if (named && JSON.parse(named.markets).includes(market)
    && await db.seller.count({ where: { assignedAccountManagerId: named.id } }) < ctx.config['am.maxBook']) {
    managerId = named.id; ownership = `Kept with ${named.name} (account manager on the platform).`;
  }
  const { seller, ownership: placed } = await createSellerRecord({ phone, name: row.name || phone, market, mdmRef: String(ref), source: 'mdm_platform',
    activatedAt, welcomeCallAt: dateOr(row.welcomeCallAt), mirror, managerId, ownership }, { config: ctx.config, managers: ctx.managers ?? [] }, db);
  await db.contact.update({ where: { id: seller.contactId }, data: { mdmRef: String(ref) } });
  return { ok: true, action: 'seller_created', ref, sellerId: seller.id, ownership: placed };
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
 * Pull from the MDM platform API. The first run (or full: true) reads every seller on the platform;
 * later runs read the sellers changed since the last successful run (newest first, stopping at the
 * first older one) and refresh the figures of every seller whose orders changed.
 */
export async function syncSellers({ actorId = null, full = false, fetchImpl = fetch, db = prisma, now = new Date() } = {}) {
  const c = mdmConfig();
  if (!c.apiKey) throw Object.assign(new Error('The MDM platform connector is not configured (MDM_API_KEY).'), { status: 503, code: 'not_configured' });
  const last = full ? null : await db.integrationRun.findFirst({ where: { kind: 'mdm_sync', status: 'completed' }, orderBy: { startedAt: 'desc' } });
  const ctx = await upsertContext(db);
  const api = client({ url: c.url, apiKey: c.apiKey, paymentPassword: c.paymentPassword, fetchImpl });
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
    // platform account managers by id → their email, to keep an existing owner who is one of ours
    const platformManagers = new Map([...(await managersByEmail(api).catch(() => new Map())).values()].map((m) => [m.trackingId, m.email]));
    for await (const s of api.search(PATHS.sellers, { sortBy: { updatedAt: 'DESC' } })) {
      const row = sellerToRow(s);
      if (since && row.updatedAt && row.updatedAt < since) break; // newest first: the rest are unchanged
      summary.fetched++;
      if (!row.mdmRef || done.has(row.mdmRef)) continue;
      done.add(row.mdmRef);
      try {
        const known = await sellerFor({ mdmRef: row.mdmRef, phone: row.phone }, db).catch(() => null);
        const metrics = known || isAccepted(row.joinStatus) ? await sellerMetrics(api, row.mdmRef, { now, countryId: row.countryId }) : {};
        record(await upsertFromMdm({ ...row, metrics, managerEmail: platformManagers.get(row.accountManagerRef) ?? null }, ctx, db), row);
      } catch (err) { record({ action: 'error', ref: row.mdmRef, reason: err.message }); }
    }
    const refs = since ? [...await sellersWithOrderChanges(api, since, now)] : [];
    for (const ref of refs) {
      if (done.has(ref)) continue;
      done.add(ref);
      const seller = await sellerFor({ mdmRef: ref }, db);
      if (!seller) continue; // not one of ours yet: it arrives with its seller record
      try {
        const countryId = c.paymentPassword ? (await api.call('GET', `/api/sellers/${encodeURIComponent(ref)}`))?.country?.id : null;
        const { data, errors } = mirrorData(await sellerMetrics(api, ref, { now, countryId }));
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
