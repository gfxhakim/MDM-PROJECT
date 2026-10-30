// Wire the account-management engine into the platform: config simulate/publish and events.
import { prisma } from '../db.js';
import { on } from '../core/events.js';
import { onPublish, registerSimulator } from '../config/service.js';
import { runAmSweep } from './rules.js';

export function registerAccountManagement() {
  // Simulate: the real recompute + sweep against the draft, inside the rolled-back transaction.
  registerSimulator('accountManagement', ({ db, proposed }) => runAmSweep({ db, config: proposed }));
  // Publish: recompute and sweep immediately, so tomorrow's work exists before anyone looks (AC-25).
  onPublish('accountManagement', ({ config }) => runAmSweep({ config }));
  // A human message to a seller is a contact (engagement, r13 cadence clock). Rules never send.
  on('message.sent', 'am.last_contact', async ({ conversation, message, actorId }) => {
    if (!actorId || conversation.contact?.contactType !== 'seller') return null;
    return prisma.seller.updateMany({ where: { contactId: conversation.contactId }, data: { lastContactAt: message.createdAt } });
  });
}
