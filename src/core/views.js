// Personal saved views (OA 6.3): a stored filter with a name and a sort order. "Personal — the
// agent — unlimited; the one configuration surface an agent owns." A view is a query, not a folder:
// a ticket shows in every view whose conditions it meets and is never moved. Who may save one is
// Appendix A's "Author personal macro / view" (macro.author_personal); each person sees and deletes
// only their own. The column set stays the prototype's — it has no column picker.
import { prisma } from '../db.js';
import { badRequest, forbidden, notFound } from '../http/errors.js';
import { grant } from '../auth/permissions.js';
import { denialReason } from '../auth/scope.js';
import { logEvent } from '../services/audit.js';

const MODULES = ['oa'];
// the onboarding queue's own views (the prototype's VIEWS keys) a saved view can start from
const BASES = ['mine', 'due', 'waiting', 'all', 'attempting', 'quiet', 'booked', 'activated', 'closed', 'shut'];
// the queue's filters (the funnel: country, source, channel, window state, owner; and the period)
const FILTER_KEYS = ['country', 'source', 'channel', 'win', 'owner', 'when', 'from', 'to'];
const SORTS = ['due', 'newest'];

const shape = (v) => {
  const f = JSON.parse(v.filters || '{}');
  return { id: v.id, module: v.module, name: v.name, base: f.base ?? 'all', filters: f.filters ?? {}, sort: v.sort ?? 'due' };
};

export async function listViews(user, module = 'oa', db = prisma) {
  if (!MODULES.includes(module)) throw badRequest(`module must be one of ${MODULES.join(', ')}.`);
  const rows = await db.savedView.findMany({ where: { module, scope: 'personal', ownerId: user.id }, orderBy: { id: 'asc' } });
  return rows.map(shape);
}

export async function createView(user, { module = 'oa', name, base, filters = {}, sort = 'due' } = {}, db = prisma) {
  if (grant(user.role, 'macro.author_personal') !== true) throw forbidden(denialReason(user, 'macro.author_personal'));
  if (!MODULES.includes(module)) throw badRequest(`module must be one of ${MODULES.join(', ')}.`);
  const label = String(name ?? '').trim();
  if (!label) throw badRequest('Give the view a name.');
  if (label.length > 60) throw badRequest('A view name is at most 60 characters.');
  if (!BASES.includes(base)) throw badRequest('Unknown view to start from.');
  if (!SORTS.includes(sort)) throw badRequest(`sort must be one of ${SORTS.join(', ')}.`);
  const clean = {};
  for (const [k, v] of Object.entries(filters ?? {})) {
    if (!FILTER_KEYS.includes(k)) throw badRequest(`Unknown filter "${k}".`);
    if (v !== '' && v !== null && v !== undefined) clean[k] = String(v).slice(0, 80);
  }
  const taken = await db.savedView.findFirst({ where: { module, scope: 'personal', ownerId: user.id, name: label } });
  if (taken) throw badRequest('You already have a view with that name.');
  const row = await db.savedView.create({ data: { module, scope: 'personal', ownerId: user.id, name: label, filters: JSON.stringify({ base, filters: clean }), sort } });
  await logEvent({ actorId: user.id, entityType: 'user', entityId: user.id, action: 'view.saved', after: { id: row.id, name: label, base, filters: clean, sort } }, db);
  return shape(row);
}

export async function deleteView(user, id, db = prisma) {
  const row = await db.savedView.findUnique({ where: { id } });
  if (!row || row.scope !== 'personal' || row.ownerId !== user.id) throw notFound('No such view.');
  await db.savedView.delete({ where: { id } });
  await logEvent({ actorId: user.id, entityType: 'user', entityId: user.id, action: 'view.deleted', before: { id, name: row.name } }, db);
  return { ok: true };
}
