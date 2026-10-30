// The onboarding rule sweep (OA Appendix B), run on an interval, after every config publish,
// and — against a rolled-back transaction with the draft config — by simulate.
//
// Precedence (OA 5.6): r7 is event-driven and always wins; then cutoffs r4/r6, then the r5
// send, then the r3 reminder, then r2 escalation. r8 (holding queue) and r9 (win-back) follow.
// Every step is idempotent: state guards and notification dedupe keys mean a second run with no
// time passing changes nothing.
import { prisma } from '../db.js';
import { getLiveConfig } from '../config/service.js';
import { sendTemplate } from '../core/conversations.js';
import { notify, notifyRole } from '../core/notifications.js';
import { TICKET_TYPES } from '../core/ticketTypes.js';
import { businessMinutesBetween, hoursFromConfig, isBusinessTime } from './businessHours.js';
import { pickAgent } from './capacity.js';
import { changeTicket } from './service.js';

const OPEN = TICKET_TYPES.onboarding_task.openStatuses;
const DAY = 86_400_000;
const HOUR = 3_600_000;
const tagsOf = (t) => JSON.parse(t.tags ?? '[]');
const withTag = (t, tag) => JSON.stringify([...new Set([...tagsOf(t), tag])]);

async function withConversations(db, where) {
  const tickets = await db.ticket.findMany({ where: { type: 'onboarding_task', ...where }, include: { contact: true }, orderBy: { createdAt: 'asc' } });
  const convs = await db.conversation.findMany({ where: { contactId: { in: tickets.map((t) => t.contactId) } } });
  const byContact = new Map(convs.map((c) => [c.contactId, c]));
  return tickets.map((t) => ({ t, conv: byContact.get(t.contactId) ?? null }));
}

const awaitingReply = (conv) => !!conv?.lastInboundAt && !!conv.lastOutboundAt && conv.lastOutboundAt > conv.lastInboundAt;

/**
 * Run every enabled onboarding rule once.
 * @param {{ db?, config?, now?: Date, simulate?: boolean }} opts
 * @returns per-rule counts, plus template sends and leads moved to Cold (what simulate reports).
 */
