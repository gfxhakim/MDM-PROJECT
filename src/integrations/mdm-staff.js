// Staff from the MDM platform ("People on MDM" on the Integrations page). The pull reads every user
// the platform lists (Users on MDM: role, scope, countries, restriction) and keeps them aside; the
// Admin imports each one as an account here with the role they name (onboarding agent, account
// manager, shift lead, manager …), alone or in bulk, or leaves them out. Their data comes with
// them (OA 3.5, the migration table, applied to MDM): the merchant MDM says they are responsible
// for becomes their lead, the sellers MDM names them account manager of stay in their book, and
// the join history MDM recorded is in each conversation (mdm.js). One audit entry per decision run
// with every item's result (OA 13.2). Nothing here is written to MDM.
import { prisma } from '../db.js';
import { badRequest } from '../http/errors.js';
import { logEvent } from '../services/audit.js';
import { addSystemLine } from '../core/conversations.js';
import { TICKET_TYPES } from '../core/ticketTypes.js';
import { changeTicket } from '../oa/service.js';
import { marketCode } from './mdm-api.js';
import { MARKETS, MARKET_NAMES } from './mdm-skipped.js';

export const IMPORT_ROLES = {
  OA_AGENT: 'Onboarding agent', ACCOUNT_MANAGER: 'Account manager', HEAD_OF_AM: 'Head of AM', SHIFT_LEAD: 'Shift lead', MANAGER: 'Manager', READ_ONLY: 'Read-only', ADMIN: 'Administrator',
};
export const ACTIONS = ['import', 'leave_out', 'reopen'];
export const MAX_ITEMS = 200; // the ceiling every bulk run here uses (OA 13.2)
const OPEN = TICKET_TYPES.onboarding_task.openStatuses;

const parse = (s, fallback) => { try { return JSON.parse(s) ?? fallback; } catch { return fallback; } };

/** A guess from what MDM calls the user — shown as the default choice, never applied by itself. */
export function suggestRole(role, scope) {
  const r = String(role ?? '').toLowerCase();
  if (/(head|director|chief|lead)\W*(of\W*)?(the\W*)?(account|\bam\b|key.?account)|(account.?manag\w*|\bam\b)\W*(head|director|chief|lead)/.test(r)) return 'HEAD_OF_AM';
  if (/account.?manager|key.?account|\bam\b/.test(r)) return 'ACCOUNT_MANAGER';
  if (/admin|owner|super/.test(r)) return 'ADMIN';
  if (/shift|supervisor|team.?lead|chef/.test(r)) return 'SHIFT_LEAD';
  if (/manager|head|director/.test(r)) return 'MANAGER';
  if (/agent|onboard|sales|commercial|follow/.test(r)) return 'OA_AGENT';
  if (/view|read/.test(r)) return 'READ_ONLY';
  return /commercial/i.test(String(scope ?? '')) ? 'OA_AGENT' : null;
}

/** MDM's country ids or codes → the markets here (LY | IQ | LB), in MDM's order, each once. */
export function marketsFor(countries, index = new Map()) {
  const out = [];
  for (const c of countries ?? []) {
    const code = marketCode(index.get(String(c)) ?? c);
    if (MARKETS.includes(code) && !out.includes(code)) out.push(code);
  }
  return out;
}

/** Country id → alpha-3 code, as learnt from the sellers the sync has read. */
export async function countryIndex(db = prisma) {
  return new Map((await db.mdmCountry.findMany()).map((r) => [r.id, r.code]));
}

