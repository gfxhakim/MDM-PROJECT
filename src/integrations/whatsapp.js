// WhatsApp Business (Cloud API) — inbound webhook and outbound transport.
//
// Inbound: Meta calls GET /api/integrations/whatsapp/webhook to verify (hub.challenge) and POSTs
// messages and delivery statuses. Each POST is checked against X-Hub-Signature-256 (HMAC-SHA256 of
// the raw body with the app secret). Messages go through receiveInbound — the same path as every
// other inbound — so capture (r1), reset-on-reply (r7) and the 24-hour window all follow.
//
// Outbound: every message the platform sends (agent reply, template, rule send) is emitted as
// message.sent; this module delivers it. The 24-hour window and the template budget are already
// enforced before a message is written, so the transport never decides policy. Without
// credentials the platform still works: messages are kept with deliveryStatus "not_sent" and the
// integration status says so.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { prisma } from '../db.js';
import { on } from '../core/events.js';
import { receiveInbound } from '../core/contacts.js';
import { logEvent } from '../services/audit.js';
import { countryFromPhone } from './phone.js';

export const whatsappConfig = () => ({
  token: process.env.WHATSAPP_TOKEN || null,
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || null,
  appSecret: process.env.WHATSAPP_APP_SECRET || null,
  verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || null,
  apiVersion: process.env.WHATSAPP_API_VERSION || 'v21.0',
  templateLanguage: process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'ar',
});

export function whatsappStatus() {
  const c = whatsappConfig();
  return {
    outbound: !!(c.token && c.phoneNumberId), inbound: !!(c.appSecret && c.verifyToken),
    detail: c.token && c.phoneNumberId ? 'Sending through the WhatsApp Cloud API.' : 'Not connected — messages are recorded but not delivered. Set WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID.',
  };
}

export function verifySignature(rawBody, header, secret = whatsappConfig().appSecret) {
  if (!secret || !header || !rawBody) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected); const b = Buffer.from(String(header));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Flatten a Cloud API webhook payload into inbound messages and status updates. */
export function parseWebhook(payload) {
  const messages = []; const statuses = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {};
      const names = new Map((v.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]));
      for (const m of v.messages ?? []) {
        const text = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title
          ?? (m.type ? `[${m.type}]` : null);
        messages.push({ id: m.id, from: `+${m.from}`, name: names.get(m.from) ?? null, body: text, at: m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date() });
      }
      for (const s of v.statuses ?? []) statuses.push({ id: s.id, status: s.status, at: s.timestamp ? new Date(Number(s.timestamp) * 1000) : new Date(), error: s.errors?.[0]?.title ?? null });
    }
  }
  return { messages, statuses };
}

export async function handleWebhook(payload, db = prisma) {
  const { messages, statuses } = parseWebhook(payload);
  const out = { received: 0, duplicates: 0, skipped: [], statuses: 0 };
  for (const m of messages) {
    if (!m.body) { out.skipped.push({ id: m.id, reason: 'empty message' }); continue; }
    const country = countryFromPhone(m.from);
    try {
      const r = await receiveInbound({ phone: m.from, body: m.body, name: m.name, country, at: m.at, externalId: m.id }, db);
      if (r.duplicate) out.duplicates++; else out.received++;
    } catch (err) {
      // A number outside the three markets with no existing contact cannot be routed; it is recorded, not dropped silently.
      out.skipped.push({ id: m.id, reason: err.message });
      await logEvent({ entityType: 'system', entityId: 'whatsapp', action: 'whatsapp.inbound_rejected', after: { from: m.from }, reason: err.message }, db);
    }
  }
  for (const s of statuses) {
    const r = await db.message.updateMany({ where: { externalId: s.id }, data: { deliveryStatus: s.status } });
    out.statuses += r.count;
  }
  return out;
}

async function graph(path, body) {
  const c = whatsappConfig();
  const res = await fetch(`https://graph.facebook.com/${c.apiVersion}/${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `WhatsApp API ${res.status}`);
  return data;
}

/** Deliver one outbound message. Returns the provider id, or null when no transport is configured. */
export async function deliver({ conversation, message, template, variables }, db = prisma) {
  const c = whatsappConfig();
  if (!c.token || !c.phoneNumberId) {
    await db.message.update({ where: { id: message.id }, data: { deliveryStatus: 'not_sent' } });
    return null;
  }
  const contact = conversation.contact ?? (await db.contact.findUnique({ where: { id: conversation.contactId } }));
  const to = contact.phone.replace(/^\+/, '');
  const body = message.kind === 'template'
    ? { messaging_product: 'whatsapp', to, type: 'template', template: { name: message.templateKey, language: { code: template?.bodyAr ? c.templateLanguage : 'en' },
        components: variables?.length ? [{ type: 'body', parameters: variables.map((v) => ({ type: 'text', text: String(v) })) }] : [] } }
    : { messaging_product: 'whatsapp', to, type: 'text', text: { body: message.body } };
  try {
    const r = await graph(`${c.phoneNumberId}/messages`, body);
    const id = r.messages?.[0]?.id ?? null;
    await db.message.update({ where: { id: message.id }, data: { externalId: id, deliveryStatus: 'sent' } });
    return id;
  } catch (err) {
    await db.message.update({ where: { id: message.id }, data: { deliveryStatus: 'failed' } });
    await logEvent({ entityType: 'conversation', entityId: conversation.id, action: 'whatsapp.send_failed', after: { messageId: message.id }, reason: err.message }, db);
    return null;
  }
}

export function registerWhatsapp() {
  on('message.sent', 'whatsapp.deliver', (p) => (['text', 'template'].includes(p.message.kind) ? deliver(p) : null));
}
