// Permission matrix — OA Appendix A and AM Appendix A, granted to roles, never to individuals.
// Every grant is enforced in the service layer; the UI only mirrors it (with the reason shown).
//
// Grant values:
//   true          granted without restriction
//   false         not granted
//   'own'         own tickets only (assignee = caller)
//   'team'        every onboarding ticket — READ only (OA 9.4: read is team-wide, write is own-only)
//   'own_contacts' contacts the caller owns (an AM reading the onboarding history of their sellers)
//   'own_book'    sellers assigned to the caller (AM)
//   'own_gated'   own, and a service-layer precondition must also pass (activation gate, OA 8.1)
//   'own_reason'  own, with a written reason
//   'with_reason' granted, with a written reason
//   'request'     may only request it (e.g. "Request transfer")
//   'escalate'    may only escalate it to a role that holds it
//   'approval'    may request; executes once a holder approves
//   'take_over'   only after taking the conversation over (Admin monitoring)

export const ROLES = ['OA_AGENT', 'SHIFT_LEAD', 'MANAGER', 'ADMIN', 'ACCOUNT_MANAGER', 'READ_ONLY'];

const R = (OA_AGENT, SHIFT_LEAD, MANAGER, ADMIN, ACCOUNT_MANAGER, READ_ONLY) =>
  ({ OA_AGENT, SHIFT_LEAD, MANAGER, ADMIN, ACCOUNT_MANAGER, READ_ONLY });

// ─────────── Onboarding (OA Appendix A) ───────────
const OA = {
  'onboarding.view_own':          R(true, true, true, true, true, true),
  'onboarding.view_all':          R('team', true, true, true, 'own_contacts', true),
  'onboarding.reply':             R('own', true, true, true, true, false),
  'onboarding.note':              R(true, true, true, true, true, false),
  'onboarding.edit':              R('own', true, true, true, true, false),
  'onboarding.macro':             R('own', true, true, true, true, false),
  'onboarding.template':          R('own', true, true, true, true, false),
  'onboarding.reassign':          R('request', true, true, true, false, false),
  'onboarding.take_over':         R(false, true, true, true, false, false),
  'onboarding.assign_over_capacity': R(false, true, true, true, false, false),
  'onboarding.book_walkthrough':  R('own', true, true, true, false, false),
  'onboarding.activate':          R('own_gated', true, true, true, false, false),
  'onboarding.reject':            R(false, false, 'escalate', true, false, false),
  'onboarding.reopen':            R('own_reason', true, true, true, false, false),
  'onboarding.bulk_internal':     R(false, true, true, true, false, false),
  'onboarding.bulk_outbound':     R(false, false, true, true, false, false),
  'contact.block':                R(false, 'with_reason', true, true, false, false),
  'call.listen':                  R('own', true, true, true, 'own_contacts', false),
  'finance.view_cost':            R(false, false, true, true, true, false),
  'macro.author_team':            R(false, false, true, true, false, false),
  'template.author':              R(false, false, true, true, false, false),
  'macro.author_personal':        R(true, true, true, true, true, false),
  'automation.manage':            R(false, false, true, true, false, false),
  'roles.manage':                 R(false, false, false, true, false, false),
  'reports.view':                 R('own', 'team', true, true, 'own_contacts', true),
  'data.export':                  R(false, false, 'approval', true, false, false),
  'audit.view':                   R(false, false, true, true, false, true),
};

// ─────────── Account management (AM Appendix A) ───────────
// The AM module defines two roles: Account Manager and Admin. Onboarding roles get nothing here.
const AM = {
  'seller.view':                  R(false, false, false, true, 'own_book', false),
  'seller.update':                R(false, false, false, true, 'own_book', false),
  'seller.assign_am':             R(false, false, false, 'with_reason', false, false),
  'am_task.create':               R(false, false, false, true, 'own_book', false),
  'am_task.bulk_create':          R(false, false, false, true, false, false),
  'am_task.close':                R(false, false, false, true, 'own_book', false),
  'am_task.escalate':             R(false, false, false, 'with_reason', 'own_book', false),
  'playbook.tick':                R(false, false, false, true, 'own_book', false),
  'am.reply':                     R(false, false, false, 'take_over', 'own_book', false),
  'am.note':                      R(false, false, false, true, 'own_book', false),
  'am.template':                  R(false, false, false, 'take_over', 'own_book', false),
  'am.conversation_read':         R(false, false, false, true, 'own_book', false),
  'am.take_over':                 R(false, false, false, 'with_reason', false, false),
  'contact.request_block':        R(false, false, false, 'approval', false, false),
  'am.performance_team':          R(false, false, false, true, false, false),
  'am.performance_own':           R(false, false, false, true, true, false),
  'am.rule_sweep':                R(false, false, false, true, false, false),
  // Financial writes, seller accept/reject in the AM module, parcel/fulfilment writes: no role, ever.
};

export const MATRIX = Object.freeze({ ...OA, ...AM });

/** The grant a role holds for a permission (false if unknown). */
export function grant(role, permission) {
  const row = MATRIX[permission];
  if (!row) throw new Error(`Unknown permission "${permission}"`);
  return row[role] ?? false;
}

/** Every grant for a role — what /api/auth/me returns so the UI can disable controls with reasons. */
export function grantsFor(role) {
  return Object.fromEntries(Object.entries(MATRIX).map(([p, row]) => [p, row[role] ?? false]));
}

// Field-level rule (OA 6.7 / 9.1): cost, fee, margin and settlement fields are ABSENT from the
// response for roles without finance.view_cost — not blanked.
const WITHHELD_FIELD = /^(cost|fee|platformFee|merchantCost|margin|settlement)/i;

/**
 * Strip withheld fields (recursively) for roles that may not see them.
 * Returns the cleaned value; when anything was removed, objects carry `withheld: [field names]`
 * so the interface can say they are withheld rather than show blanks.
 */
export function redact(value, role) {
  if (grant(role, 'finance.view_cost')) return value;
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object' || v instanceof Date) return v;
    const out = {};
    const removed = [];
    for (const [k, x] of Object.entries(v)) {
      if (WITHHELD_FIELD.test(k)) removed.push(k);
      else out[k] = walk(x);
    }
    if (removed.length) out.withheld = removed;
    return out;
  };
  return walk(value);
}
