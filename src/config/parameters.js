// Configuration parameter registry — every Appendix D parameter from BOTH specs.
//   OA: MDM-Onboarding-Agent-Module-Spec.pdf, Appendix D (+ Part 12.1 rule enable/disable)
//   AM: MDM-Account-Manager-Module-Spec.pdf, Appendix D (+ Part 5.6 rule table)
//
// Keys are namespaced by module and keep the spec's own spelling (OA snake_case, AM camelCase)
// so every value can be traced back to its row in the PDF.
//
// This file holds the launch DEFAULTS and the metadata (label, unit, bounds, owner). The live
// values are never read from here — they come from the latest published ConfigVersion snapshot.
// Changing a default here does not change production; it only changes what a fresh seed writes.
//
// owner: the spec's "Owner" column. OA: Manager | manage_automation | Administrator. AM: Admin.

const int = (min, max) => ({ type: 'int', min, max });
const num = (min, max) => ({ type: 'number', min, max });
const bool = () => ({ type: 'bool' });
const oneOf = (...values) => ({ type: 'enum', values });
const time = () => ({ type: 'time' }); // "HH:MM", 24h
const weekdays = () => ({ type: 'weekdays' }); // "sun,mon,tue,wed,thu"

function p(key, def, unit, owner, group, label, help, rule, extra = {}) {
  return { key, default: def, unit, owner, group, label, help, ...rule, ...extra };
}

