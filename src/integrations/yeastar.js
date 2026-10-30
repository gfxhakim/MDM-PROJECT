// Yeastar PBX (optional). Call events attach to the one conversation as call lines and drive the
// agent's on-call presence (capacity excludes agents on a call). Outcomes are never inferred from
// the PBX: the no-answer cadence counts only what an agent logs (OA 5.3). Without Yeastar the
// app degrades to the manual presence toggle and agent-logged calls.
import { prisma } from '../db.js';
import { normalizePhone } from '../core/contacts.js';
import { logEvent } from '../services/audit.js';
import { runOnboardingSweep } from '../oa/rules.js';

export const yeastarConfig = () => ({
  webhookSecret: process.env.YEASTAR_WEBHOOK_SECRET || null,
  apiUrl: (process.env.YEASTAR_API_URL || '').replace(/\/$/, '') || null,
  accessToken: process.env.YEASTAR_ACCESS_TOKEN || null,
});

export const yeastarStatus = () => {
  const c = yeastarConfig();
  return {
    events: !!c.webhookSecret, clickToCall: !!(c.apiUrl && c.accessToken),
    detail: c.webhookSecret ? 'Receiving call events from Yeastar.' : 'Not connected (optional) — agents mark themselves on a call and log calls by hand.',
  };
};

const fmtDuration = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

/**
 * Normalised event: { type: 'call_end', callId, extension, number, direction, durationSec, answered }
 *                or { type: 'presence', extension, onCall }
 */
export async function handleYeastarEvent(evt, db = prisma) {
  const agent = evt.extension ? await db.user.findUnique({ where: { extension: String(evt.extension) } }) : null;
  if (evt.type === 'presence') {
    if (!agent) return { ok: false, reason: `No user has extension ${evt.extension}.` };
    await db.user.update({ where: { id: agent.id }, data: { onCall: !!evt.onCall } });
    if (!evt.onCall) await runOnboardingSweep({ db }); // capacity changed → holding queue (r8)
    return { ok: true, userId: agent.id, onCall: !!evt.onCall };
  }
  if (evt.type === 'call_end') {
    if (!evt.callId || !evt.number) return { ok: false, reason: 'callId and number are required.' };
    if (await db.message.findUnique({ where: { externalId: `yeastar:${evt.callId}` } })) return { ok: true, duplicate: true };
    // PBX numbers arrive without the leading + (218…) or with the 00 international prefix.
    const num = String(evt.number).trim().replace(/^00/, '+').replace(/^(\d{8,})$/, '+$1');
    const contact = await db.contact.findUnique({ where: { phone: normalizePhone(num) } });
    const conv = contact && (await db.conversation.findUnique({ where: { contactId: contact.id } }));
    if (!conv) return { ok: false, reason: 'No conversation for this number — call not attached.' };
    const dir = evt.direction === 'inbound' ? 'in' : 'out';
    const body = `${dir === 'in' ? 'Inbound' : 'Outbound'} call · ${evt.answered ? fmtDuration(evt.durationSec ?? 0) : '0:00'} · ${evt.answered ? 'answered' : 'no answer'}`;
    const msg = await db.message.create({ data: { conversationId: conv.id, direction: dir, kind: 'call_event', body, authorUserId: agent?.id ?? null, externalId: `yeastar:${evt.callId}` } });
    if (agent?.onCall) await db.user.update({ where: { id: agent.id }, data: { onCall: false } });
    await logEvent({ actorId: agent?.id ?? null, entityType: 'conversation', entityId: conv.id, action: 'call.recorded', after: { messageId: msg.id, answered: !!evt.answered, durationSec: evt.durationSec ?? 0 } }, db);
    return { ok: true, messageId: msg.id };
  }
  return { ok: false, reason: `Unknown event type "${evt.type}".` };
}

/** Click-to-call from the agent's extension. */
export async function dial(user, contact) {
  const c = yeastarConfig();
  if (!c.apiUrl || !c.accessToken) throw Object.assign(new Error('Click-to-call needs the Yeastar connection (YEASTAR_API_URL, YEASTAR_ACCESS_TOKEN). Dial from your phone and log the call.'), { status: 503, code: 'not_configured' });
  if (!user.extension) throw Object.assign(new Error('Your user has no Yeastar extension.'), { status: 409, code: 'no_extension' });
  const res = await fetch(`${c.apiUrl}/openapi/v1.0/call/dial?access_token=${encodeURIComponent(c.accessToken)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ caller: user.extension, callee: contact.phone.replace(/^\+/, '') }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data.errcode && data.errcode !== 0)) throw Object.assign(new Error(data.errmsg || `Yeastar responded ${res.status}`), { status: 502, code: 'pbx_error' });
  return { dialing: true, callId: data.call_id ?? null };
}
