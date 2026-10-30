// Availability and selection — OA Part 4.2 and 4.3, exactly as written.
//
//   assignable = shift_minutes − reserved_minutes
//   committed  = walkthroughs_today × (walkthrough_minutes + walkthrough_buffer)
//              + first_contacts_due × (first_contact_minutes + wrap_minutes)
//              + followups_due      ×  followup_minutes
//   free       = max(0, assignable − committed)
//   lead_cost  = first_contact_minutes + wrap_minutes + (followup_minutes × 2)
//   slots      = 0 if on a call, else min(floor(free ÷ lead_cost), max_open_leads − open_leads)
//   can_take   = slots > 0
import { prisma } from '../db.js';
import { TICKET_TYPES } from '../core/ticketTypes.js';
import { hoursFromConfig, localDayBounds } from './businessHours.js';

const OPEN = TICKET_TYPES.onboarding_task.openStatuses;

/** Pure: the formula over counts. Also names the binding constraint (OA 4.2.2). */
export function availabilityFromCounts({ walkthroughsToday, firstContactsDue, followupsDue, openLeads, onCall }, c) {
  const assignable = c['oa.shift_minutes'] - c['oa.reserved_minutes'];
  const committed = walkthroughsToday * (c['oa.walkthrough_minutes'] + c['oa.walkthrough_buffer'])
    + firstContactsDue * (c['oa.first_contact_minutes'] + c['oa.wrap_minutes'])
    + followupsDue * c['oa.followup_minutes'];
  const free = Math.max(0, assignable - committed);
  const leadCost = c['oa.first_contact_minutes'] + c['oa.wrap_minutes'] + c['oa.followup_minutes'] * 2;
  const byMinutes = Math.floor(free / leadCost);
  const byCeiling = c['oa.max_open_leads'] - openLeads;
  const slots = onCall ? 0 : Math.max(0, Math.min(byMinutes, byCeiling));
  const binding = onCall ? 'on_call' : byCeiling <= byMinutes ? 'open_lead_ceiling' : 'minutes';
  return {
    assignable, committed, free, leadCost, openLeads, onCall: !!onCall,
    counts: { walkthroughsToday, firstContactsDue, followupsDue },
    slotsByMinutes: byMinutes, slotsByCeiling: byCeiling, slots, canTake: slots > 0, binding,
  };
}

/** Count an agent's work (OA 4.2.1) and apply the formula. */
export async function availability(agent, config, now = new Date(), db = prisma) {
  const { start, end } = localDayBounds(now, hoursFromConfig(config));
  const base = { type: 'onboarding_task', assigneeId: agent.id, status: { in: OPEN } };
  const isWalkthroughToday = { stage: 'walkthrough', walkthroughAt: { gte: start, lt: end } };
  const [walkthroughsToday, firstContactsDue, followupsDue, openLeads] = await Promise.all([
    db.ticket.count({ where: { ...base, ...isWalkthroughToday } }),
    db.ticket.count({ where: { ...base, status: 'new' } }),
    db.ticket.count({ where: { ...base, status: { in: OPEN.filter((s) => s !== 'new') }, dueAt: { lt: end }, NOT: isWalkthroughToday } }),
    db.ticket.count({ where: base }),
  ]);
  return availabilityFromCounts({ walkthroughsToday, firstContactsDue, followupsDue, openLeads, onCall: agent.onCall }, config);
}

export function onboardingAgents(db = prisma) {
  return db.user.findMany({ where: { role: 'OA_AGENT', active: true }, orderBy: { createdAt: 'asc' } });
}

/**
 * pick_agent (OA 4.3). Country is a soft skill: an empty pool falls back to the whole team.
 * Returns { agent, availability } or { agent: null, holdReason }.
 */
export async function pickAgent(country, config, now = new Date(), db = prisma, { ignoreCapacity = false } = {}) {
  const team = await onboardingAgents(db);
  if (!team.length) return { agent: null, holdReason: 'no onboarding agents' };
  let pool = config['oa.assignment_skill'] === 'contact.country'
    ? team.filter((a) => JSON.parse(a.markets).includes(country))
    : team;
  if (!pool.length) pool = team;

  const scored = await Promise.all(pool.map(async (a) => ({ agent: a, availability: await availability(a, config, now, db) })));
  const notOnCall = scored.filter((s) => !s.availability.onCall);
  if (!notOnCall.length) return { agent: null, holdReason: 'all agents on calls' };
  const eligible = ignoreCapacity ? notOnCall : notOnCall.filter((s) => s.availability.canTake);
  if (!eligible.length) return { agent: null, holdReason: 'no agent with free capacity' };
  // most_free_minutes, tie-break fewest_open_leads
  eligible.sort((x, y) => y.availability.free - x.availability.free || x.availability.openLeads - y.availability.openLeads);
  return eligible[0];
}