// ─────────────────────────── Onboarding Agent (OA Appendix D) ───────────────────────────
const OA = [
  // Cadence
  p('oa.first_contact_sla', 24, 'h', 'Manager', 'oa.cadence', 'First contact due within',
    'Hours from the lead landing on the queue. Business hours.', int(1, 168)),
  p('oa.no_answer_max', 5, 'attempts', 'Manager', 'oa.cadence', 'No-answer attempts before Cold',
    'How many calls before the lead is written off.', int(1, 20)),
  p('oa.no_answer_gap', 1, 'days', 'Manager', 'oa.cadence', 'Gap between attempts',
    'A reminder is created this many days after each failed contact.', int(1, 14)),
  p('oa.quiet_max', 3, 'follow-ups', 'Manager', 'oa.cadence', 'Follow-ups after going quiet',
    'They replied once, then stopped. Each follow-up is billable.', int(0, 10)),
  p('oa.quiet_gap', 3, 'days', 'Manager', 'oa.cadence', 'Gap between follow-ups',
    'Each one lands outside the 24h window, so each costs a template send.', int(1, 30)),
  p('oa.stalled_day', 7, 'days', 'Manager', 'oa.cadence', 'Stalled flag',
    'Still pending after this many days, a written reason becomes required.', int(1, 90)),
  p('oa.winback_day', 30, 'days', 'Manager', 'oa.cadence', 'Win-back message',
    'One template to cold leads, then archive. Rule r9 is disabled at launch.', int(1, 365)),

  // Capacity
  p('oa.shift_minutes', 480, 'min', 'Manager', 'oa.capacity', 'Shift length',
    'Working minutes in an agent day (08:30–16:30).', int(60, 720)),
  p('oa.reserved_minutes', 60, 'min', 'Manager', 'oa.capacity', 'Reserved blocks',
    'Morning triage + end-of-day close, not assignable.', int(0, 720)),
  p('oa.max_open_leads', 12, 'leads', 'Manager', 'oa.capacity', 'Maximum open leads per agent',
    'A relationship ceiling on top of the minute budget. Open decision 2.', int(1, 200),
    { openDecision: 'OA-12' }),
  p('oa.holding_sweep_interval', 15, 'min', 'manage_automation', 'oa.capacity', 'Re-check the holding queue every',
    'A lead with no free agent waits here, never with nobody.', int(1, 240)),
  p('oa.holding_escalation', 60, 'min', 'manage_automation', 'oa.capacity', 'Holding-queue escalation',
    'Notify the shift lead when a lead has waited beyond this.', int(1, 1440)),

  // Business hours — OA 12.1 "Team & skills" (not an Appendix D row, but every business-hours
  // clock depends on them: first_contact_sla, the holding queue, the first-contact metric).
  // Defaults follow the 08:30–16:30 shift; the working week is an assumption to confirm.
  p('oa.business_timezone', 'Africa/Tripoli', null, 'Manager', 'oa.capacity', 'Team time zone',
    'Business hours and "today" are evaluated in this zone.', oneOf('Africa/Tripoli', 'Asia/Baghdad', 'Asia/Beirut')),
  p('oa.business_open', '08:30', null, 'Manager', 'oa.capacity', 'Shift opens', 'Start of business hours.', time()),
  p('oa.business_close', '16:30', null, 'Manager', 'oa.capacity', 'Shift closes', 'End of business hours.', time()),
  p('oa.business_days', 'sun,mon,tue,wed,thu', null, 'Manager', 'oa.capacity', 'Working days',
    'Days the onboarding team works.', weekdays(), { openDecision: 'working week' }),

  // Time model — all estimate until OA-3 calibration
  ...[
    ['walkthrough_minutes', 20, 'Walkthrough call', 'The scheduled call itself.'],
    ['walkthrough_buffer', 5, 'Walkthrough buffer', 'Notes and the handoff record after the call.'],
    ['first_contact_minutes', 6, 'First contact call', 'The first call to a new registrant.'],
    ['wrap_minutes', 3, 'Call wrap-up', 'Logging the outcome after any answered call.'],
    ['no_answer_minutes', 1.5, 'Unanswered call', 'Dial, wait, log.'],
    ['followup_minutes', 4, 'Cadence follow-up', 'One cadence touch with its note.'],
    ['compose_minutes', 2, 'Writing a message', 'A free-text outbound reply.'],
    ['read_minutes', 0.5, 'Reading a message', 'An inbound message from the merchant.'],
    ['template_minutes', 0.5, 'Sending a template', 'Pre-written, so it costs money not time.'],
    ['note_minutes', 1.5, 'Internal note', 'Written for the AM or the next agent.'],
    ['activation_minutes', 12, 'Activation + handoff record', 'Accept action + the eight-field handoff record.'],
  ].map(([k, d, label, help]) =>
    p(`oa.${k}`, d, 'min', 'Manager', 'oa.time_model', label, help, num(0, 240), { estimate: true })),

  // Templates
  p('oa.template_budget_month', 400, 'sends', 'Manager', 'oa.templates', 'Template budget, Onboarding',
    'Monthly ceiling across the whole onboarding team. Seeded low — open decision 1.', int(0, 1_000_000),
    { openDecision: 'OA-11' }),
  p('oa.template_per_contact_cap', 8, 'sends', 'Manager', 'oa.templates', 'Template ceiling per contact',
    'Hard stop, whatever the cadence asks for.', int(0, 100)),
  p('oa.marketing_templates', 'prohibited', null, 'Administrator', 'oa.templates', 'Marketing templates',
    'Marketing-category templates on the onboarding number.', oneOf('prohibited')),

  // Assignment — strategies are named implementations; a new one is engineering (OA 12.2)
  p('oa.assignment_strategy', 'most_free_minutes', null, 'manage_automation', 'oa.assignment', 'Assignment strategy',
    'Agents never pick leads; the platform assigns.', oneOf('most_free_minutes')),
  p('oa.assignment_skill', 'contact.country', null, 'manage_automation', 'oa.assignment', 'Skill dimension',
    'Soft — falls back to the whole team.', oneOf('contact.country', 'none')),
  p('oa.assignment_tiebreak', 'fewest_open_leads', null, 'manage_automation', 'oa.assignment', 'Tie-break',
    'Applied when two agents have the same free minutes.', oneOf('fewest_open_leads')),

  // Rules — "All ten: … enable / disable" (OA 12.1). r9 win-back ships built but disabled (decision 10).
  ...[
    ['r1', true, 'New registration → Onboarding queue'],
    ['r2', true, 'First contact overdue → notify agent + shift lead'],
    ['r3', true, 'No-answer cadence — daily reminder'],
    ['r4', true, 'No-answer cutoff → Cold Lead'],
    ['r5', true, 'Went quiet → follow-up template'],
    ['r6', true, 'Went-quiet cutoff → Cold Lead'],
    ['r7', true, 'Reply resets the cadence — once'],
    ['r8', true, 'Holding queue — assign as soon as capacity frees'],
    ['r9', false, 'Day-30 win-back, then archive'],
    ['r10', true, 'First order placed → close the onboarding ticket'],
  ].map(([id, on, label]) =>
    p(`oa.rule.${id}.enabled`, on, 'flag', 'manage_automation', 'oa.rules', `${id} — ${label}`, null, bool())),
];