/** Refresh an account here from what MDM says about the same person (name, markets, restriction). */
async function syncUser(user, staff, { now = new Date() } = {}, db = prisma) {
  const markets = parse(staff.markets, []);
  const data = {
    mdmRef: staff.mdmRef, mdmRole: staff.role, mdmScope: staff.scope, mdmUsernames: staff.usernames, mdmManagerRef: staff.managerRef ?? user.mdmManagerRef,
    phones: staff.phones, mdmSyncedAt: now, name: staff.name || user.name, ...(markets.length ? { markets: JSON.stringify(markets) } : {}),
  };
  if (user.removedAt) {
    // removed here by an Admin: MDM's restriction flag no longer switches it on or off
  } else if (staff.restricted && user.active) {
    data.active = false;
    await logEvent({ entityType: 'user', entityId: user.id, action: 'user.deactivated', before: { active: true }, after: { active: false }, reason: 'Restricted on MDM' }, db);
  } else if (!staff.restricted && !user.active) {
    // reactivated only when it was MDM's restriction that switched the account off here
    const last = await db.eventLog.findFirst({ where: { entityType: 'user', entityId: user.id, action: { in: ['user.deactivated', 'user.activated'] } }, orderBy: { createdAt: 'desc' } });
    if (last?.action === 'user.deactivated' && /^Restricted on MDM/.test(last.reason ?? '')) {
      data.active = true;
      await logEvent({ entityType: 'user', entityId: user.id, action: 'user.activated', before: { active: false }, after: { active: true }, reason: 'No longer restricted on MDM' }, db);
    }
  }
  return db.user.update({ where: { id: user.id }, data });
}

/**
 * The pull read this platform user: keep the row, or refresh it. An account here with the same
 * email (one created before the connector) is linked to its platform record, not duplicated.
 * `managerRef` is the account-manager record on MDM with the same email, when there is one.
 */
export async function rememberStaff(row, { runId = null, now = new Date(), managerRef = null, index = new Map() } = {}, db = prisma) {
  if (!row.mdmRef) return null;
  const mdmRef = String(row.mdmRef);
  const data = {
    name: row.name || row.email || mdmRef, email: row.email ?? null, phones: JSON.stringify(row.phones ?? []), usernames: JSON.stringify(row.usernames ?? []),
    role: row.role ?? null, scope: row.scope ?? null, countries: JSON.stringify(row.countries ?? []), markets: JSON.stringify(marketsFor(row.countries, index)),
    restricted: !!row.restricted, managerRef: managerRef ?? null, lastLoginAt: row.lastLoginAt ?? null, mdmCreatedAt: row.createdAt ?? null,
    platform: JSON.stringify(row), lastSeenAt: now, runId,
  };
  const existing = await db.mdmStaff.findUnique({ where: { mdmRef } });
  if (existing) {
    const staff = await db.mdmStaff.update({ where: { id: existing.id }, data: { ...data, seenCount: { increment: 1 } } });
    const user = staff.userId ? await db.user.findUnique({ where: { id: staff.userId } }) : null;
    if (user) await syncUser(user, staff, { now }, db);
    return staff;
  }
  // An account here already tied to this MDM user (imported earlier, its list row since deleted by
  // Delete all data) is linked again first, whatever its email is now; otherwise the same email.
  const byRef = await db.user.findUnique({ where: { mdmRef } });
  const linked = byRef ?? (row.email ? await db.user.findUnique({ where: { email: row.email } }) : null);
  const staff = await db.mdmStaff.create({ data: { mdmRef, firstSeenAt: now, ...data,
    ...(linked ? { userId: linked.id, decision: 'imported', decidedAt: now, outcome: JSON.stringify({ linked: true, userId: linked.id, role: linked.role }) } : {}) } });
  if (linked) {
    await syncUser(linked, staff, { now }, db);
    await logEvent({ entityType: 'user', entityId: linked.id, action: 'user.linked_mdm', after: { mdmRef, mdmRole: row.role ?? null, mdmScope: row.scope ?? null },
      reason: byRef ? 'Account already tied to this user on the MDM platform' : 'Same email as a user on the MDM platform' }, db);
  }
  return staff;
}

/** People whose MDM countries could not be read as markets yet: try again with what the sync has learnt since. */
export async function refreshStaffMarkets(index, db = prisma) {
  if (!index.size) return 0;
  let n = 0;
  for (const h of await db.mdmStaff.findMany({ where: { markets: '[]', NOT: { countries: '[]' } } })) {
    const markets = marketsFor(parse(h.countries, []), index);
    if (!markets.length) continue;
    const staff = await db.mdmStaff.update({ where: { id: h.id }, data: { markets: JSON.stringify(markets) } });
    const user = staff.userId ? await db.user.findUnique({ where: { id: staff.userId } }) : null;
    if (user) await syncUser(user, staff, {}, db);
    n++;
  }
  return n;
}

