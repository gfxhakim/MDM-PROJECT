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
import { PATHS, client, isAccepted, isFollowup, isMissingDocuments, isNotAnswer, isPendingJoin, isRejected, managersByEmail, marketCode, platformUsers, sellerMetrics, sellersWithOrderChanges, sellerToRow, userToRow } from './mdm-api.js';
import { markImported, rememberSkipped, watchedRefs } from './mdm-skipped.js';
import { alignOwnership, assignLeadToPlatformAgent, countryIndex, moveSellerToPlatformManager, platformPeople, refreshStaffMarkets, rememberStaff } from './mdm-staff.js';
import { changeTicket } from '../oa/service.js';
import { addSystemLine } from '../core/conversations.js';

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
    skippedWaiting: await db.mdmSkipped.count({ where: { decision: null } }),
    staffWaiting: await db.mdmStaff.count({ where: { decision: null } }),
    staffImported: await db.mdmStaff.count({ where: { decision: 'imported' } }),
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
  const people = await platformPeople(db); // imported staff: the lead's agent and the seller's manager MDM names
  return { config, managers, leadMaxAgeDays: mdmConfig().leadMaxAgeDays, ...people };
}

const OPEN_OA = ['new', 'failed_to_contact', 'prequalified', 'qualified'];

/**
 * The merchant's record on MDM comes with them (OA 3.5 applied to the platform): every join mark
 * MDM recorded (not answered, follow-up, missing documents, accepted …) is a read-only legacy line
 * in the conversation, dated as on MDM and credited to the MDM user who made it. Idempotent: one
 * line per mark, whatever the number of runs.
 */
async function importJoinHistory(contactId, row, ctx, db) {
  const history = (row.history ?? []).filter((h) => h.date);
  if (!history.length) return 0;
  const conv = await db.conversation.findFirst({ where: { contactId } });
  if (!conv) return 0;
  let n = 0;
  for (const h of history) {
    const at = dateOr(h.date);
    if (!at) continue;
    const externalId = `mdm:join:${row.mdmRef}:${at.toISOString()}:${String(h.status ?? '').slice(0, 40)}`;
    const body = `MDM · ${h.status ?? 'note'}${h.notes ? ` — ${h.notes}` : ''}${h.responsibleName ? ` · ${h.responsibleName}` : ''}`;
    const authorUserId = h.responsibleRef ? ctx.staffByRef?.get(h.responsibleRef)?.id ?? null : null;
    await db.message.upsert({ where: { externalId }, update: { body, authorUserId },
      create: { conversationId: conv.id, direction: 'internal', kind: 'system', body, legacy: true, externalId, authorUserId, createdAt: at } });
    n++;
  }
  return n;
}

/** The platform's join status, mapped to the onboarding statuses here by meaning (OA 3.5: unmapped → Pre-qualified with a note). */
async function applyPlatformStatus(ticket, row, db) {
  const st = row.joinStatus;
  if (isPendingJoin(st) || isAccepted(st) || isRejected(st)) return ticket;
  let data; let note = null;
  if (isNotAnswer(st)) data = { status: 'failed_to_contact' };
  else if (isMissingDocuments(st)) data = { status: 'prequalified', stage: 'documents' };
  else if (isFollowup(st)) data = { status: 'prequalified' };
  else { data = { status: 'prequalified' }; note = `MDM status "${st}" has no onboarding status here — imported as Pre-qualified.`; }
  if (data.status === ticket.status && (!data.stage || data.stage === ticket.stage)) return ticket;
  const updated = await changeTicket(db, ticket, data, { action: 'ticket.imported_status', reason: `Status on the MDM platform: ${st}` });
  if (note) { const conv = await db.conversation.findFirst({ where: { contactId: ticket.contactId } }); if (conv) await addSystemLine(conv.id, note, db); }
  return updated;
}

