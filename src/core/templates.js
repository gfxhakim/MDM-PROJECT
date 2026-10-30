// WhatsApp templates: rendering, eligibility and the onboarding template budget.
// A template costs money and needs Meta approval; a macro is free and internal (OA 6.6).
import { prisma } from '../db.js';
import { getLiveConfig } from '../config/service.js';
import { badRequest, HttpError, notFound } from '../http/errors.js';

/** Fill {{1}}, {{2}} … from the variables array. Every placeholder must be filled. */
export function renderTemplate(body, variables = []) {
  const missing = [];
  const text = body.replace(/\{\{(\d+)\}\}/g, (_m, n) => {
    const v = variables[Number(n) - 1];
    if (v === undefined || v === null || String(v).trim() === '') { missing.push(Number(n)); return `{{${n}}}`; }
    return String(v);
  });
  if (missing.length) throw badRequest(`Template variable${missing.length > 1 ? 's' : ''} ${missing.map((n) => `{{${n}}}`).join(', ')} not filled.`);
  return text;
}

/** The module a contact's messages belong to: merchants are onboarding, sellers are account management. */
export const moduleForContact = (contact) => (contact.contactType === 'merchant' ? 'oa' : 'am');

/** Load a template and check it may be sent to this contact. Fails loudly, never silently. */
export async function usableTemplate(key, contact, config, db = prisma) {
  const t = await db.template.findUnique({ where: { key } });
  if (!t) throw notFound(`Template "${key}" does not exist.`);
  if (t.status !== 'approved') throw new HttpError(422, 'template_not_approved', `Template "${key}" is ${t.status}, not approved by Meta.`);
  if (!t.enabled) throw new HttpError(422, 'template_disabled', `Template "${key}" is disabled.`);
  const mod = moduleForContact(contact);
  if (t.module !== mod) throw new HttpError(422, 'template_wrong_module', `Template "${key}" belongs to the ${t.module.toUpperCase()} module, not this ${mod === 'oa' ? 'merchant' : 'seller'}.`);
  if (mod === 'oa' && t.category === 'marketing' && config['oa.marketing_templates'] === 'prohibited') {
    throw new HttpError(422, 'template_marketing_prohibited', 'Marketing templates are prohibited on the onboarding number.');
  }
  return t;
}

const monthStart = (now) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/**
 * Onboarding template budget: monthly ceiling across the team, and the per-contact hard stop
 * (OA Appendix D). Returns { used, ceiling, contactUsed, contactCap, remaining, allowed, reason }.
 */
export async function onboardingBudget(conversationId, { now = new Date(), config } = {}, db = prisma) {
  const values = config ?? (await getLiveConfig(db)).values;
  const oaKeys = (await db.template.findMany({ where: { module: 'oa' }, select: { key: true } })).map((t) => t.key);
  const base = { kind: 'template', direction: 'out', templateKey: { in: oaKeys } };
  const [used, contactUsed] = await Promise.all([
    db.message.count({ where: { ...base, createdAt: { gte: monthStart(now) } } }),
    db.message.count({ where: { ...base, conversationId } }),
  ]);
  const ceiling = values['oa.template_budget_month'];
  const contactCap = values['oa.template_per_contact_cap'];
  let reason = null;
  if (contactUsed >= contactCap) reason = `Template ceiling for this contact reached (${contactUsed} of ${contactCap}).`;
  else if (used >= ceiling) reason = `Monthly onboarding template budget spent (${used} of ${ceiling}).`;
  return { used, ceiling, contactUsed, contactCap, remaining: Math.max(0, Math.min(ceiling - used, contactCap - contactUsed)), allowed: !reason, reason };
}
