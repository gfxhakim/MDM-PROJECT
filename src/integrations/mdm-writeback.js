// Write-back to the MDM platform: the work the onboarding and account management teams do here is
// recorded on the platform too, through its own API, so both systems show the same state.
//
// The source is the audit log (EventLog): every state change in this app is already written there
// once and in order, so it doubles as the outbox. A cursor (kept on IntegrationRun rows of kind
// mdm_writeback) marks the last entry handled. Entries are handled oldest first:
//   • a call the platform accepts, or an entry with nothing to send, moves the cursor on;
//   • a refusal the platform gives for that one record (4xx — e.g. its join flags no longer allow
//     the action) is recorded as skipped with the platform's reason, and the cursor moves on;
//   • a platform or network failure (5xx, timeout) stops the run; the same entry is retried next time.
//
// What is sent (MDM endpoints from its OpenAPI spec):
//   onboarding call, no answer         → PATCH /api/sellers/{id}/join/not-answer  { notes }
//   other calls, walkthroughs, status
//   changes and activation             → PATCH /api/sellers/{id}/join/followup    { notes }
//   account manager assigned/changed   → POST  /api/omni-channel/account-managers/sellers/{id} { accountManagerId }
//                                        (our manager is matched to the platform's by email)
// Never sent: Accept and Reject. Accept creates the seller's platform login (password, services)
// and Reject cannot be undone, so platform staff press those. Platform figures (orders, wallet,
// catalogue) are never sent back: they come from the platform.
//
// Off unless MDM_WRITEBACK=on (and MDM_API_KEY is set). It starts from the moment it is first
// switched on: earlier work is not replayed.
import { prisma } from '../db.js';
import { mdmConfig } from './mdm.js';
import { MdmApiError, PATHS, client, managersByEmail } from './mdm-api.js';

const BATCH = 100;

export const PUSHED_ACTIONS = ['ticket.call_logged', 'ticket.walkthrough_booked', 'ticket.status_changed', 'ticket.activated', 'SELLER_ASSIGNED', 'seller.reassigned'];

export const writebackConfig = () => ({ on: /^(on|true|1|yes)$/i.test(process.env.MDM_WRITEBACK || ''), ...mdmConfig() });

async function cursorOf(db) {
  const last = await db.integrationRun.findFirst({ where: { kind: 'mdm_writeback', status: { in: ['completed', 'failed'] } }, orderBy: { startedAt: 'desc' } });
  return last ? JSON.parse(last.summary).cursor ?? null : null;
}

function afterCursor(cursor) {
  const base = { action: { in: PUSHED_ACTIONS } };
  if (!cursor) return base;
  const at = new Date(cursor.at);
  return { ...base, OR: [{ createdAt: { gt: at } }, { createdAt: at, id: { gt: cursor.id } }] };
}

/** The platform seller id for an audit entry's subject, or null when it has none (a local-only lead). */
async function platformIdOf(entry, db) {
  let contact = null;
  if (entry.entityType === 'ticket') contact = (await db.ticket.findUnique({ where: { id: entry.entityId }, include: { contact: { include: { seller: true } } } }))?.contact;
  else if (entry.entityType === 'seller') contact = (await db.seller.findUnique({ where: { id: entry.entityId }, include: { contact: { include: { seller: true } } } }))?.contact;
  if (!contact) return null;
  const ref = contact.mdmRef ?? contact.seller?.mdmRef ?? null;
  return ref && !/^(LOCAL|ZOHO)-/.test(ref) ? ref : null;
}

const STATUS = { new: 'New', failed_to_contact: 'Failed to contact', prequalified: 'Prequalified', qualified: 'Qualified', activated: 'Activated', cold_lead: 'Cold lead', junk_lead: 'Junk lead' };
const parse = (v) => (v ? JSON.parse(v) : {});

