// Contacts: one record per phone number, scoped reads, inbound capture, block and opt-out.
import { prisma, inTx } from '../db.js';
import { logEvent } from '../services/audit.js';
import { grant } from '../auth/permissions.js';
import { denialReason, sellerWhere } from '../auth/scope.js';
import { badRequest, forbidden, notFound } from '../http/errors.js';
import { emit } from './events.js';

const E164 = /^\+[1-9]\d{7,14}$/;

export function normalizePhone(raw) {
  const p = String(raw ?? '').replace(/[\s\-().]/g, '').replace(/^00/, '+');
  if (!E164.test(p)) throw badRequest(`"${raw}" is not a phone number in international format (+218…).`);
  return p;
}

/**
 * Prisma `where` for the contacts this user may read; null = none.
 *  - Admin: all.
 *  - Onboarding roles (team read): every contact that has an onboarding ticket.
 *  - Account Manager: contacts they own or whose seller is in their book.
 */
export function contactWhere(user) {
  if (user.role === 'ADMIN') return {};
  const ob = grant(user.role, 'onboarding.view_all');
  if (ob === true || ob === 'team') return { tickets: { some: { type: 'onboarding_task' } } };
  if (ob === 'own_contacts') {
    const book = sellerWhere(user);
    return { OR: [{ ownerAgentId: user.id }, ...(book ? [{ seller: book }] : [])] };
  }
  return null;
}

export async function findContact(user, id, db = prisma) {
  const where = contactWhere(user);
  const c = where && (await db.contact.findFirst({ where: { AND: [{ id }, where] } }));
  if (!c) throw notFound('Contact not found.');
  return c;
}

export async function listContacts(user, { q, take = 50 } = {}, db = prisma) {
  const where = contactWhere(user);
  if (!where) return [];
  const search = q ? { OR: [{ name: { contains: q } }, { nameAr: { contains: q } }, { phone: { contains: q.replace(/\s/g, '') } }] } : {};
  return db.contact.findMany({ where: { AND: [where, search] }, orderBy: { createdAt: 'desc' }, take: Math.min(take, 200) });
}

/**
 * An inbound message from the outside world (WhatsApp webhook in step 9; dev simulation now).
 * Resolves identity by phone, creates the contact and its single conversation if needed, stores
 * the message and opens the 24-hour window. A blocked contact's message is stored but emits
 * nothing, so no ticket is ever created for it (OA 13.3).
 */
export async function receiveInbound({ phone, body, name, country, sourceUtm, kind = 'text', at = new Date(), externalId = null }, db = prisma) {
  const e164 = normalizePhone(phone);
  if (!body || !String(body).trim()) throw badRequest('Message body is required.');
  // Providers retry webhooks: a message already stored under its provider id is not stored twice.
  if (externalId) {
    const dup = await db.message.findUnique({ where: { externalId }, include: { conversation: { include: { contact: true } } } });
    if (dup) return { contact: dup.conversation.contact, conversation: dup.conversation, message: dup, created: false, duplicate: true };
  }

  const result = await inTx(db, async (tx) => {
    let contact = await tx.contact.findUnique({ where: { phone: e164 } });
    let created = false;
    if (!contact) {
      if (!country) throw badRequest('country is required for a new contact.');
      contact = await tx.contact.create({
        data: { phone: e164, name: name?.trim() || e164, country, contactType: 'merchant', sourceUtm: sourceUtm ?? null },
      });
      created = true;
      await logEvent({ entityType: 'contact', entityId: contact.id, action: 'contact.created', after: { phone: e164, country, sourceUtm: sourceUtm ?? null } }, tx);
    }
    const conversation = await tx.conversation.upsert({
      where: { contactId: contact.id },
      create: { contactId: contact.id, channel: 'whatsapp', businessNumber: process.env.ONBOARDING_NUMBER ?? null, lastInboundAt: at },
      update: { lastInboundAt: at },
    });
    const message = await tx.message.create({
      data: { conversationId: conversation.id, direction: 'in', kind, body: String(body), createdAt: at, externalId },
    });
    return { contact, conversation, message, created };
  });

  if (!result.contact.blocked) {
    if (result.created) await emit('contact.created', { contact: result.contact, sourceUtm });
    await emit('message.received', result);
  }
  return result;
}

/** Block / unblock (OA 13.3): reason required, reversible, both audited. */
export async function setBlocked(user, contactId, blocked, reason, db = prisma) {
  const g = grant(user.role, 'contact.block');
  if (!g) throw forbidden(denialReason(user, 'contact.block'));
  if (!reason || !String(reason).trim()) throw badRequest('A written reason is required.');
  const contact = await findContact(user, contactId, db);
  if (contact.blocked === blocked) return contact;
  return inTx(db, async (tx) => {
    const updated = await tx.contact.update({ where: { id: contact.id }, data: { blocked, blockReason: blocked ? reason : null } });
    await logEvent({
      actorId: user.id, entityType: 'contact', entityId: contact.id, action: blocked ? 'contact.blocked' : 'contact.unblocked',
      before: { blocked: contact.blocked }, after: { blocked }, reason,
    }, tx);
    return updated;
  });
}

/** Record an opt-out (or its withdrawal). No outbound of any kind reaches an opted-out contact. */
export async function setOptedOut(user, contactId, optedOut, reason, db = prisma) {
  const contact = await findContact(user, contactId, db);
  if (user.role === 'READ_ONLY') throw forbidden(denialReason(user, 'onboarding.note'));
  return inTx(db, async (tx) => {
    const updated = await tx.contact.update({ where: { id: contact.id }, data: { optedOut } });
    await logEvent({
      actorId: user.id, entityType: 'contact', entityId: contact.id, action: optedOut ? 'contact.opted_out' : 'contact.opt_in',
      before: { optedOut: contact.optedOut }, after: { optedOut }, reason: reason ?? null,
    }, tx);
    return updated;
  });
}
