// Wire the onboarding engine into the platform: domain events, config simulate and publish.
// Registration is by name, so calling this more than once is harmless.
import { on } from '../core/events.js';
import { onPublish, registerSimulator } from '../config/service.js';
import { capture, recordFirstOrder, resetOnReply } from './service.js';
import { runOnboardingSweep } from './rules.js';

export function registerOnboarding() {
  // r7 before r1: an inbound reply resets a running cadence; a merchant with no open ticket gets one.
  on('message.received', 'oa.r7', ({ contact, message }) => resetOnReply(contact.id, { now: message.createdAt }));
  on('message.received', 'oa.r1', ({ contact, message }) => capture(contact.id, { now: message.createdAt }));
  on('contact.registered', 'oa.r1', ({ contact, now }) => capture(contact.id, { now }));
  on('order.created', 'oa.r10', ({ contactId, at }) => recordFirstOrder(contactId, { at }));

  // Simulate runs the real sweep with the draft config inside a rolled-back transaction (AC-23).
  registerSimulator('onboarding', ({ db, proposed }) => runOnboardingSweep({ db, config: proposed, simulate: true }));
  // Publish triggers an immediate sweep (AC-25).
  onPublish('onboarding', ({ config }) => runOnboardingSweep({ config }));
}
