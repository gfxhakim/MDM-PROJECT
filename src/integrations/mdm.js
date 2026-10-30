// MDM platform connector. The client's e-commerce platform (orders, parcels, wallet, catalogue)
// is linked by API key. Two directions, both optional:
//   • events pushed to POST /api/integrations/mdm/events (header X-MDM-Key) — registrations,
//     orders, seller metric updates;
//   • a pull sync from MDM_API_URL with MDM_API_KEY, paging GET /sellers?updated_since=…
// Until it is configured the app runs on imported or seeded data and says so on the status page.
import { prisma } from '../db.js';
import { emit } from '../core/events.js';
import { normalizePhone } from '../core/contacts.js';
import { registerMerchant } from '../oa/service.js';
import { logEvent } from '../services/audit.js';
import { applyMirror, mirrorData } from './mirror.js';

export const mdmConfig = () => ({
  url: (process.env.MDM_API_URL || '').replace(/\/$/, '') || null,
  apiKey: process.env.MDM_API_KEY || null,
  webhookKey: process.env.MDM_WEBHOOK_SECRET || null,
});

export async function mdmStatus(db = prisma) {
  const c = mdmConfig();
  const last = await db.integrationRun.findFirst({ where: { kind: 'mdm_sync' }, orderBy: { startedAt: 'desc' } });
  return {
    pull: !!(c.url && c.apiKey), events: !!c.webhookKey,
    lastSync: last ? { at: last.finishedAt ?? last.startedAt, status: last.status, summary: JSON.parse(last.summary) } : null,
    detail: c.url && c.apiKey ? `Syncing seller metrics from ${c.url}.` : 'Not connected — running on imported or seeded data. Set MDM_API_URL and MDM_API_KEY.',
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
  return { ok: false, reason: `Unknown event type "${type}".` };
}

/** Pull every seller changed since the last successful sync and update the mirror. */
export async function syncSellers({ actorId = null, fetchImpl = fetch, db = prisma } = {}) {
  const c = mdmConfig();
  if (!c.url || !c.apiKey) throw Object.assign(new Error('The MDM platform connector is not configured (MDM_API_URL, MDM_API_KEY).'), { status: 503, code: 'not_configured' });
  const last = await db.integrationRun.findFirst({ where: { kind: 'mdm_sync', status: 'completed' }, orderBy: { startedAt: 'desc' } });
  const run = await db.integrationRun.create({ data: { kind: 'mdm_sync', status: 'running', actorId } });
  const summary = { fetched: 0, updated: 0, unknown: [], errors: [] };
  try {
    let next = `${c.url}/sellers?updated_since=${encodeURIComponent((last?.startedAt ?? new Date(0)).toISOString())}`;
    for (let page = 0; next && page < 500; page++) {
      const res = await fetchImpl(next, { headers: { 'x-api-key': c.apiKey, accept: 'application/json' } });
      if (!res.ok) throw new Error(`MDM API responded ${res.status}`);
      const body = await res.json();
      for (const row of body.data ?? body.sellers ?? []) {
        summary.fetched++;
        const seller = await sellerFor(row, db);
        if (!seller) { summary.unknown.push(row.mdmRef ?? row.sellerRef ?? row.phone ?? null); continue; }
        const { data, errors } = mirrorData(row.metrics ?? row);
        if (errors.length) { summary.errors.push({ ref: seller.mdmRef, errors }); continue; }
        await applyMirror(seller.id, data, db);
        summary.updated++;
      }
      next = body.next ?? null;
    }
    await db.integrationRun.update({ where: { id: run.id }, data: { status: 'completed', finishedAt: new Date(), summary: JSON.stringify(summary) } });
  } catch (err) {
    summary.errors.push({ error: err.message });
    await db.integrationRun.update({ where: { id: run.id }, data: { status: 'failed', finishedAt: new Date(), summary: JSON.stringify(summary) } });
    await logEvent({ actorId, entityType: 'system', entityId: 'mdm.sync', action: 'mdm.sync_failed', reason: err.message }, db);
    throw err;
  }
  await logEvent({ actorId, entityType: 'system', entityId: 'mdm.sync', action: 'mdm.sync', after: { fetched: summary.fetched, updated: summary.updated, unknown: summary.unknown.length } }, db);
  return summary;
}