function view(h, { users, leads, skipped, sellers }) {
  const user = h.userId ? users.get(h.userId) ?? null : null;
  return {
    id: h.id, mdmRef: h.mdmRef, name: h.name, email: h.email, phones: parse(h.phones, []), usernames: parse(h.usernames, []),
    role: h.role, scope: h.scope, countries: parse(h.countries, []), markets: parse(h.markets, []), restricted: h.restricted, managerRef: h.managerRef,
    lastLoginAt: h.lastLoginAt, mdmCreatedAt: h.mdmCreatedAt, seenCount: h.seenCount, firstSeenAt: h.firstSeenAt, lastSeenAt: h.lastSeenAt,
    decision: h.decision, decidedAt: h.decidedAt, decidedBy: h.decidedById ? users.get(h.decidedById)?.name ?? null : null, decisionNote: h.decisionNote,
    outcome: parse(h.outcome, {}),
    user: user ? { id: user.id, name: user.name, role: user.role, markets: parse(user.markets, []), active: user.active, hasPassword: !!user.passwordHash } : null,
    suggestedRole: suggestRole(h.role, h.scope),
    // what MDM ties to this person: merchants they are responsible for (here, and kept aside), sellers in their book
    onMdm: { leads: leads.get(h.mdmRef) ?? 0, skipped: skipped.get(h.mdmRef) ?? 0, sellers: h.managerRef ? sellers.get(h.managerRef) ?? 0 : 0 },
    blocked: h.decision ? null : !h.email ? 'No email on MDM — an account here needs one.' : null,
  };
}