/** What MDM ties to a merchant that is already here: the responsible agent, the account manager, the join history. */
async function carryPlatformData(contact, row, ctx, db) {
  if (row.responsibleRef && contact.mdmResponsibleRef !== row.responsibleRef) await db.contact.update({ where: { id: contact.id }, data: { mdmResponsibleRef: row.responsibleRef } });
  await importJoinHistory(contact.id, row, ctx, db);
  if (row.responsibleRef && ctx.agentsByRef?.size) {
    const t = await db.ticket.findFirst({ where: { contactId: contact.id, type: 'onboarding_task', status: { in: OPEN_OA } } });
    if (t) await assignLeadToPlatformAgent(t, ctx.agentsByRef.get(row.responsibleRef), {}, db);
  }
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
 * A skip carries a `code` (phone | duplicate | rejected | market | stale | no_ref) so the pull can
 * keep the seller aside for an Admin's decision (mdm-skipped.js).
 */
export async function upsertFromMdm(row, ctx, db = prisma) {
  const ref = row.mdmRef ?? row.sellerRef ?? row.id ?? null;
  const metrics = row.metrics ?? {};
  const existing = await sellerFor({ mdmRef: ref, phone: row.phone }, db);
  if (existing) {
    const { data, errors } = mirrorData(metrics);
    if (errors.length) return { ok: false, action: 'error', ref, reason: errors.join(' ') };
    await applyMirror(existing.id, data, db);
    if (row.accountManagerRef !== undefined && existing.mdmManagerRef !== (row.accountManagerRef ?? null)) {
      await db.seller.update({ where: { id: existing.id }, data: { mdmManagerRef: row.accountManagerRef ?? null } });
    }
    const contact = await db.contact.findUnique({ where: { id: existing.contactId } });
    if (contact) {
      await carryPlatformData(contact, row, ctx, db);
      if (row.accountManagerRef && ctx.managersByMdmRef?.size) await moveSellerToPlatformManager({ ...existing, mdmManagerRef: row.accountManagerRef }, ctx.managersByMdmRef.get(row.accountManagerRef), {}, db);
    }
    return { ok: true, action: 'updated', ref, sellerId: existing.id };
  }
  const skip = (code, reason) => ({ ok: false, action: 'skipped', code, ref, reason });
  let phone;
  try { phone = normalizePhone(row.phone); } catch { return skip('phone', 'No valid phone number.'); }
  const accepted = isAccepted(row.joinStatus) || !!row.activatedAt;
  // A merchant already here is reported as such whatever the platform says about its country.
  const contact = await db.contact.findUnique({ where: { phone } });
  if (contact) {
    if (ref && !contact.mdmRef) await db.contact.update({ where: { id: contact.id }, data: { mdmRef: String(ref) } });
    if (ref) await carryPlatformData(contact, { ...row, mdmRef: String(ref) }, ctx, db);
    return skip('duplicate', accepted
      ? 'Already an onboarding lead here — activate it in the onboarding console so the handoff record is complete.'
      : 'Already a contact here — linked to its platform id.');
  }
  if (isRejected(row.joinStatus)) return skip('rejected', `Rejected on the platform (${row.joinStatus}).`);
  const market = marketCode(row.country ?? row.market) || countryFromPhone(phone);
  if (!MARKETS.includes(market)) {
    const others = (row.countries ?? []).filter((c) => c && c !== market);
    return skip('market', `Market ${market || 'unknown'} is not Libya, Iraq or Lebanon${others.length ? ` (the platform also lists ${others.join(', ')} for this seller)` : ''}.`);
  }
  const activatedAt = dateOr(row.activatedAt) ?? (accepted ? (dateOr(row.joinStatusDate) ?? dateOr(row.createdAt) ?? new Date()) : null);
  if (!accepted) {
    const created = dateOr(row.createdAt);
    const maxAge = ctx.leadMaxAgeDays ?? mdmConfig().leadMaxAgeDays;
    if (created && Date.now() - created.getTime() > maxAge * DAY) {
      return skip('stale', `Registered ${created.toISOString().slice(0, 10)}, more than ${maxAge} days ago and never accepted — not opened as a lead.`);
    }
    const r = await registerMerchant({ phone, name: row.name, country: market, sourceUtm: row.utm ?? row.sourceUtm ?? 'mdm_platform' }, {}, db);
    // the merchant's record comes with them (OA 3.5): the registration date as on MDM, the status
    // MDM has for the join, the agent MDM holds responsible, and the join history — counters start at 0
    await db.contact.update({ where: { id: r.contact.id }, data: { ...(ref ? { mdmRef: String(ref) } : {}), mdmResponsibleRef: row.responsibleRef ?? null, ...(created ? { createdAt: created } : {}) } });
    let ticket = r.ticket ?? null;
    let owner = null;
    if (ticket) {
      if (created && created < ticket.createdAt) ticket = await db.ticket.update({ where: { id: ticket.id }, data: { createdAt: created } });
      ticket = await applyPlatformStatus(ticket, row, db);
      if (row.responsibleRef && ctx.agentsByRef?.size) {
        const agent = ctx.agentsByRef.get(row.responsibleRef);
        if (await assignLeadToPlatformAgent(ticket, agent, {}, db)) owner = agent.name;
      }
    }
    if (ref) await importJoinHistory(r.contact.id, { ...row, mdmRef: String(ref) }, ctx, db);
    return { ok: true, action: 'lead_created', ref, contactId: r.contact.id, ticketId: ticket?.id ?? null, owner };
  }
  if (!ref) return skip('no_ref', 'An activated seller needs its MDM seller id (mdmRef).');
  const { data: mirror, errors } = mirrorData(metrics);
  if (errors.length) return { ok: false, action: 'error', ref, reason: errors.join(' ') };
  // the platform's account manager keeps the seller when they are one of ours (imported from MDM,
  // or the same email); otherwise AM 3.2 picks the book
  let managerId = null; let ownership;
  const named = (row.accountManagerRef && ctx.managersByMdmRef?.get(row.accountManagerRef))
    ?? (row.managerEmail ? ctx.managers?.find((m) => m.email.toLowerCase() === row.managerEmail.toLowerCase()) : null);
  if (named) { managerId = named.id; ownership = `Kept with ${named.name} (account manager on the platform).`; }
  const { seller, ownership: placed } = await createSellerRecord({ phone, name: row.name || phone, market, mdmRef: String(ref), source: 'mdm_platform',
    activatedAt, welcomeCallAt: dateOr(row.welcomeCallAt), mirror, managerId, ownership }, { config: ctx.config, managers: ctx.managers ?? [] }, db);
  await db.contact.update({ where: { id: seller.contactId }, data: { mdmRef: String(ref), mdmResponsibleRef: row.responsibleRef ?? null } });
  if (row.accountManagerRef) await db.seller.update({ where: { id: seller.id }, data: { mdmManagerRef: row.accountManagerRef } });
  await importJoinHistory(seller.contactId, { ...row, mdmRef: String(ref) }, ctx, db);
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
let running = null; // one sync at a time: a press of "Sync now" during the scheduled run is refused

const refuse = () => {
  if (!mdmConfig().apiKey) throw Object.assign(new Error('The MDM platform connector is not configured (MDM_API_KEY).'), { status: 503, code: 'not_configured' });
  if (running) throw Object.assign(new Error('A sync is already running. Wait for it to finish — its progress shows under Recent runs.'), { status: 409, code: 'sync_running' });
};

export async function syncSellers(opts = {}) {
  refuse();
  running = runSync(opts);
  try { return await running; } finally { running = null; }
}

/**
 * Start a sync and return as soon as its run is recorded, so a page can follow it live under
 * Recent runs (a full run over thousands of sellers takes long; the outcome is on the run itself).
 */
export async function startSync(opts = {}) {
  refuse();
  let started; const recorded = new Promise((r) => { started = r; });
  const run = syncSellers({ ...opts, onStarted: started });
  run.catch(() => { /* the failure is written on the run */ });
  const runId = await Promise.race([recorded, run.then(() => null, () => null)]);
  return { started: true, runId };
}

// One line of platform figures for the live feed.
const figures = (m = {}) => [m.totalOrders != null ? `${m.totalOrders} orders` : null, m.deliveryRate != null ? `delivery ${m.deliveryRate}%` : null,
  m.returnRate != null ? `returns ${m.returnRate}%` : null, m.wallet != null ? `wallet ${m.wallet}` : null].filter(Boolean).join(', ') || 'no figures yet';

/** Runs left "running" by a restart can never finish: mark them as interrupted. */
export async function closeInterruptedRuns(db = prisma) {
  return db.integrationRun.updateMany({ where: { status: 'running' }, data: { status: 'failed', finishedAt: new Date(), summary: JSON.stringify({ errors: [{ error: 'Interrupted: the app restarted while this run was in progress.' }] }) } });
}

// Reasons are grouped (message → count, with a few example seller ids) so a run over thousands of
// sellers stays readable and small.
function tally(bucket, ref, reason) {
  const key = String(reason ?? 'unknown').replace(/\b[0-9a-f]{24}\b|\b[A-Z0-9-]{8,}\b/g, '…').slice(0, 300);
  const g = bucket[key] ??= { count: 0, examples: [] };
  g.count++;
  if (ref && g.examples.length < 5) g.examples.push(ref);
}

async function runSync({ actorId = null, full = false, fetchImpl = fetch, db = prisma, now = new Date(), onStarted = null } = {}) {
  const c = mdmConfig();
  const last = full ? null : await db.integrationRun.findFirst({ where: { kind: 'mdm_sync', status: 'completed' }, orderBy: { startedAt: 'desc' } });
  const api = client({ url: c.url, apiKey: c.apiKey, paymentPassword: c.paymentPassword, fetchImpl });
  const run = await db.integrationRun.create({ data: { kind: 'mdm_sync', status: 'running', actorId } });
  onStarted?.(run.id);
  const summary = { full: !last, total: null, fetched: 0, updated: 0, leadsCreated: 0, sellersCreated: 0, skippedCount: 0, errorCount: 0, warningCount: 0,
    reasons: { skipped: {}, errors: {}, warnings: {} }, live: { current: null, recent: [] }, staff: { read: 0, error: null }, aligned: { leads: 0, sellers: 0 } };
  const done = new Set();
  // Sellers kept aside earlier (waiting, or left out): if one now imports by the normal rules, its row is closed.
  const watched = await watchedRefs(db).catch(() => new Set());
  // The last 20 outcomes, newest first, so the page can show the import while it happens.
  const feed = (entry) => { summary.live.recent.unshift({ t: new Date().toISOString(), ...entry }); if (summary.live.recent.length > 20) summary.live.recent.length = 20; };
  const record = async (r, row, metrics = {}) => {
    if (r.action === 'updated') summary.updated++;
    else if (r.action === 'lead_created') summary.leadsCreated++;
    else if (r.action === 'seller_created') summary.sellersCreated++;
    else if (r.action === 'skipped') { summary.skippedCount++; tally(summary.reasons.skipped, r.ref ?? row?.phone, r.reason); }
    else { summary.errorCount++; tally(summary.reasons.errors, r.ref, r.reason); }
    feed({ ref: r.ref ?? row?.mdmRef ?? null, name: row?.name ?? null, action: r.action,
      note: r.action === 'seller_created' ? `${row?.country ?? ''} book · ${figures(metrics)}${r.ownership ? ` · ${r.ownership}` : ''}`
        : r.action === 'updated' ? figures(metrics)
          : r.action === 'lead_created' ? `onboarding lead${row?.country ? ` (${row.country})` : ''}${r.owner ? ` · ${r.owner} (responsible on MDM)` : ''}`
            : (r.reason ?? '') });
    // Every skipped seller is kept aside, with what the platform says, for an Admin's decision.
    const ref = row?.mdmRef ?? r.ref;
    if (!ref) return;
    if (r.action === 'skipped') await rememberSkipped(row, r, { runId: run.id }, db).catch((err) => { summary.errorCount++; tally(summary.reasons.errors, ref, `skipped list: ${err.message}`); });
    else if (r.ok && watched.has(ref)) await markImported(ref, r.action, {}, db).catch(() => {});
  };
  const warn = (ref, warnings) => { for (const w of warnings) { summary.warningCount++; tally(summary.reasons.warnings, ref, w); } };
  let savedAt = 0;
  const save = (status) => { savedAt = Date.now(); return db.integrationRun.update({ where: { id: run.id }, data: { status, ...(status === 'running' ? {} : { finishedAt: new Date() }), summary: JSON.stringify(summary) } }); };
  // Progress is written at most every 2 seconds, so the page can follow the run live.
  const progress = (ref) => { summary.live.current = ref; return Date.now() - savedAt >= 2000 ? save('running') : null; };
  try {
    const since = last?.startedAt ?? null;
    // platform account managers by id → their email, to keep an existing owner who is one of ours
    const managers = await managersByEmail(api).catch(() => new Map());
    const platformManagers = new Map([...managers.values()].map((m) => [m.trackingId, m.email]));
    // Every platform user, kept aside for the Admin (People on MDM). A refusal here does not stop
    // the sellers: it is reported, so the API key's rights can be extended.
    const countries = new Set((await db.mdmCountry.findMany({ select: { id: true } })).map((r) => r.id));
    const learnCountries = async (places) => {
      for (const p of places ?? []) {
        if (!p?.id || !p.code || countries.has(p.id)) continue;
        countries.add(p.id);
        await db.mdmCountry.upsert({ where: { id: p.id }, update: { code: p.code, name: p.name ?? null }, create: { id: p.id, code: p.code, name: p.name ?? null } }).catch(() => {});
      }
    };
    for (const m of managers.values()) await learnCountries([{ id: m.countryId ?? m.country?.id ?? null, code: m.country?.code ? marketCode(m.country.code) : null, name: m.country?.name ?? null }]);
    try {
      const index = await countryIndex(db);
      for await (const u of platformUsers(api)) {
        const row = userToRow(u);
        if (!row.mdmRef) continue;
        await rememberStaff(row, { runId: run.id, now: new Date(), index, managerRef: row.email ? managers.get(row.email)?.trackingId ?? null : null }, db);
        summary.staff.read++;
      }
    } catch (err) { summary.staff.error = err.message; summary.warningCount++; tally(summary.reasons.warnings, 'users', `people on MDM: ${err.message}`); }
    const ctx = await upsertContext(db); // after the staff step: the agents and managers MDM names may be ours now
    if (!since) summary.total = await api.count(PATHS.sellers).catch(() => null); // how far a full run is
    for await (const s of api.search(PATHS.sellers, { sortBy: { updatedAt: 'DESC' } })) {
      const row = sellerToRow(s);
      if (since && row.updatedAt && row.updatedAt < since) break; // newest first: the rest are unchanged
      summary.fetched++;
      await progress(row.mdmRef ?? null);
      await learnCountries(row.places);
      if (!row.mdmRef || done.has(row.mdmRef)) continue;
      done.add(row.mdmRef);
      try {
        const known = await sellerFor({ mdmRef: row.mdmRef, phone: row.phone }, db).catch(() => null);
        let metrics = {};
        if (known || isAccepted(row.joinStatus)) {
          const m = await sellerMetrics(api, row.mdmRef, { now, countryId: row.countryId });
          metrics = m.metrics; warn(row.mdmRef, m.warnings);
        }
        await record(await upsertFromMdm({ ...row, metrics, managerEmail: platformManagers.get(row.accountManagerRef) ?? null }, ctx, db), row, metrics);
      } catch (err) { await record({ action: 'error', ref: row.mdmRef, reason: err.message }, row); }
    }
    const refs = since ? [...await sellersWithOrderChanges(api, since, now)] : [];
    for (const ref of refs) {
      if (done.has(ref)) continue;
      done.add(ref);
      const seller = await sellerFor({ mdmRef: ref }, db);
      if (!seller) continue; // not one of ours yet: it arrives with its seller record
      await progress(ref);
      try {
        const countryId = c.paymentPassword ? sellerToRow((await api.call('GET', `/api/sellers/${encodeURIComponent(ref)}`)) ?? {}).countryId : null;
        const m = await sellerMetrics(api, ref, { now, countryId });
        warn(ref, m.warnings);
        const { data, errors } = mirrorData(m.metrics);
        if (errors.length) { await record({ action: 'error', ref, reason: errors.join(' ') }); continue; }
        await applyMirror(seller.id, data, db);
        await record({ ok: true, action: 'updated', ref }, { mdmRef: ref }, m.metrics);
      } catch (err) { await record({ action: 'error', ref, reason: err.message }); }
    }
    // Sellers an Admin placed from the skipped list have no platform figures yet: read them now
    // (at most 50 per run, oldest decision first; a full run has already read the rest above).
    const placed = await db.mdmSkipped.findMany({ where: { decision: 'placed', figuresAt: null }, orderBy: { decidedAt: 'asc' }, take: 50 });
    for (const h of placed) {
      const ref = h.mdmRef;
      const seller = await db.seller.findUnique({ where: { mdmRef: ref } });
      if (!seller || done.has(ref)) { await db.mdmSkipped.update({ where: { id: h.id }, data: { figuresAt: new Date() } }); continue; }
      done.add(ref);
      await progress(ref);
      try {
        let platform = {};
        try { platform = JSON.parse(h.platform); } catch { /* the snapshot is informative only */ }
        const countryId = (platform.places ?? []).find((p) => p?.code === seller.market)?.id ?? h.countryId ?? null;
        const m = await sellerMetrics(api, ref, { now, countryId });
        warn(ref, m.warnings);
        const { data, errors } = mirrorData(m.metrics);
        if (errors.length) { await record({ action: 'error', ref, reason: errors.join(' ') }, { mdmRef: ref, name: h.name }); continue; }
        await applyMirror(seller.id, data, db);
        await db.mdmSkipped.update({ where: { id: h.id }, data: { figuresAt: new Date() } });
        await record({ ok: true, action: 'updated', ref }, { mdmRef: ref, name: h.name }, m.metrics);
      } catch (err) { await record({ action: 'error', ref, reason: err.message }, { mdmRef: ref, name: h.name }); }
    }
    // country ids learnt from the sellers of this run → markets for the people read before them
    await refreshStaffMarkets(await countryIndex(db), db).catch((err) => { summary.warningCount++; tally(summary.reasons.warnings, 'users', err.message); });
    // their data comes with them: whatever MDM ties to people imported since the last run
    summary.aligned = await alignOwnership({ actorId }, db).catch((err) => { summary.warningCount++; tally(summary.reasons.warnings, 'ownership', err.message); return { leads: 0, sellers: 0 }; });
    summary.live.current = null;
    await save('completed');
  } catch (err) {
    summary.errorCount++; tally(summary.reasons.errors, null, err.message);
    summary.live.current = null;
    await save('failed');
    await logEvent({ actorId, entityType: 'system', entityId: 'mdm.sync', action: 'mdm.sync_failed', reason: err.message }, db);
    throw err;
  }
  await logEvent({ actorId, entityType: 'system', entityId: 'mdm.sync', action: 'mdm.sync', after: { full: summary.full, fetched: summary.fetched, updated: summary.updated, leadsCreated: summary.leadsCreated, sellersCreated: summary.sellersCreated, skipped: summary.skippedCount, errors: summary.errorCount } }, db);
  return summary;
}
