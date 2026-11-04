// Deleting merchants from this app (Admin only): leads, sellers, and sellers kept aside by the MDM
// import. A merchant is one contact with one conversation (CLAUDE.md), so deleting a lead or a seller
// deletes that merchant here: the contact, the conversation and its messages, every ticket and task,
// the seller record with its health history and playbook. MDM is never touched — its API offers no
// delete for sellers — so each deletion leaves a record (DeletedMerchant) that keeps the merchant
// out of the sync (matched by MDM id or phone) until an Admin restores it.
//
// Guardrails as for the other bulk runs (OA 13.2): at most 200 per run, a written reason, each item
// handled and reported on its own, one audit entry with the full list (plus one per merchant).
// Template sends that are deleted still count against the month's template budget.
import { prisma, inTx } from '../db.js';
import { badRequest, forbidden } from '../http/errors.js';
import { logEvent } from '../services/audit.js';
import { grant } from '../auth/permissions.js';
import { normalizePhone } from './contacts.js';
import { fullNextRun, setPaused } from '../integrations/mdm-control.js';

export const DELETE_KINDS = { leads: 'lead', sellers: 'seller', skipped: 'skipped' };
export const MAX_DELETE = 200;
const parse = (s, fallback) => { try { return JSON.parse(s) ?? fallback; } catch { return fallback; } };
const phoneOf = (raw) => { try { return normalizePhone(raw); } catch { return raw ? String(raw) : null; } };

/** MDM ids and phones the sync must leave alone (deleted here, not restored). */
export async function deletedIndex(db = prisma) {
  const rows = await db.deletedMerchant.findMany({ where: { keepOut: true }, select: { mdmRef: true, phone: true } });
  return { refs: new Set(rows.map((r) => r.mdmRef).filter(Boolean)), phones: new Set(rows.map((r) => r.phone).filter(Boolean)) };
}

/** True when a platform row belongs to a merchant deleted here and kept out. */
export function isKeptOut(index, { mdmRef, phone }) {
  if (!index) return false;
  if (mdmRef && index.refs.has(String(mdmRef))) return true;
  const p = phone ? phoneOf(phone) : null;
  return !!(p && index.phones.has(p));
}

/** Template sends this month that belonged to deleted merchants (they stay spent). */
export async function deletedTemplateSends({ since, keys }, db = prisma) {
  const rows = await db.deletedMerchant.findMany({ where: { deletedAt: { gte: since }, NOT: { templateSends: '[]' } }, select: { templateSends: true } });
  let n = 0;
  for (const r of rows) for (const s of parse(r.templateSends, [])) if (new Date(s.at) >= since && (!keys || keys.includes(s.key))) n++;
  return n;
}

