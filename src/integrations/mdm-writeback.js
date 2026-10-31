// Write-back to the MDM platform: what the onboarding and account management teams do here goes
// back to the platform, so both systems show the same state.
//
// The source is the audit log (EventLog). Every state change in this app is already written there,
// once and in order, so it doubles as the outbox: a cursor (kept on IntegrationRun rows of kind
// mdm_writeback) marks the last entry delivered. Each push sends the next batch, oldest first, and
// moves the cursor only when the platform accepts it, so a failed delivery is retried as it was
// and nothing is skipped or sent out of order. Every event carries its audit id for de-duplication.
//
// Only the work this app owns is sent: onboarding status and activation, ownership, call outcomes,
// tasks and playbook steps, with a snapshot of the merchant (owner, onboarding status, health and
// lifecycle stage). Platform figures (orders, wallet, catalogue) are never sent back: they come from
// the platform and are read-only here. Events that came from the platform itself are not echoed.
//
// The platform's public API has no endpoint for this yet, so the destination is a setting:
// MDM_WRITEBACK_URL (any HTTPS endpoint the MDM team exposes), sent with the same x-api-key.
// Until it is set nothing is sent and the Integrations page says so.
import { prisma } from '../db.js';
import { mdmConfig } from './mdm.js';

const BATCH = 100;

export const PUSHED_ACTIONS = [
  'ticket.assigned', 'ticket.reassigned', 'ticket.taken_over', 'ticket.status_changed', 'ticket.held',
  'ticket.call_logged', 'ticket.walkthrough_booked', 'ticket.hub_sent', 'ticket.followup_sent', 'ticket.activated',
  'SELLER_ASSIGNED', 'seller.reassigned', 'seller.accepted', 'seller.churned', 'seller.call_logged', 'seller.unassigned_alert',
  'am_task.opened', 'am_task.upgraded', 'am_task.rescheduled', 'am_task.escalated', 'am_task.closed', 'playbook.ticked',
];

export const writebackConfig = () => ({ url: process.env.MDM_WRITEBACK_URL || null, apiKey: mdmConfig().apiKey });

async function cursorOf(db) {
  const last = await db.integrationRun.findFirst({ where: { kind: 'mdm_writeback', status: 'completed' }, orderBy: { startedAt: 'desc' } });
  return last ? JSON.parse(last.summary).cursor ?? null : null;
}

function afterCursor(cursor) {
  const base = { action: { in: PUSHED_ACTIONS } };
  if (!cursor) return base;
  const at = new Date(cursor.at);
  return { ...base, OR: [{ createdAt: { gt: at } }, { createdAt: at, id: { gt: cursor.id } }] };
}

async function merchantOf(entityType, entityId, db, cache) {
  const key = `${entityType}:${entityId}`;
  if (cache.has(key)) return cache.get(key);
  let contactId = null;
  if (entityType === 'ticket') contactId = (await db.ticket.findUnique({ where: { id: entityId }, select: { contactId: true } }))?.contactId;
  else if (entityType === 'seller') contactId = (await db.seller.findUnique({ where: { id: entityId }, select: { contactId: true } }))?.contactId;
  else if (entityType === 'contact') contactId = entityId;
  let snap = null;
  if (contactId) {
    const c = await db.contact.findUnique({ where: { id: contactId }, include: { seller: { include: { accountManager: true } } } });
    const t = await db.ticket.findFirst({ where: { contactId, type: 'onboarding_task' }, orderBy: { createdAt: 'desc' }, include: { assignee: true } });
    const s = c?.seller;
    snap = c && {
      sellerId: s?.mdmRef ?? null, phone: c.phone, name: c.name, country: c.country,
      onboarding: t ? { status: t.status, stage: t.stage, agent: t.assignee ? { name: t.assignee.name, email: t.assignee.email } : null, activatedAt: s?.activatedAt ?? null } : null,
      accountManager: s?.accountManager ? { name: s.accountManager.name, email: s.accountManager.email } : null,
      health: s ? { score: s.healthScore, band: s.healthBand, computedAt: s.healthComputedAt } : null,
      lifecycleStage: s?.stage ?? null,
    };
  }
  cache.set(key, snap);
  return snap;
}

/** What is waiting to be sent. */
export async function writebackStatus(db = prisma) {
  const c = writebackConfig();
  const cursor = await cursorOf(db);
  const pending = await db.eventLog.count({ where: afterCursor(cursor) });
  const last = await db.integrationRun.findFirst({ where: { kind: 'mdm_writeback' }, orderBy: { startedAt: 'desc' } });
  return {
    on: !!(c.url && c.apiKey), pending,
    last: last ? { at: last.finishedAt ?? last.startedAt, status: last.status, summary: JSON.parse(last.summary) } : null,
    detail: c.url && c.apiKey ? `Sending updates to ${c.url}.` : 'Off — set MDM_WRITEBACK_URL (the endpoint the MDM team exposes for updates) and MDM_API_KEY.',
  };
}

/** Send everything after the cursor, in batches, stopping at the first refusal. */
export async function pushPending({ fetchImpl = fetch, db = prisma } = {}) {
  const c = writebackConfig();
  if (!c.url || !c.apiKey) return { sent: 0, skipped: true, reason: 'MDM_WRITEBACK_URL or MDM_API_KEY is not set.' };
  let cursor = await cursorOf(db);
  let sent = 0;
  for (;;) {
    const rows = await db.eventLog.findMany({ where: afterCursor(cursor), orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: BATCH });
    if (!rows.length) break;
    const cache = new Map();
    const actors = new Map((await db.user.findMany({ where: { id: { in: rows.map((r) => r.actorId).filter(Boolean) } } })).map((u) => [u.id, u]));
    const events = [];
    for (const r of rows) {
      const merchant = await merchantOf(r.entityType, r.entityId, db, cache);
      if (!merchant) continue;
      const by = r.actorId ? actors.get(r.actorId) : null;
      events.push({
        id: r.id, type: r.action, at: r.createdAt, merchant,
        by: by ? { name: by.name, email: by.email, role: by.role } : { name: 'rule', role: 'system' },
        before: r.before ? JSON.parse(r.before) : null, after: r.after ? JSON.parse(r.after) : null, reason: r.reason,
      });
    }
    const next = { at: rows.at(-1).createdAt.toISOString(), id: rows.at(-1).id };
    const run = await db.integrationRun.create({ data: { kind: 'mdm_writeback', status: 'running' } });
    try {
      if (events.length) {
        const res = await fetchImpl(c.url, { method: 'POST', headers: { 'x-api-key': c.apiKey, 'content-type': 'application/json' }, body: JSON.stringify({ events }) });
        if (!res.ok) throw new Error(`MDM platform responded ${res.status}`);
      }
    } catch (err) {
      await db.integrationRun.update({ where: { id: run.id }, data: { status: 'failed', finishedAt: new Date(), summary: JSON.stringify({ cursor, error: err.message, attempted: events.length }) } });
      return { sent, failed: true, error: err.message };
    }
    await db.integrationRun.update({ where: { id: run.id }, data: { status: 'completed', finishedAt: new Date(), summary: JSON.stringify({ cursor: next, sent: events.length }) } });
    cursor = next; sent += events.length;
    if (rows.length < BATCH) break;
  }
  return { sent };
}