// ─────────────────────────── Account Manager (AM Appendix D) ───────────────────────────
const AM = [
  // Health score
  p('am.wActivity', 30, '%', 'Admin', 'am.health', 'Order Activity weight',
    'Orders in the last 30 days against the seller’s own baseline.', int(0, 100)),
  p('am.wDelivery', 25, '%', 'Admin', 'am.health', 'Delivery Performance weight',
    'Delivery rate against the team target band.', int(0, 100)),
  p('am.wEngagement', 20, '%', 'Admin', 'am.health', 'Engagement weight',
    'Login, store edits and reply latency. Requires F5 Activity Tracking.', int(0, 100)),
  p('am.wFinancial', 15, '%', 'Admin', 'am.health', 'Financial Health weight',
    'Wallet position and payment friction.', int(0, 100)),
  p('am.wGrowth', 10, '%', 'Admin', 'am.health', 'Growth Potential weight',
    'Month-over-month order growth, catalogue depth, markets served.', int(0, 100)),
  p('am.engagementLive', false, 'flag', 'Admin', 'am.health', 'Engagement data live',
    'Turns off the fallback redistribution. Set when F5 ships.', bool()),
  p('am.bandRisk', 40, 'pts', 'Admin', 'am.health', 'Critical ceiling',
    'At or below this score a seller is Critical.', int(0, 100)),
  p('am.bandHealthy', 60, 'pts', 'Admin', 'am.health', 'At Risk ceiling',
    'At or below this score a seller is At Risk.', int(0, 100)),
  p('am.bandThriving', 80, 'pts', 'Admin', 'am.health', 'Healthy ceiling',
    'Above this score a seller is Thriving.', int(0, 100)),

  // Quarter targets
  p('am.deliveryTarget', 35, '%', 'Admin', 'am.targets', 'Delivery rate target',
    'Denominator of the delivery half of the score. Raising it lowers every seller’s score.', num(1, 100)),
  p('am.returnTarget', 24, '%', 'Admin', 'am.targets', 'Return rate target',
    'Display only. The returns formula uses a fixed 15% knee.', num(0, 100)),
  p('am.cancelTarget', 33, '%', 'Admin', 'am.targets', 'Cancellation rate target',
    'Display only.', num(0, 100)),

  // Alert thresholds
  p('am.healthCritical', 40, 'pts', 'Admin', 'am.alerts', 'Critical alert threshold',
    'Health below this opens SELLER_HEALTH_CRITICAL (r2). Also the first inactivity floor step.', int(0, 100)),
  p('am.inactiveDays', 7, 'days', 'Admin', 'am.alerts', 'Inactivity trigger',
    'Days without an order before SELLER_INACTIVE fires (r4). First floor.', int(1, 365)),
  p('am.saveDays', 14, 'days', 'Admin', 'am.alerts', 'Save-campaign trigger',
    'Days without an order before a save campaign opens (r5). Second floor.', int(1, 365)),
  p('am.churnDays', 30, 'days', 'Admin', 'am.alerts', 'Churn threshold',
    'Days without an order before the seller is marked Churned (r11, off). Third floor.', int(1, 365)),
  p('am.returnAlertPct', 40, '%', 'Admin', 'am.alerts', 'High-return threshold',
    'Return rate above this, sustained, opens SELLER_HIGH_RETURNS (r6).', num(0, 100)),
  p('am.returnAlertWeeks', 2, 'wks', 'Admin', 'am.alerts', 'High-return duration',
    'Consecutive weeks above the threshold before the alert fires.', int(1, 8)),
  p('am.orderDropPct', 30, '%', 'Admin', 'am.alerts', 'Order-decline threshold',
    'Week-over-week drop that opens SELLER_ORDER_DECLINE (r3). Below about 25 it fires on noise.', num(1, 100)),
  p('am.ticketAlert', 3, 'open', 'Admin', 'am.alerts', 'Support escalation threshold',
    'Unresolved tickets before SELLER_SUPPORT_ESCALATION fires (r7).', int(1, 100)),
  p('am.walletDays', 30, 'days', 'Admin', 'am.alerts', 'Negative-wallet threshold',
    'Days negative before a Finance coordination task opens (r8).', int(1, 365)),

  // Service levels and cadence
  p('am.welcomeCallH', 24, 'h', 'Admin', 'am.service', 'Welcome call SLA',
    'Hours from assignment to the welcome call. Measured at 100%.', int(1, 168)),
  p('am.responseH', 4, 'h', 'Admin', 'am.service', 'Response time SLA',
    'Reporting only; read from the conversation record.', int(1, 168)),
  p('am.firstOrderDays', 7, 'days', 'Admin', 'am.service', 'First order target',
    'Reporting only.', int(1, 90)),
  p('am.qbrDays', 90, 'days', 'Admin', 'am.service', 'Business review cadence',
    'Days between reviews for Mature sellers (r9).', int(7, 365)),
  p('am.cadRisk', 8, 'days', 'Admin', 'am.service', 'At Risk contact cadence',
    'Days between deliberate contacts for an At Risk seller. Drives r13 and the capacity rate.', int(1, 90)),
  p('am.cadHealthy', 18, 'days', 'Admin', 'am.service', 'Healthy contact cadence',
    'Days between deliberate contacts for a Healthy seller.', int(1, 180)),
  p('am.cadThriving', 26, 'days', 'Admin', 'am.service', 'Thriving contact cadence',
    'Days between deliberate contacts for a Thriving seller.', int(1, 365)),

  // Time model
  ...[
    ['mWelcome', 30, 'Welcome call', 'From the role definition. The only measured duration.'],
    ['mCheckin', 20, 'Check-in', 'Also the numerator of the cadence rate.'],
    ['mQbr', 45, 'Business review', 'Calibrated, not measured — D-09.'],
    ['mCoach', 30, 'Coaching session', 'Minutes booked for a coaching session.'],
    ['mIntervention', 25, 'Intervention', 'Minutes booked for an intervention call.'],
    // Not an Appendix D row, but AM 2.3 books a save task at 35 minutes and says every
    // minute value is configuration, not code.
    ['mSave', 35, 'Save campaign', 'Minutes booked for a save-campaign call.'],
    ['mExpansion', 40, 'Expansion session', 'Minutes booked for a cross-market briefing.'],
    ['mCoord', 15, 'Coordination', 'Minutes booked for internal coordination on a seller.'],
  ].map(([k, d, label, help]) => p(`am.${k}`, d, 'min', 'Admin', 'am.time_model', label, help, num(0, 480))),
  p('am.wrapPct', 12, '%', 'Admin', 'am.time_model', 'Wrap-up overhead',
    'Added to every booked minute for notes and logging.', num(0, 100)),
  ...[
    ['bNew', 30, 'New'], ['bOnboarding', 40, 'Onboarding'], ['bActivated', 20, 'Activated'],
    ['bActive', 8, 'Active'], ['bGrowth', 10, 'Growth'], ['bMature', 6, 'Mature'],
    ['bAtRisk', 20, 'Recovering'], ['bChurned', 2, 'Churned'],
  ].map(([k, d, stage]) => p(`am.${k}`, d, 'min/wk', 'Admin', 'am.time_model', `${stage} — weekly baseline`,
    'Unplanned messaging and advisory minutes per seller per week.', num(0, 600))),

  // Capacity
  p('am.shiftMin', 480, 'min', 'Admin', 'am.capacity', 'Shift length', 'Working minutes in one day.', int(60, 720)),
  p('am.workDays', 5, 'days', 'Admin', 'am.capacity', 'Working days', 'Days per week.', int(1, 7)),
  p('am.reservedPct', 15, '%', 'Admin', 'am.capacity', 'Reserved time',
    'Standup, internal meetings, training — removed before the book is loaded.', num(0, 99)),
  p('am.maxBook', 50, 'sellers', 'Admin', 'am.capacity', 'Book ceiling',
    'Maximum sellers one AM may hold. Raising it does not create hours (Part 8.5).', int(1, 1000)),

  // Rules (AM 5.6). r11 off — blocked on D-04; r12 off by design (Part 3.4).
  ...[
    ['r1', true, 'Handover from Onboarding'], ['r2', true, 'Health critical'], ['r3', true, 'Order decline'],
    ['r4', true, 'Inactivity check-in'], ['r5', true, 'Save campaign'], ['r6', true, 'High returns'],
    ['r7', true, 'Support escalation'], ['r8', true, 'Payment issue'], ['r9', true, 'Business review clock'],
    ['r10', true, 'Onboarding playbook clock'], ['r11', false, 'Churn marking'], ['r12', false, 'Book rebalance'],
    ['r13', true, 'Proactive contact cadence'],
  ].map(([id, on, label]) =>
    p(`am.rule.${id}.enabled`, on, 'flag', 'Admin', 'am.rules', `${id} — ${label}`, null, bool())),
];

export const PARAMETERS = Object.freeze([...OA, ...AM].map(Object.freeze));
export const PARAMETER_MAP = Object.freeze(Object.fromEntries(PARAMETERS.map((x) => [x.key, x])));

/** Launch defaults as a flat, key-sorted object — the v1 snapshot. */
export function defaultValues() {
  return Object.fromEntries(PARAMETERS.map((x) => [x.key, x.default]).sort(([a], [b]) => a.localeCompare(b)));
}

export const AM_HEALTH_WEIGHT_KEYS = ['am.wActivity', 'am.wDelivery', 'am.wEngagement', 'am.wFinancial', 'am.wGrowth'];
