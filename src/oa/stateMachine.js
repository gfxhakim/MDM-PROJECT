// onboarding_task status set and permitted transitions (OA 2.4, 2.5). Illegal transitions are
// rejected by the service, not merely hidden. There is no New → Activated path, and Activated is
// reached only through the accept action (activation gate, OA 8.1/8.2).

export const STATUSES = ['new', 'failed_to_contact', 'prequalified', 'qualified', 'activated', 'cold_lead', 'junk_lead'];
export const STAGES = ['first_contact', 'walkthrough', 'documents', 'activation', 'done'];
export const CLOSED = ['activated', 'cold_lead', 'junk_lead'];

export const TRANSITIONS = {
  new: ['failed_to_contact', 'prequalified', 'qualified', 'junk_lead'],
  failed_to_contact: ['prequalified', 'qualified', 'cold_lead', 'junk_lead'],
  prequalified: ['qualified', 'failed_to_contact', 'cold_lead', 'junk_lead'],
  qualified: ['activated', 'failed_to_contact', 'cold_lead'],
  activated: [],
  cold_lead: ['prequalified'], // reopen, written reason
  junk_lead: ['prequalified'], // reopen, written reason
};

export const QUALIFICATION_KEYS = ['reachable', 'intent', 'walkthrough', 'documents', 'expectations'];
export const QUALIFICATION_LABELS = {
  reachable: 'Real, reachable person',
  intent: 'Real intent',
  walkthrough: 'Walkthrough delivered',
  documents: 'Documents complete',
  expectations: 'Expectations set',
};

// The eight handoff fields (OA 2.6). accountManager and source are written by the system.
export const HANDOFF_KEYS = ['accountManager', 'sellerProfile', 'intent', 'servicesDiscussed', 'objections', 'commitments', 'riskNotes', 'source'];
export const HANDOFF_SYSTEM_KEYS = ['accountManager', 'source'];

export function canTransition(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export const filled = (v) => typeof v === 'string' ? v.trim().length > 0 : v !== null && v !== undefined && v !== '';

/** The activation gate, as data: every unmet item, worded for the disabled control (OA 6.2). */
export function activationGate(ticket) {
  const q = typeof ticket.qualification === 'string' ? JSON.parse(ticket.qualification) : ticket.qualification;
  const h = typeof ticket.handoffRecord === 'string' ? JSON.parse(ticket.handoffRecord) : ticket.handoffRecord;
  const unmetCriteria = QUALIFICATION_KEYS.filter((k) => q?.[k] !== true);
  const missingHandoff = HANDOFF_KEYS.filter((k) => !HANDOFF_SYSTEM_KEYS.includes(k) && !filled(h?.[k]));
  const reasons = [];
  if (ticket.status !== 'qualified') reasons.push('Lead is not Qualified');
  if (unmetCriteria.length) reasons.push(`${unmetCriteria.length} qualification criteri${unmetCriteria.length === 1 ? 'on' : 'a'} still unmet`);
  if (missingHandoff.length) reasons.push(`handoff record incomplete (${missingHandoff.length} field${missingHandoff.length === 1 ? '' : 's'})`);
  return { ok: reasons.length === 0, unmetCriteria, missingHandoff, reason: reasons.length ? `Activate account — ${reasons.join('; ')}` : null };
}
