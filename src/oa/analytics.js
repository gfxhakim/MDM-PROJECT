// Onboarding analytics (OA Part 12): the Operations and Performance workspaces, computed from the
// tickets, conversations and event log — never typed in. Onboarding work counts toward completion
// metrics only (counts_toward: none), so nothing here feeds support SLA/CSAT.
//
// Handle time is derived, not measured (OA 4.4): each recorded act is priced at the configured
// minute value. A lead's minutes = messages × compose/read/template + calls × call minutes +
// walkthrough + wrap/note minutes.
import { prisma } from '../db.js';
import { getLiveConfig } from '../config/service.js';

const DAY = 86_400_000;
const COUNTRY = { LY: 'Libya', IQ: 'Iraq', LB: 'Lebanon' };
const SOURCE_LABEL = (s) => {
  const v = String(s || '').toLowerCase();
  if (!v || v === 'whatsapp' || v.includes('company')) return 'WhatsApp — Company line';
  if (v.includes('portal') || v.includes('google') || v.includes('organic')) return 'Portal registration';
  if (v.includes('ref') || v.includes('affiliate')) return 'Referral link';
  if (v.includes('fb') || v.includes('meta') || v.includes('facebook') || v.includes('instagram') || v.includes('tiktok')) return 'Meta / Facebook ads';
  return 'Portal registration';
};
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const filled = (v) => typeof v === 'string' && v.trim().length > 0;

/** ISO week label W<nn> for a date. */
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `W${String(Math.ceil(((t - y0) / DAY + 1) / 7)).padStart(2, '0')}`;
}