/** Delete one merchant (contact) and everything hanging off it. Returns what was deleted. */
async function deleteContact(contactId, db) {
  return inTx(db, async (tx) => {
    const contact = await tx.contact.findUnique({ where: { id: contactId } });
    if (!contact) return null;
    const seller = await tx.seller.findUnique({ where: { contactId } });
    const conv = await tx.conversation.findUnique({ where: { contactId } });
    const tickets = await tx.ticket.findMany({ where: { OR: [{ contactId }, ...(seller ? [{ sellerId: seller.id }] : [])] } });
    const names = new Map((await tx.user.findMany({ where: { id: { in: [...new Set([...tickets.map((t) => t.assigneeId), seller?.assignedAccountManagerId].filter(Boolean))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    const sends = conv ? await tx.message.findMany({ where: { conversationId: conv.id, kind: 'template', direction: 'out' }, select: { createdAt: true, templateKey: true } }) : [];
    const messages = conv ? await tx.message.count({ where: { conversationId: conv.id } }) : 0;
    const ticketIds = tickets.map((t) => t.id);
    await tx.notification.deleteMany({ where: { ticketId: { in: ticketIds } } });
    if (seller) {
      await tx.playbookProgress.deleteMany({ where: { sellerId: seller.id } });
      await tx.healthHistory.deleteMany({ where: { sellerId: seller.id } });
    }
    await tx.ticket.deleteMany({ where: { id: { in: ticketIds } } });
    if (seller) await tx.seller.delete({ where: { id: seller.id } });
    if (conv) {
      await tx.message.deleteMany({ where: { conversationId: conv.id } });
      await tx.conversation.delete({ where: { id: conv.id } });
    }
    await tx.contact.delete({ where: { id: contactId } });
    const mdmRef = contact.mdmRef ?? seller?.mdmRef ?? null;
    if (mdmRef) await tx.mdmSkipped.deleteMany({ where: { mdmRef } });
    return {
      contact, seller, mdmRef,
      templateSends: sends.map((m) => ({ at: m.createdAt.toISOString(), key: m.templateKey })),
      snapshot: {
        name: contact.name, phone: contact.phone, country: contact.country, mdmRef, source: contact.sourceUtm,
        registeredAt: contact.mdmCreatedAt ?? contact.createdAt, messages,
        tickets: tickets.map((t) => ({ id: t.id, type: t.type, status: t.status, owner: t.assigneeId ? names.get(t.assigneeId) ?? t.assigneeId : null, createdAt: t.createdAt })),
        seller: seller ? { id: seller.id, mdmRef: seller.mdmRef, market: seller.market, stage: seller.stage, health: seller.healthScore,
          accountManager: seller.assignedAccountManagerId ? names.get(seller.assignedAccountManagerId) ?? seller.assignedAccountManagerId : null } : null,
      },
    };
  });
}

/**
 * One deletion run. kind: leads (ticket ids) | sellers (seller ids) | skipped (ids on the Skipped
 * sellers list). keepOut: the merchant stays out of the sync until restored.
 */
export async function deleteRecords(user, { kind, ids, reason, keepOut = true } = {}, db = prisma) {
  if (!grant(user.role, 'records.delete')) throw forbidden('Deleting records is reserved to the Administrator.');
  if (!DELETE_KINDS[kind]) throw badRequest(`kind must be one of ${Object.keys(DELETE_KINDS).join(', ')}.`);
  if (!Array.isArray(ids) || !ids.length) throw badRequest('Select at least one row.');
  const unique = [...new Set(ids.map(String))];
  if (unique.length > MAX_DELETE) throw badRequest(`At most ${MAX_DELETE} rows per run — narrow the filter or run it again.`);
  if (typeof reason !== 'string' || !reason.trim()) throw badRequest('A written reason is required to delete.');
  const why = reason.trim();
  const now = new Date();
  const batchId = `delete:${kind}:${now.toISOString()}`;
  const results = [];
  const seen = new Set(); // two tickets of the same merchant: deleted once
  for (const id of unique) {
    const out = { id, ok: false };
    results.push(out);
    try {
      if (kind === 'skipped') {
        const h = await db.mdmSkipped.findUnique({ where: { id } });
        if (!h) throw new Error('No longer on the list.');
        out.name = h.name; out.mdmRef = h.mdmRef;
        if (h.decision && h.decision !== 'left_out') throw new Error(`Already ${h.decision === 'placed' ? 'placed as a seller' : h.decision === 'lead' ? 'opened as a lead' : 'imported'} here — delete it from the ${h.decision === 'lead' ? 'leads' : 'sellers'} list.`);
        await db.mdmSkipped.delete({ where: { id } });
        const phone = h.phone ? phoneOf(h.phone) : null;
        await db.deletedMerchant.create({ data: { kind: 'skipped', name: h.name, phone, mdmRef: h.mdmRef, snapshot: JSON.stringify({ name: h.name, phone: h.phone, mdmRef: h.mdmRef, reason: h.reason, registeredAt: h.registeredAt, country: h.country }), keepOut, reason: why, batchId, deletedById: user.id, deletedAt: now } });
        out.ok = true; out.outcome = keepOut ? 'Deleted from the list; the sync leaves it out.' : 'Deleted from the list.';
        continue;
      }
      const row = kind === 'leads'
        ? await db.ticket.findUnique({ where: { id }, include: { contact: true } })
        : await db.seller.findUnique({ where: { id }, include: { contact: true } });
      if (!row || (kind === 'leads' && row.type !== 'onboarding_task')) throw new Error(kind === 'leads' ? 'No such lead.' : 'No such seller.');
      out.name = row.contact?.name ?? null;
      if (seen.has(row.contactId)) { out.ok = true; out.outcome = 'Same merchant as another selected row — deleted with it.'; continue; }
      seen.add(row.contactId);
      const gone = await deleteContact(row.contactId, db);
      if (!gone) throw new Error('Already deleted.');
      const alsoSeller = kind === 'leads' && gone.seller;
      await db.deletedMerchant.create({ data: { kind: DELETE_KINDS[kind], name: gone.contact.name, phone: gone.contact.phone, mdmRef: gone.mdmRef, contactId: gone.contact.id,
        snapshot: JSON.stringify(gone.snapshot), templateSends: JSON.stringify(gone.templateSends), keepOut, reason: why, batchId, deletedById: user.id, deletedAt: now } });
      await logEvent({ actorId: user.id, entityType: 'contact', entityId: gone.contact.id, action: 'contact.deleted', before: gone.snapshot, after: { keepOut, batchId }, reason: why }, db);
      out.ok = true; out.mdmRef = gone.mdmRef;
      out.outcome = `Deleted: contact, conversation (${gone.snapshot.messages} messages), ${gone.snapshot.tickets.length} ticket${gone.snapshot.tickets.length === 1 ? '' : 's'}${gone.seller ? ', seller record' : ''}.${alsoSeller ? ' This merchant was also a seller in a book.' : ''}${keepOut && gone.mdmRef ? ' The sync leaves it out.' : ''}`;
    } catch (err) {
      out.reason = err.message;
    }
  }
  const done = results.filter((r) => r.ok).length;
  const summary = { kind, keepOut, requested: results.length, done, failed: results.length - done };
  await logEvent({ actorId: user.id, entityType: 'bulk', entityId: batchId, action: 'records.deleted', after: { ...summary, items: results }, reason: why }, db);
  return { batchId, ...summary, results };
}

/** The deleted merchants, newest first (for the Integrations page). */
export async function listDeleted({ kind = null, from = null, to = null, q = null, restored = false } = {}, db = prisma) {
  // kind "all" is the bookkeeping row of a "Delete all data" run (its template sends): not a merchant
  const where = { ...(restored ? {} : { restoredAt: null }), kind: kind && kind !== 'all' ? kind : { not: 'all' } };
  if (from || to) where.deletedAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
  const s = String(q ?? '').trim();
  if (s) where.OR = [{ name: { contains: s } }, { phone: { contains: s } }, { mdmRef: { contains: s } }];
  const rows = await db.deletedMerchant.findMany({ where, orderBy: { deletedAt: 'desc' }, take: 1000 });
  const people = new Map((await db.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => [r.deletedById, r.restoredById]).filter(Boolean))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  return {
    items: rows.map((r) => ({ id: r.id, kind: r.kind, name: r.name, phone: r.phone, mdmRef: r.mdmRef, reason: r.reason, keepOut: r.keepOut,
      deletedAt: r.deletedAt, deletedBy: r.deletedById ? people.get(r.deletedById) ?? null : null, restoredAt: r.restoredAt, restoredBy: r.restoredById ? people.get(r.restoredById) ?? null : null,
      snapshot: parse(r.snapshot, {}) })),
    total: await db.deletedMerchant.count({ where: { restoredAt: null, kind: { not: 'all' } } }),
    limit: MAX_DELETE,
  };
}

/** Let the sync bring deleted merchants back (their history here is not restored). */
export async function restoreDeleted(user, { ids, reason } = {}, db = prisma) {
  if (!grant(user.role, 'records.delete')) throw forbidden('Restoring deleted records is reserved to the Administrator.');
  if (!Array.isArray(ids) || !ids.length) throw badRequest('Select at least one row.');
  if (ids.length > MAX_DELETE) throw badRequest(`At most ${MAX_DELETE} rows per run.`);
  if (typeof reason !== 'string' || !reason.trim()) throw badRequest('A written reason is required.');
  const now = new Date();
  const results = [];
  for (const id of [...new Set(ids.map(String))]) {
    const r = await db.deletedMerchant.findUnique({ where: { id } });
    if (!r || r.kind === 'all') { results.push({ id, ok: false, reason: 'No such deleted record.' }); continue; }
    if (r.restoredAt) { results.push({ id, ok: false, name: r.name, reason: 'Already restored.' }); continue; }
    await db.deletedMerchant.update({ where: { id }, data: { keepOut: false, restoredAt: now, restoredById: user.id } });
    results.push({ id, ok: true, name: r.name, mdmRef: r.mdmRef, outcome: r.mdmRef ? 'The sync may bring it back (on a Full resync, or when it changes on MDM).' : 'Restored; it was never on MDM, so nothing comes back by itself.' });
  }
  const done = results.filter((x) => x.ok).length;
  await logEvent({ actorId: user.id, entityType: 'bulk', entityId: `restore:${now.toISOString()}`, action: 'records.restored', after: { requested: results.length, done, failed: results.length - done, items: results }, reason: reason.trim() }, db);
  return { requested: results.length, done, failed: results.length - done, results };
}

// ───────── Delete all data (asked by the client on 4 Nov 2026) ─────────
// Everything the app holds about merchants and about the people MDM lists, so the import can start
// again from a clean slate with the date range the Administrator chooses:
//   deleted — every lead and seller (contact, conversation and messages, onboarding tickets and AM
//     tasks, health history, playbook progress), their notifications, the Skipped sellers list,
//     the People on MDM list and every record kept as MDM sent it; optionally the Deleted merchants
//     list (otherwise those merchants stay out of the sync);
//   kept — the accounts (who can sign in), settings and configuration versions, templates, macros,
//     saved views, the run history and the audit log, which is never deleted.
// MDM is never touched. Template sends that are deleted still count against this month's budget.
// Guardrails: Administrator only, refused while a sync runs, a written reason, and the number of
// merchants typed to confirm. The automatic sync is paused, so nothing comes back before the date
// range is chosen; the next sync reads MDM from the beginning. One audit entry with the full list.

async function allCounts(db) {
  const [merchants, sellers, onboarding, amTasks, messages, skipped, people, records, deletedList] = await Promise.all([
    db.contact.count(), db.seller.count(), db.ticket.count({ where: { type: 'onboarding_task' } }), db.ticket.count({ where: { NOT: { type: 'onboarding_task' } } }),
    db.message.count(), db.mdmSkipped.count(), db.mdmStaff.count(), db.mdmRecord.count(), db.deletedMerchant.count({ where: { kind: { not: 'all' } } }),
  ]);
  return { merchants, sellers, onboarding, amTasks, messages, skipped, people, records, deletedList };
}

/** What "Delete all data" would delete now: the counts, and the number to type to confirm. */
export async function deleteAllPreview(db = prisma) {
  const counts = await allCounts(db);
  return { counts, confirmWith: counts.merchants };
}

export async function deleteAllData(user, { reason, confirm, emptyDeletedList = false } = {}, { syncRunning = false } = {}, db = prisma) {
  if (!grant(user.role, 'records.delete')) throw forbidden('Deleting records is reserved to the Administrator.');
  if (syncRunning) throw Object.assign(badRequest('A sync is running. Press Stop sync, wait until it shows "stopped", then delete.'), { status: 409, code: 'sync_running' });
  if (typeof reason !== 'string' || !reason.trim()) throw badRequest('A written reason is required to delete.');
  const counts = await allCounts(db);
  if (String(confirm ?? '').trim() !== String(counts.merchants)) {
    throw badRequest(`Not deleted: type ${counts.merchants} — the number of merchants here now — to confirm.`);
  }
  const why = reason.trim();
  const now = new Date();
  const batchId = `delete:all:${now.toISOString()}`;
  // nothing comes back before the Administrator has chosen what to bring in
  await setPaused(user, true, { reason: 'Delete all data' }, db);
  await fullNextRun(user, db);
  const merchants = (await db.contact.findMany({ select: { id: true, name: true, phone: true, mdmRef: true, seller: { select: { id: true, mdmRef: true } } } }))
    .map((c) => ({ contactId: c.id, name: c.name, phone: c.phone, mdmRef: c.mdmRef ?? c.seller?.mdmRef ?? null, seller: !!c.seller }));
  const sends = (await db.message.findMany({ where: { kind: 'template', direction: 'out' }, select: { createdAt: true, templateKey: true } }))
    .map((m) => ({ at: m.createdAt.toISOString(), key: m.templateKey }));
  const listed = emptyDeletedList ? await db.deletedMerchant.findMany({ where: { kind: { not: 'all' } }, select: { id: true, templateSends: true } }) : [];
  for (const r of listed) sends.push(...parse(r.templateSends, []));
  await db.$transaction([
    db.notification.deleteMany(),
    db.playbookProgress.deleteMany(),
    db.healthHistory.deleteMany(),
    db.ticket.deleteMany(),
    db.seller.deleteMany(),
    db.message.deleteMany(),
    db.conversation.deleteMany(),
    db.contact.deleteMany(),
    db.mdmSkipped.deleteMany(),
    db.mdmStaff.deleteMany(),
    db.mdmRecord.deleteMany(),
    ...(listed.length ? [db.deletedMerchant.deleteMany({ where: { id: { in: listed.map((r) => r.id) } } })] : []),
    // the budget keeps counting what was sent (hidden from the Deleted merchants list)
    ...(sends.length ? [db.deletedMerchant.create({ data: { kind: 'all', name: 'Delete all data', keepOut: false, reason: why, batchId, deletedById: user.id, deletedAt: now,
      snapshot: JSON.stringify(counts), templateSends: JSON.stringify(sends) } })] : []),
  ]);
  const kept = ['accounts', 'settings and configuration', 'templates, macros and saved views', 'run history', 'audit log', ...(emptyDeletedList ? [] : ['Deleted merchants list'])];
  await logEvent({ actorId: user.id, entityType: 'bulk', entityId: batchId, action: 'records.deleted_all', reason: why,
    after: { counts: { ...counts, deletedList: emptyDeletedList ? counts.deletedList : 0 }, kept, syncPaused: true, fullNextRun: true, merchants } }, db);
  return { batchId, deleted: { ...counts, deletedList: emptyDeletedList ? counts.deletedList : 0 }, kept, syncPaused: true };
}
