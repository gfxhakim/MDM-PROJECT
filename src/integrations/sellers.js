// Creating a seller that already exists outside this app (an MDM platform seller or a Zoho row):
// contact + conversation + seller record + platform mirror, then ownership. Shared by the MDM
// connector and the Zoho import so both follow the same rules:
//   • a named owner is kept only when the caller has already checked market and book ceiling;
//   • a seller activated in the last 14 days with no welcome call gets the full handover (r1
//     opens the welcome task);
//   • anyone else joins the book by AM 3.2 (same market, smallest book, no cross-market
//     fallback) without a welcome task.
// Health and lifecycle stage are never taken from the source: they are derived.
import { prisma } from '../db.js';
import { logEvent } from '../services/audit.js';
import { handover, pickAccountManager } from '../am/handover.js';

export const WELCOME_WINDOW_DAYS = 14;

/**
 * @param {object} p  phone, name, market, mdmRef, source, activatedAt, welcomeCallAt, mirror, managerId?, ownership?
 * @param {object} ctx  actorId, config (live values), managers (AM users, used to name a kept owner), legacy
 */
export async function createSellerRecord(p, { actorId = null, config, managers = [], legacy = false }, db = prisma) {
  const contact = await db.contact.create({ data: { phone: p.phone, name: p.name, country: p.market, contactType: 'seller', sourceUtm: p.source, ownerAgentId: p.managerId ?? null, legacy } });
  await db.conversation.create({ data: { contactId: contact.id } });
  const seller = await db.seller.create({
    data: { mdmRef: p.mdmRef, contactId: contact.id, market: p.market, joinStatus: 'accepted', activatedAt: p.activatedAt, welcomeCallAt: p.welcomeCallAt ?? null,
      healthStale: true, lastSyncedAt: new Date(), ...p.mirror },
  });
  let ownership = p.ownership ?? null;
  const recent = !p.welcomeCallAt && Date.now() - p.activatedAt.getTime() < WELCOME_WINDOW_DAYS * 86_400_000;
  if (!p.managerId && recent) {
    // Activated recently and never welcomed: this is a real handover (r1 opens the welcome task).
    const h = await handover(seller.id, { config }, db);
    ownership = h.assigned ? `Assigned by the handover rule to ${h.managerName}; welcome call task opened.` : `Not assigned: ${h.reason}`;
  } else {
    // An established seller joining the book: same market, smallest book (AM 3.2), but no welcome task.
    const pick = p.managerId ? { manager: managers.find((m) => m.id === p.managerId) } : await pickAccountManager(p.market, config, db);
    if (pick.manager) {
      await db.seller.update({ where: { id: seller.id }, data: { assignedAccountManagerId: pick.manager.id } });
      await db.contact.update({ where: { id: contact.id }, data: { ownerAgentId: pick.manager.id } });
      if (pick.manager.businessNumber) await db.conversation.updateMany({ where: { contactId: contact.id }, data: { businessNumber: pick.manager.businessNumber } });
      await logEvent({ actorId, entityType: 'seller', entityId: seller.id, action: 'SELLER_ASSIGNED', after: { assignedAccountManagerId: pick.manager.id, via: p.source }, reason: ownership }, db);
      if (!p.managerId) ownership = `Assigned to ${pick.manager.name} (same market, smallest book).`;
    } else ownership = `Not assigned: ${pick.reason}`;
  }
  return { seller, contact, ownership };
}