/** The staff list for the page. decision: waiting (default) | imported | left_out | all. */
export async function listStaff({ decision = 'waiting', scope = null, q = null, from = null, to = null } = {}, db = prisma) {
  const where = {
    ...(decision === 'all' ? {} : decision === 'waiting' ? { decision: null } : { decision }),
    ...(scope ? { scope } : {}),
    // the date the person's user was created on MDM
    ...(from || to ? { mdmCreatedAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    ...(q ? { OR: [{ name: { contains: q } }, { email: { contains: q } }, { mdmRef: { contains: q } }, { phones: { contains: q } }, { usernames: { contains: q } }] } : {}),
  };
  const [rows, all, userRows, leadRows, skippedRows, sellerRows] = await Promise.all([
    db.mdmStaff.findMany({ where, orderBy: [{ scope: 'asc' }, { role: 'asc' }, { name: 'asc' }], take: 1000 }),
    db.mdmStaff.findMany({ select: { decision: true, scope: true, role: true, restricted: true } }),
    db.user.findMany({ select: { id: true, name: true, role: true, markets: true, active: true, passwordHash: true } }),
    db.contact.groupBy({ by: ['mdmResponsibleRef'], where: { mdmResponsibleRef: { not: null } }, _count: { _all: true } }),
    db.mdmSkipped.groupBy({ by: ['responsibleRef'], where: { responsibleRef: { not: null }, decision: null }, _count: { _all: true } }),
    db.seller.groupBy({ by: ['mdmManagerRef'], where: { mdmManagerRef: { not: null } }, _count: { _all: true } }),
  ]);
  const ctx = {
    users: new Map(userRows.map((u) => [u.id, u])),
    leads: new Map(leadRows.map((r) => [r.mdmResponsibleRef, r._count._all])),
    skipped: new Map(skippedRows.map((r) => [r.responsibleRef, r._count._all])),
    sellers: new Map(sellerRows.map((r) => [r.mdmManagerRef, r._count._all])),
  };
  const counts = { waiting: 0, imported: 0, left_out: 0, restricted: 0, byScope: {} };
  for (const r of all) {
    counts[r.decision ?? 'waiting']++;
    if (r.restricted) counts.restricted++;
    const k = r.scope ?? '';
    counts.byScope[k] = (counts.byScope[k] ?? 0) + 1;
  }
  return {
    items: rows.map((h) => view(h, ctx)), counts, roles: IMPORT_ROLES, markets: MARKET_NAMES, limit: MAX_ITEMS,
    scopes: Object.keys(counts.byScope).sort(),
  };
}

/** The lead MDM says this agent is responsible for goes to them — the platform's assignment, kept here. */
export async function assignLeadToPlatformAgent(ticket, agent, { actorId = null, responsibleChanged = false } = {}, db = prisma) {
  if (!agent || ticket.assigneeId === agent.id || !OPEN.includes(ticket.status)) return null;
  const current = ticket.assigneeId ? await db.user.findUnique({ where: { id: ticket.assigneeId } }) : null;
  // two platform people: a move made here was recorded on MDM; the platform follows us, not the reverse
  if (current?.mdmRef) return null;
  // A person here moved the lead (reassign, take-over, Assign now): MDM has no endpoint to record that,
  // so MDM still names the earlier agent. The lead stays where the person put it until MDM names
  // someone new for it — a sync never undoes a manager's decision.
  if (!responsibleChanged && ticket.assigneeId) {
    const moved = await db.eventLog.findFirst({ where: { entityType: 'ticket', entityId: ticket.id, actorId: { not: null },
      action: { in: ['ticket.reassigned', 'ticket.taken_over', 'ticket.assigned'] }, NOT: { reason: { startsWith: 'Responsible agent on the MDM platform' } } } });
    if (moved) return null;
  }
  const updated = await changeTicket(db, ticket, { assigneeId: agent.id, holdReason: null, heldAt: null },
    { actorId, action: 'ticket.assigned', reason: `Responsible agent on the MDM platform: ${agent.name}` });
  const conv = await db.conversation.findFirst({ where: { contactId: ticket.contactId } });
  if (conv) await addSystemLine(conv.id, `Assigned to ${agent.name} — the agent responsible for this merchant on MDM.`, db);
  return updated;
}

/** The seller MDM names this account manager for stays in their book — the platform's assignment, kept here. */
export async function moveSellerToPlatformManager(seller, manager, { actorId = null } = {}, db = prisma) {
  if (!manager || seller.assignedAccountManagerId === manager.id) return null;
  const current = seller.assignedAccountManagerId ? await db.user.findUnique({ where: { id: seller.assignedAccountManagerId } }) : null;
  if (current?.mdmRef) return null; // two platform people: a move made here was recorded on MDM
  await db.seller.update({ where: { id: seller.id }, data: { assignedAccountManagerId: manager.id } });
  await db.contact.update({ where: { id: seller.contactId }, data: { ownerAgentId: manager.id } });
  await db.ticket.updateMany({ where: { sellerId: seller.id, type: 'am_task', status: 'open' }, data: { assigneeId: manager.id } });
  const conv = await db.conversation.findFirst({ where: { contactId: seller.contactId } });
  if (conv) {
    if (manager.businessNumber) await db.conversation.update({ where: { id: conv.id }, data: { businessNumber: manager.businessNumber } });
    await addSystemLine(conv.id, `Account manager: ${manager.name} — as recorded on MDM.`, db);
  }
  // fromPlatform: the write-back does not send MDM its own assignment back
  await logEvent({ actorId, entityType: 'seller', entityId: seller.id, action: 'seller.reassigned',
    before: { assignedAccountManagerId: seller.assignedAccountManagerId }, after: { assignedAccountManagerId: manager.id, fromPlatform: true },
    reason: `Account manager on the MDM platform: ${manager.name}` }, db);
  return manager;
}

/** Our people on the platform: active onboarding agents by MDM user id, account managers by MDM account-manager record. */
export async function platformPeople(db = prisma) {
  const users = await db.user.findMany({ where: { active: true, OR: [{ mdmRef: { not: null } }, { mdmManagerRef: { not: null } }] } });
  return {
    agentsByRef: new Map(users.filter((u) => u.role === 'OA_AGENT' && u.mdmRef).map((u) => [u.mdmRef, u])),
    managersByMdmRef: new Map(users.filter((u) => u.role === 'ACCOUNT_MANAGER' && u.mdmManagerRef).map((u) => [u.mdmManagerRef, u])),
    staffByRef: new Map(users.filter((u) => u.mdmRef).map((u) => [u.mdmRef, u])),
  };
}

/**
 * Give every merchant and seller already here to the person MDM names for them, once that person
 * is one of ours: open leads to the responsible agent, sellers to the account manager. Runs after
 * an import and at the end of every sync. One audit entry per run that changed anything.
 */
export async function alignOwnership({ actorId = null } = {}, db = prisma) {
  const { agentsByRef, managersByMdmRef } = await platformPeople(db);
  const items = [];
  if (agentsByRef.size) {
    const tickets = await db.ticket.findMany({ where: { type: 'onboarding_task', status: { in: OPEN }, contact: { mdmResponsibleRef: { in: [...agentsByRef.keys()] } } }, include: { contact: true } });
    for (const t of tickets) {
      const agent = agentsByRef.get(t.contact.mdmResponsibleRef);
      if (await assignLeadToPlatformAgent(t, agent, { actorId }, db)) items.push({ kind: 'lead', ticketId: t.id, contactId: t.contactId, name: t.contact.name, to: agent.name, toUserId: agent.id });
    }
  }
  if (managersByMdmRef.size) {
    const sellers = await db.seller.findMany({ where: { mdmManagerRef: { in: [...managersByMdmRef.keys()] } }, include: { contact: true } });
    for (const s of sellers) {
      const manager = managersByMdmRef.get(s.mdmManagerRef);
      if (await moveSellerToPlatformManager(s, manager, { actorId }, db)) items.push({ kind: 'seller', sellerId: s.id, contactId: s.contactId, name: s.contact.name, to: manager.name, toUserId: manager.id });
    }
  }
  const summary = { leads: items.filter((i) => i.kind === 'lead').length, sellers: items.filter((i) => i.kind === 'seller').length };
  if (items.length) {
    await logEvent({ actorId, entityType: 'bulk', entityId: `mdm.ownership:${new Date().toISOString()}`, action: 'mdm.ownership_aligned', after: { ...summary, items },
      reason: 'Leads and sellers given to the person MDM names for them' }, db);
  }
  return summary;
}

/**
 * The Admin's decision on one or more platform users. { ids, action: import | leave_out | reopen,
 * role?, markets?, note? } — import needs a role; markets default to what MDM lists for the person.
 * Each item is handled and reported on its own; one audit entry for the run.
 */
export async function decideStaff(user, { ids, action, role = null, markets = null, note = null } = {}, db = prisma) {
  if (!Array.isArray(ids) || !ids.length) throw badRequest('Select at least one person.');
  if (ids.length > MAX_ITEMS) throw badRequest(`At most ${MAX_ITEMS} people per run.`);
  if (!ACTIONS.includes(action)) throw badRequest('action must be import, leave_out or reopen.');
  note = typeof note === 'string' && note.trim() ? note.trim() : null;
  if ((ids.length > 1 || action === 'leave_out') && !note) throw badRequest('A written note is required for a bulk run and for leaving someone out.');
  if (action === 'import' && !IMPORT_ROLES[role]) throw badRequest('Choose the role they have here: ' + Object.values(IMPORT_ROLES).join(', ') + '.');
  if (markets != null) {
    if (!Array.isArray(markets) || markets.some((m) => !MARKETS.includes(m))) throw badRequest('markets must be a list of LY, IQ or LB.');
    if (!markets.length) markets = null;
  }
  const now = new Date();
  const results = [];
  for (const id of [...new Set(ids.map(String))]) {
    const h = await db.mdmStaff.findUnique({ where: { id } });
    const out = { id, mdmRef: h?.mdmRef ?? null, name: h?.name ?? null, ok: false };
    results.push(out);
    try {
      if (!h) throw new Error('No such person on the list.');
      if (action === 'reopen') {
        if (h.decision !== 'left_out') throw new Error('Only someone left out can be put back.');
        await db.mdmStaff.update({ where: { id }, data: { decision: null, decidedById: null, decidedAt: null, decisionNote: null, outcome: '{}' } });
        out.ok = true; out.outcome = 'Back on the list.';
        continue;
      }
      if (h.decision === 'imported') throw new Error(`Already imported${h.decidedAt ? ` on ${h.decidedAt.toISOString().slice(0, 10)}` : ''}.`);
      if (action === 'leave_out') {
        if (h.decision) throw new Error('Already decided.');
        await db.mdmStaff.update({ where: { id }, data: { decision: 'left_out', decidedById: user.id, decidedAt: now, decisionNote: note, outcome: '{}' } });
        out.ok = true; out.outcome = 'Left out.';
        continue;
      }
      // import
      if (!h.email) throw new Error('No email on MDM — an account here needs one. Add it on MDM and sync again.');
      const own = markets ?? parse(h.markets, []);
      const needsMarket = ['OA_AGENT', 'ACCOUNT_MANAGER', 'SHIFT_LEAD', 'MANAGER'].includes(role);
      if (needsMarket && !own.length) throw new Error('No market in Libya, Iraq or Lebanon on MDM — choose the markets for this person.');
      const marketsHere = own.length ? own : ['ADMIN', 'HEAD_OF_AM'].includes(role) ? [...MARKETS] : [];
      const common = { mdmRef: h.mdmRef, mdmRole: h.role, mdmScope: h.scope, mdmUsernames: h.usernames, mdmManagerRef: h.managerRef, phones: h.phones, mdmSyncedAt: now };
      let account = await db.user.findUnique({ where: { email: h.email } });
      let linked = false;
      if (account) {
        linked = true;
        const before = { role: account.role, markets: account.markets, removed: !!account.removedAt };
        // importing someone whose account was removed here puts it back
        const back = account.removedAt ? { removedAt: null, active: !h.restricted } : {};
        account = await db.user.update({ where: { id: account.id }, data: { ...common, ...back, role, markets: JSON.stringify(marketsHere), name: h.name || account.name } });
        await logEvent({ actorId: user.id, entityType: 'user', entityId: account.id, action: 'user.linked_mdm', before, after: { role, markets: marketsHere, mdmRef: h.mdmRef }, reason: note ?? 'Imported from MDM' }, db);
      } else {
        account = await db.user.create({ data: { email: h.email, name: h.name || h.email, role, markets: JSON.stringify(marketsHere), passwordHash: '', active: !h.restricted, ...common } });
        await logEvent({ actorId: user.id, entityType: 'user', entityId: account.id, action: 'user.created', after: { email: h.email, role, markets: marketsHere, mdmRef: h.mdmRef, mdmRole: h.role, mdmScope: h.scope, active: !h.restricted }, reason: note ?? 'Imported from MDM' }, db);
      }
      const outcome = { userId: account.id, role, markets: marketsHere, linked, restricted: h.restricted };
      await db.mdmStaff.update({ where: { id }, data: { userId: account.id, decision: 'imported', decidedById: user.id, decidedAt: now, decisionNote: note, outcome: JSON.stringify(outcome) } });
      out.ok = true; out.userId = account.id; out.role = role; out.markets = marketsHere; out.linked = linked;
      out.outcome = `${linked ? 'Linked to the account already here' : 'Account created'} as ${IMPORT_ROLES[role]}${marketsHere.length ? ` · ${marketsHere.map((m) => MARKET_NAMES[m]).join(', ')}` : ''}${h.restricted ? ' · restricted on MDM, so inactive here' : ''}.`;
    } catch (err) {
      out.reason = err.message;
    }
  }
  const done = results.filter((r) => r.ok).length;
  const summary = { action, role, markets, requested: results.length, done, failed: results.length - done };
  await logEvent({ actorId: user.id, entityType: 'bulk', entityId: `mdm.staff:${now.toISOString()}`, action: 'mdm.staff_decided', after: { ...summary, items: results }, reason: note }, db);
  // their data comes with them: leads and sellers MDM ties to the people just imported
  const aligned = action === 'import' && done ? await alignOwnership({ actorId: user.id }, db) : { leads: 0, sellers: 0 };
  return { batchId: `mdm.staff:${now.toISOString()}`, ...summary, aligned, results };
}
