// Exports (OA 12, AC-OA-18): the CSV is built from the same computation the screen renders, so
// they reconcile by construction. data.export is Admin-only (Manager: with Admin approval, so the
// endpoint refuses and says so). Every export is one audit entry naming what left the system.
import { prisma } from '../db.js';
import { logEvent } from '../services/audit.js';
import { onboardingAnalytics } from './analytics.js';
import { onboardingReadWhere } from '../auth/scope.js';

const cell = (v) => {
  const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (header, rows) => [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';

export async function exportOnboarding(user, kind, { days = 90 } = {}, db = prisma) {
  let csv; let count;
  if (kind === 'performance') {
    const a = await onboardingAnalytics({ days, db });
    const rows = a.agents.map((x) => [x.name, x.reg, x.act, x.reg ? Math.round((x.act / x.reg) * 100) : 0, x.first, x.clean, x.order, x.overdue, x.walk, x.avgH, x.tpl]);
    csv = toCsv(['Agent', 'Registrants', 'Activated', 'Activation rate %', 'First contact in SLA %', 'Clean handoff %', 'First order in 7 days %', 'Overdue', 'Walkthroughs', 'Avg hours to first contact', 'Template sends'], rows);
    count = rows.length;
  } else if (kind === 'leads') {
    const tickets = await db.ticket.findMany({ where: onboardingReadWhere(user), include: { contact: true, assignee: { select: { name: true } } }, orderBy: { createdAt: 'desc' } });
    const rows = tickets.map((t) => [t.id, t.contact.name, t.contact.phone, t.contact.country, t.contact.sourceUtm, t.status, t.stage, t.assignee?.name ?? '', t.holdReason, t.attemptNo, t.followupNo, t.createdAt, t.dueAt, t.closedAt]);
    csv = toCsv(['Ticket', 'Name', 'Phone', 'Country', 'Source', 'Status', 'Stage', 'Assignee', 'Hold reason', 'Attempt', 'Follow-up', 'Created', 'Due', 'Closed'], rows);
    count = rows.length;
  } else {
    throw Object.assign(new Error('kind must be "performance" or "leads".'), { status: 400, code: 'bad_request' });
  }
  await logEvent({ actorId: user.id, entityType: 'export', entityId: `oa.${kind}`, action: 'data.exported', after: { kind, rows: count, days } }, db);
  return { csv, count };
}