/** The single platform call an audit entry becomes, or null. */
export async function planFor(entry, { db = prisma, managerIdFor }) {
  const id = await platformIdOf(entry, db);
  if (!id) return null;
  const after = parse(entry.after);
  const who = entry.actorId ? (await db.user.findUnique({ where: { id: entry.actorId } }))?.name : 'Automation rule';
  const note = (text) => ({ method: 'PATCH', path: PATHS.join(id, 'followup'), body: { notes: `${text} — ${who}, onboarding console` } });
  switch (entry.action) {
    case 'ticket.call_logged':
      if (entry.reason === 'no_answer') return { method: 'PATCH', path: PATHS.join(id, 'not-answer'), body: { notes: `No answer${after.attemptNo ? ` (attempt ${after.attemptNo})` : ''} — ${who}, onboarding console` } };
      return note(`Call answered (${entry.reason === 'answered_strong' ? 'strong interest' : 'soft interest'})`);
    case 'ticket.walkthrough_booked':
      return note(`Walkthrough booked${after.walkthroughAt ? ` for ${after.walkthroughAt.slice(0, 16).replace('T', ' ')} UTC` : ''}`);
    case 'ticket.status_changed':
      return after.status ? note(`Onboarding status: ${STATUS[after.status] ?? after.status}${entry.reason ? ` (${entry.reason})` : ''}`) : null;
    case 'ticket.activated':
      return note(`Activated in onboarding${entry.reason ? ` — ${entry.reason}` : ''}. Ready to accept on MDM`);
    case 'SELLER_ASSIGNED':
    case 'seller.reassigned': {
      if (!after.assignedAccountManagerId) return null;
      const managerId = await managerIdFor(after.assignedAccountManagerId);
      if (!managerId) return { skip: 'This account manager has no MDM account with the same email.' };
      return { method: 'POST', path: PATHS.assignManager(id), body: { accountManagerId: managerId } };
    }
    default:
      return null;
  }
}

export async function writebackStatus(db = prisma) {
  const c = writebackConfig();
  const pending = await db.eventLog.count({ where: afterCursor(await cursorOf(db)) });
  const last = await db.integrationRun.findFirst({ where: { kind: 'mdm_writeback' }, orderBy: { startedAt: 'desc' } });
  return {
    on: c.on && !!c.apiKey, pending,
    last: last ? { at: last.finishedAt ?? last.startedAt, status: last.status, summary: JSON.parse(last.summary) } : null,
    detail: c.on && c.apiKey
      ? 'Call outcomes, onboarding status and account-manager changes are recorded on MDM.'
      : 'Off — set MDM_API_KEY and MDM_WRITEBACK=on to record our work on MDM.',
  };
}

/** Handle every entry after the cursor; stop at the first platform or network failure. */
export async function pushPending({ fetchImpl = fetch, db = prisma } = {}) {
  const c = writebackConfig();
  if (!c.on || !c.apiKey) return { sent: 0, skipped: true, reason: 'MDM_WRITEBACK is not on, or MDM_API_KEY is not set.' };
  const api = client({ url: c.url, apiKey: c.apiKey, fetchImpl });
  let platformManagers = null;
  const managerIdFor = async (userId) => {
    platformManagers ??= await managersByEmail(api);
    const u = await db.user.findUnique({ where: { id: userId } });
    return u ? platformManagers.get(u.email.toLowerCase())?.trackingId ?? null : null;
  };
  let cursor = await cursorOf(db);
  if (!cursor && !(await db.integrationRun.count({ where: { kind: 'mdm_writeback' } }))) {
    // First run after switching on: start from now. Work done before the switch is not replayed
    // onto the platform as a burst of old notes.
    const latest = await db.eventLog.findFirst({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    const start = latest ? { at: latest.createdAt.toISOString(), id: latest.id } : { at: new Date(0).toISOString(), id: '' };
    await db.integrationRun.create({ data: { kind: 'mdm_writeback', status: 'completed', finishedAt: new Date(), summary: JSON.stringify({ cursor: start, started: true, sent: 0, refused: [] }) } });
    cursor = start;
  }
  const totals = { sent: 0, refused: [] };
  for (;;) {
    const rows = await db.eventLog.findMany({ where: afterCursor(cursor), orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: BATCH });
    if (!rows.length) break;
    const run = await db.integrationRun.create({ data: { kind: 'mdm_writeback', status: 'running' } });
    const batch = { sent: 0, refused: [] };
    let failure = null;
    for (const r of rows) {
      try {
        const plan = await planFor(r, { db, managerIdFor });
        if (plan?.skip) batch.refused.push({ event: r.id, type: r.action, reason: plan.skip });
        else if (plan) { await api.call(plan.method, plan.path, { body: plan.body }); batch.sent++; }
      } catch (err) {
        if (err instanceof MdmApiError && err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 429) {
          batch.refused.push({ event: r.id, type: r.action, reason: err.message });
        } else { failure = err; break; }
      }
      cursor = { at: r.createdAt.toISOString(), id: r.id };
    }
    totals.sent += batch.sent; totals.refused.push(...batch.refused);
    await db.integrationRun.update({ where: { id: run.id }, data: {
      status: failure ? 'failed' : 'completed', finishedAt: new Date(),
      summary: JSON.stringify({ cursor, ...batch, ...(failure ? { error: failure.message } : {}) }),
    } });
    if (failure) return { ...totals, failed: true, error: failure.message };
    if (rows.length < BATCH) break;
  }
  return totals;
}