export async function runOnboardingSweep({ db = prisma, config, now = new Date(), simulate = false } = {}) {
  const c = config ?? (await getLiveConfig(db)).values;
  const on = (r) => c[`oa.rule.${r}.enabled`];
  const out = { r2: 0, r3: 0, r4: 0, r5: 0, r5Skipped: [], r6: 0, r8: 0, r8Escalated: 0, r9: 0 };
  const bh = hoursFromConfig(c);

  // r4 — no-answer cutoff (also applies a lowered no_answer_max to open tickets, OA 5.7)
  if (on('r4')) {
    for (const { t, conv } of await withConversations(db, { status: 'failed_to_contact', attemptNo: { gte: c['oa.no_answer_max'] } })) {
      if (conv?.lastInboundAt && now - conv.lastInboundAt <= 24 * HOUR) continue;
      await changeTicket(db, t, { status: 'cold_lead', dueAt: null, nextAttemptAt: null, closedAt: now, tags: withTag(t, 'oa_cold_no_answer') },
        { action: 'ticket.status_changed', reason: `r4 — ${t.attemptNo} attempts, no answer — cadence cutoff` });
      if (conv) await db.message.create({ data: { conversationId: conv.id, direction: 'internal', kind: 'system', body: `Moved to Cold Lead by rule r4: ${t.attemptNo} daily attempts, no answer.` } });
      await notify({ userId: t.assigneeId, kind: 'oa.r4.cold', title: `${t.contact.name} moved to Cold Lead`, ticketId: t.id, dedupeKey: `oa.r4:${t.id}` }, db);
      out.r4++;
    }
  }

  // r6 — went-quiet cutoff, once the last follow-up has had its gap
  if (on('r6')) {
    for (const { t, conv } of await withConversations(db, { status: { in: ['prequalified', 'qualified'] }, followupNo: { gte: c['oa.quiet_max'] } })) {
      if (!conv?.lastInboundAt || now - conv.lastInboundAt <= c['oa.quiet_gap'] * DAY) continue;
      if (t.nextFollowupAt && t.nextFollowupAt > now) continue;
      await changeTicket(db, t, { status: 'cold_lead', dueAt: null, nextFollowupAt: null, closedAt: now, tags: withTag(t, 'oa_cold_went_quiet') },
        { action: 'ticket.status_changed', reason: `r6 — ${t.followupNo} follow-ups, no reply — went-quiet cutoff` });
      await notify({ userId: t.assigneeId, kind: 'oa.r6.cold', title: `${t.contact.name} moved to Cold Lead`, ticketId: t.id, dedupeKey: `oa.r6:${t.id}` }, db);
      out.r6++;
    }
  }

  // r5 — went quiet → follow-up template, only with budget remaining (the condition is load-bearing)
  if (on('r5')) {
    for (const { t, conv } of await withConversations(db, { status: { in: ['prequalified', 'qualified'] }, followupNo: { lt: c['oa.quiet_max'] } })) {
      if (!awaitingReply(conv)) continue;
      const due = t.nextFollowupAt ? t.nextFollowupAt <= now : now - conv.lastOutboundAt >= c['oa.quiet_gap'] * DAY;
      if (!due || t.contact.optedOut || t.contact.blocked) continue;
      try {
        await sendTemplate(null, conv.id, 'oa_nudge_v2', [t.contact.name], { now, automated: true, ruleId: 'r5', config: c, silent: simulate }, db);
      } catch (err) {
        out.r5Skipped.push({ ticketId: t.id, reason: err.message });
        continue;
      }
      const next = new Date(now.getTime() + c['oa.quiet_gap'] * DAY);
      await changeTicket(db, t, { followupNo: t.followupNo + 1, nextFollowupAt: next, dueAt: next },
        { action: 'ticket.followup_sent', reason: `r5 — follow-up ${t.followupNo + 1} of ${c['oa.quiet_max']}` });
      out.r5++;
    }
  }

  // r3 — no-answer reminder ("Attempt n+1 of max due"); never fabricates an attempt
  if (on('r3')) {
    const due = await db.ticket.findMany({
      where: { type: 'onboarding_task', status: 'failed_to_contact', attemptNo: { lt: c['oa.no_answer_max'] }, nextAttemptAt: { lte: now } },
    });
    for (const t of due) {
      const n = await notify({
        userId: t.assigneeId, kind: 'oa.r3.attempt_due', title: `Attempt ${t.attemptNo + 1} of ${c['oa.no_answer_max']} due`,
        ticketId: t.id, dedupeKey: `oa.r3:${t.id}:${t.attemptNo + 1}`,
      }, db);
      if (n) out.r3++;
    }
  }

  // r2 — first contact overdue (business minutes) → assignee + shift lead
  if (on('r2')) {
    const candidates = await db.ticket.findMany({ where: { type: 'onboarding_task', status: 'new', stage: 'first_contact' }, include: { contact: true } });
    for (const t of candidates) {
      if (businessMinutesBetween(t.createdAt, now, bh) <= c['oa.first_contact_sla'] * 60) continue;
      if (tagsOf(t).includes('oa_first_contact_missed')) continue;
      await changeTicket(db, t, { tags: withTag(t, 'oa_first_contact_missed') }, { action: 'ticket.tagged', reason: 'r2 — first contact overdue' });
      const payload = { kind: 'oa.r2.first_contact_missed', title: `First contact overdue: ${t.contact.name}`, ticketId: t.id, dedupeKey: `oa.r2:${t.id}` };
      await notify({ ...payload, userId: t.assigneeId }, db);
      await notifyRole('SHIFT_LEAD', payload, db);
      out.r2++;
    }
  }

  // r8 — holding queue: assign as soon as capacity frees; escalate a quiet queue
  if (on('r8')) {
    const held = await db.ticket.findMany({ where: { type: 'onboarding_task', assigneeId: null, status: { in: OPEN } }, include: { contact: true }, orderBy: { createdAt: 'asc' } });
    const open = isBusinessTime(now, bh);
    for (const t of held) {
      if (open) {
        const pick = await pickAgent(t.contact.country, c, now, db);
        if (pick.agent) {
          await changeTicket(db, t, { assigneeId: pick.agent.id, holdReason: null, heldAt: null }, { action: 'ticket.assigned', reason: 'r8 — capacity freed' });
          await notify({ userId: pick.agent.id, kind: 'oa.r1.assigned', title: `New lead: ${t.contact.name}`, ticketId: t.id, dedupeKey: `oa.r8:${t.id}:${pick.agent.id}` }, db);
          out.r8++;
          continue;
        }
        if (t.holdReason !== pick.holdReason) await changeTicket(db, t, { holdReason: pick.holdReason }, { action: 'ticket.held', reason: 'r8' });
      }
      const heldFor = now - (t.heldAt ?? t.createdAt);
      if (open && heldFor > c['oa.holding_escalation'] * 60_000) {
        const sent = await notifyRole('SHIFT_LEAD', {
          kind: 'oa.r8.escalation', title: `Lead held ${Math.round(heldFor / 60_000)} min: ${t.contact.name}`, body: t.holdReason,
          ticketId: t.id, dedupeKey: `oa.r8.escalation:${t.id}`,
        }, db);
        if (sent.length) out.r8Escalated++;
      }
    }
  }

  // r9 — day-30 win-back (ships disabled)
  if (on('r9')) {
    const cold = await withConversations(db, { status: 'cold_lead', closedAt: { lte: new Date(now.getTime() - c['oa.winback_day'] * DAY) } });
    for (const { t, conv } of cold) {
      if (!conv || tagsOf(t).includes('oa_winback_sent') || t.contact.optedOut || t.contact.blocked) continue;
      try {
        await sendTemplate(null, conv.id, 'oa_winback_d30', [t.contact.name, 'new services'], { now, automated: true, ruleId: 'r9', config: c, silent: simulate }, db);
      } catch { continue; }
      await changeTicket(db, t, { tags: withTag(t, 'oa_winback_sent') }, { action: 'ticket.tagged', reason: 'r9 — win-back sent' });
      out.r9++;
    }
  }

  return { ...out, movedToCold: out.r4 + out.r6, templateSends: out.r5 + out.r9 };
}