export async function onboardingAnalytics({ days = 90, now = new Date(), db = prisma } = {}) {
  const { values: c } = await getLiveConfig(db);
  const since = new Date(now.getTime() - days * DAY);
  const tickets = await db.ticket.findMany({ where: { type: 'onboarding_task', createdAt: { gte: since } }, include: { contact: true } });
  const ids = tickets.map((t) => t.id);
  const contactIds = [...new Set(tickets.map((t) => t.contactId))];
  const [convs, events, versions, agents] = await Promise.all([
    db.conversation.findMany({ where: { contactId: { in: contactIds } }, include: { messages: { select: { kind: true, direction: true, createdAt: true, templateKey: true } } } }),
    db.eventLog.findMany({ where: { entityType: 'ticket', entityId: { in: ids } }, orderBy: { createdAt: 'asc' } }),
    db.configVersion.findMany({ where: { createdAt: { gte: since } }, orderBy: { id: 'asc' } }),
    db.user.findMany({ where: { role: 'OA_AGENT' }, select: { id: true, name: true } }),
  ]);
  const convBy = new Map(convs.map((x) => [x.contactId, x]));
  const evBy = new Map();
  for (const e of events) evBy.set(e.entityId, [...(evBy.get(e.entityId) ?? []), e]);

  const isActivated = (t) => t.status === 'activated';
  const isCold = (t) => t.status === 'cold_lead';
  const isJunk = (t) => t.status === 'junk_lead';
  const walked = (t) => !!t.walkthroughAt;
  const tags = (t) => JSON.parse(t.tags || '[]');
  const firstOutbound = (t) => (convBy.get(t.contactId)?.messages ?? []).filter((m) => m.direction === 'out' && m.createdAt >= t.createdAt).sort((a, b) => a.createdAt - b.createdAt)[0]?.createdAt
    ?? (evBy.get(t.id) ?? []).find((e) => e.action === 'ticket.call_logged')?.createdAt ?? null;
  const cleanHandoff = (t) => {
    const h = JSON.parse(t.handoffRecord || '{}');
    return ['sellerProfile', 'intent', 'servicesDiscussed', 'objections', 'commitments', 'riskNotes'].every((k) => filled(h[k]));
  };
  const orderIn7 = (t) => !!t.firstOrderAt && !!t.closedAt && t.firstOrderAt - t.closedAt <= 7 * DAY;

  // derived handle time per lead
  function minutes(t) {
    const msgs = convBy.get(t.contactId)?.messages ?? [];
    const sent = msgs.filter((m) => m.direction === 'out' && m.kind === 'text').length;
    const recv = msgs.filter((m) => m.direction === 'in').length;
    const tpl = msgs.filter((m) => m.kind === 'template').length;
    const notes = msgs.filter((m) => m.kind === 'note').length;
    const calls = (evBy.get(t.id) ?? []).filter((e) => e.action === 'ticket.call_logged');
    const noAnswer = calls.filter((e) => e.reason === 'no_answer').length;
    const answered = calls.length - noAnswer;
    return {
      msg: sent * c['oa.compose_minutes'] + recv * c['oa.read_minutes'] + tpl * c['oa.template_minutes'],
      call: answered * (c['oa.first_contact_minutes'] + c['oa.wrap_minutes']) + noAnswer * c['oa.no_answer_minutes'],
      wt: walked(t) ? c['oa.walkthrough_minutes'] + c['oa.walkthrough_buffer'] : 0,
      other: notes * c['oa.note_minutes'] + (isActivated(t) ? c['oa.activation_minutes'] : 0),
    };
  }
  const handleRow = (k, list) => {
    if (!list.length) return { k, n: 0, msg: 0, call: 0, wt: 0, other: 0 };
    const sum = list.map(minutes).reduce((a, m) => ({ msg: a.msg + m.msg, call: a.call + m.call, wt: a.wt + m.wt, other: a.other + m.other }), { msg: 0, call: 0, wt: 0, other: 0 });
    return { k, n: list.length, msg: Math.round(sum.msg / list.length), call: Math.round(sum.call / list.length), wt: Math.round(sum.wt / list.length), other: Math.round(sum.other / list.length) };
  };

  // weeks: the last 12 ISO weeks ending now
  const weeks = [];
  for (let i = 11; i >= 0; i--) {
    const end = new Date(now.getTime() - i * 7 * DAY);
    weeks.push({ w: isoWeek(end), from: new Date(end.getTime() - 7 * DAY), to: end });
  }
  const inWeek = (d, wk) => d >= wk.from && d < wk.to;
  const allSince12 = weeks[0].from < since
    ? await db.ticket.findMany({ where: { type: 'onboarding_task', createdAt: { gte: weeks[0].from } }, select: { createdAt: true, status: true, closedAt: true } })
    : tickets;

  const group = (keyOf, labels) => {
    const m = new Map((labels || []).map((k) => [k, { k, reg: 0, act: 0 }]));
    for (const t of tickets) {
      const k = keyOf(t);
      if (!m.has(k)) m.set(k, { k, reg: 0, act: 0 });
      const row = m.get(k); row.reg++; if (isActivated(t)) row.act++;
    }
    return [...m.values()];
  };

  const lost = tickets.filter((t) => isCold(t) || isJunk(t));
  const lossRows = [
    ['Never answered — cadence exhausted', (t) => isCold(t) && tags(t).includes('oa_cold_no_answer')],
    ['Went quiet after the Hub link', (t) => isCold(t) && tags(t).includes('oa_cold_went_quiet')],
    ['Moved to Cold by hand — reason on the ticket', (t) => isCold(t) && !tags(t).some((x) => x.startsWith('oa_cold_'))],
    ['Junk / fake registration', isJunk],
  ].map(([k, f]) => { const n = lost.filter(f).length; return { k, n, pct: pct(n, lost.length) }; });

  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const oaKeys = (await db.template.findMany({ where: { module: 'oa' }, select: { key: true } })).map((t) => t.key);
  const tplUsed = await db.message.count({ where: { kind: 'template', direction: 'out', templateKey: { in: oaKeys }, createdAt: { gte: monthStart } } });
  const tplByAgent = await db.message.groupBy({ by: ['authorUserId'], where: { kind: 'template', direction: 'out', templateKey: { in: oaKeys }, createdAt: { gte: since } }, _count: true });

  return {
    windowDays: days,
    registrants: tickets.length,
    activated: tickets.filter(isActivated).length,
    walkthroughs: tickets.filter(walked).length,
    cold: tickets.filter(isCold).length,
    junk: tickets.filter(isJunk).length,
    weeks: weeks.map((wk) => ({ w: wk.w, reg: allSince12.filter((t) => inWeek(t.createdAt, wk)).length, act: allSince12.filter((t) => t.status === 'activated' && inWeek(t.createdAt, wk)).length })),
    marks: versions.filter((v) => v.id > 1).map((v) => ({ w: isoWeek(v.createdAt), t: v.note || `Configuration v${v.id}` })),
    bySource: group((t) => SOURCE_LABEL(t.contact.sourceUtm), ['WhatsApp — Company line', 'Portal registration', 'Referral link', 'Meta / Facebook ads']),
    byCountry: group((t) => COUNTRY[t.contact.country] || t.contact.country, ['Libya', 'Iraq', 'Lebanon']),
    agents: agents.map((a) => {
      const mine = tickets.filter((t) => t.assigneeId === a.id);
      const act = mine.filter(isActivated);
      const firsts = mine.map((t) => [t, firstOutbound(t)]).filter(([, f]) => f);
      const avgH = firsts.length ? Math.round((firsts.reduce((s, [t, f]) => s + (f - t.createdAt), 0) / firsts.length / 3_600_000) * 10) / 10 : 0;
      return {
        id: a.id, name: a.name, reg: mine.length, act: act.length,
        first: pct(firsts.filter(([t, f]) => f - t.createdAt <= c['oa.first_contact_sla'] * 3_600_000).length, mine.length),
        clean: pct(act.filter(cleanHandoff).length, act.length), order: pct(act.filter(orderIn7).length, act.length),
        overdue: mine.filter((t) => ['new', 'failed_to_contact', 'prequalified', 'qualified'].includes(t.status) && t.dueAt && t.dueAt < now).length,
        walk: mine.filter(walked).length, avgH, qa: null,
        tpl: tplByAgent.find((x) => x.authorUserId === a.id)?._count ?? 0,
      };
    }),
    cohort: weeks.slice(-6).map((wk) => {
      const reg = allSince12.filter((t) => inWeek(t.createdAt, wk));
      const by = (d) => pct(reg.filter((t) => t.status === 'activated' && t.closedAt && t.closedAt - t.createdAt <= d * DAY).length, reg.length);
      return { w: wk.w, n: reg.length, d7: by(7), d14: by(14), d30: by(30) };
    }),
    loss: lossRows,
    tplUsed,
    handle: [
      handleRow('Activated', tickets.filter(isActivated)),
      handleRow('Cold — never answered', tickets.filter((t) => isCold(t) && tags(t).includes('oa_cold_no_answer'))),
      handleRow('Cold — went quiet', tickets.filter((t) => isCold(t) && !tags(t).includes('oa_cold_no_answer'))),
      handleRow('Junk / fake', tickets.filter(isJunk)),
    ],
    ruleRuns: await ruleRuns(db, new Date(now.getTime() - DAY)),
    ruleRunsWindow: await ruleRuns(db, since),
  };
}

/** How often each onboarding rule acted, read from the event log and notifications. */
async function ruleRuns(db, since) {
  const ev = await db.eventLog.findMany({ where: { entityType: 'ticket', createdAt: { gte: since }, actorId: null }, select: { action: true, reason: true } });
  const out = { r1: 0, r2: 0, r3: 0, r4: 0, r5: 0, r6: 0, r7: 0, r8: 0, r9: 0, r10: 0 };
  for (const e of ev) {
    const m = /^(r\d+)\b/.exec(e.reason || '');
    if (m && m[1] in out) out[m[1]]++;
    else if (e.action === 'ticket.created') out.r1++;
  }
  out.r3 = await db.notification.count({ where: { kind: 'oa.r3.attempt_due', createdAt: { gte: since } } });
  return out;
}
