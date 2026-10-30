// AM rule r1 — the handover from Onboarding (AM Part 3.1, 3.2). The one automatic assignment in
// the AM module: same market, lowest book, ties by earliest last assignment. No cross-market
// fallback — a full market leaves the seller unassigned and alerts the Admin.
import { prisma } from '../db.js';
import { logEvent } from '../services/audit.js';
import { notify, notifyRole } from '../core/notifications.js';

/** AM 3.2. Returns { manager, bookSize } or { manager: null, reason }. */
export async function pickAccountManager(market, config, db = prisma) {
  const ams = (await db.user.findMany({ where: { role: 'ACCOUNT_MANAGER', active: true } }))
    .filter((u) => JSON.parse(u.markets).includes(market));
  if (!ams.length) return { manager: null, reason: `No account manager covers ${market}.` };
  const withBooks = await Promise.all(ams.map(async (u) => ({
    manager: u, bookSize: await db.seller.count({ where: { assignedAccountManagerId: u.id } }),
  })));
  const candidates = withBooks.filter((x) => x.bookSize < config['am.maxBook']);
  if (!candidates.length) return { manager: null, reason: `Every account manager in ${market} is at the book ceiling (${config['am.maxBook']}).` };
  candidates.sort((a, b) => a.bookSize - b.bookSize
    || (a.manager.lastAssignedAt?.getTime() ?? 0) - (b.manager.lastAssignedAt?.getTime() ?? 0));
  return candidates[0];
}

/**
 * Run r1 for a seller whose join status just became accepted. Idempotent: a seller that already
 * has a manager is left alone. Opens the welcome task (urgent, due +welcomeCallH).
 * Returns { assigned, managerId, taskId, reason }.
 */
export async function handover(sellerId, { config, now = new Date(), handoffRecord = null } = {}, db = prisma) {
  if (!config['am.rule.r1.enabled']) return { assigned: false, reason: 'AM rule r1 is disabled.' };
  const seller = await db.seller.findUnique({ where: { id: sellerId }, include: { contact: true } });
  if (!seller || seller.joinStatus !== 'accepted') return { assigned: false, reason: 'Seller is not accepted.' };
  if (seller.assignedAccountManagerId) return { assigned: false, managerId: seller.assignedAccountManagerId, reason: 'Already assigned.' };

  const pick = await pickAccountManager(seller.market, config, db);
  if (!pick.manager) {
    await logEvent({ entityType: 'seller', entityId: seller.id, action: 'seller.unassigned_alert', reason: pick.reason }, db);
    await notifyRole('ADMIN', {
      kind: 'am.r1.no_manager', title: `No account manager for ${seller.contact.name}`, body: pick.reason,
      dedupeKey: `am.r1.no_manager:${seller.id}`,
    }, db);
    return { assigned: false, reason: pick.reason };
  }

  const am = pick.manager;
  await db.seller.update({ where: { id: seller.id }, data: { assignedAccountManagerId: am.id } });
  await db.contact.update({ where: { id: seller.contactId }, data: { ownerAgentId: am.id } });
  await db.user.update({ where: { id: am.id }, data: { lastAssignedAt: now } });
  if (am.businessNumber) {
    await db.conversation.updateMany({ where: { contactId: seller.contactId }, data: { businessNumber: am.businessNumber } });
  }
  const dueAt = new Date(now.getTime() + config['am.welcomeCallH'] * 3_600_000);
  const task = await db.ticket.create({
    data: {
      type: 'am_task', contactId: seller.contactId, sellerId: seller.id, assigneeId: am.id, status: 'open',
      priority: 'urgent', taskType: 'welcome', title: 'Welcome call', ruleId: 'r1', dueAt,
      why: `Activated ${now.toISOString().slice(0, 10)}; assigned to the ${seller.market} book with the fewest sellers (${pick.bookSize}). Welcome call due within ${config['am.welcomeCallH']} h.`,
    },
  });
  await logEvent({
    entityType: 'seller', entityId: seller.id, action: 'SELLER_ASSIGNED',
    before: { assignedAccountManagerId: null }, after: { assignedAccountManagerId: am.id, bookSize: pick.bookSize + 1, welcomeTaskId: task.id },
  }, db);
  await notify({
    userId: am.id, kind: 'am.r1.assigned', title: `New seller: ${seller.contact.name}`,
    body: handoffRecord ? 'Handoff record attached on the seller.' : null, ticketId: task.id, dedupeKey: `am.r1.assigned:${seller.id}`,
  }, db);
  return { assigned: true, managerId: am.id, managerName: am.name, taskId: task.id };
}
