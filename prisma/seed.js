// Seed: the versioned configuration (v1 = every Appendix D default from both specs) and the
// team from the two prototypes. Idempotent — re-running leaves existing rows untouched.
// Later build steps add templates, macros and demo data here.
import { prisma } from '../src/db.js';
import { seedDefaults } from '../src/config/service.js';
import { hashPassword } from '../src/auth/service.js';

const config = await seedDefaults();
console.log(config.created ? `Configuration v${config.version} written from Appendix D defaults.` : `Configuration already at v${config.version}; left unchanged.`);

// Dev-only password for every seeded account. Set SEED_PASSWORD to override; never use in production.
const password = process.env.SEED_PASSWORD ?? 'mdm-dev-2026';
const USERS = [
  { email: 'admin@mdm.local', name: 'Haithem', role: 'ADMIN', markets: ['LY', 'LB', 'IQ'] },
  { email: 'manager@mdm.local', name: 'Onboarding Manager', role: 'MANAGER', markets: ['LY', 'LB', 'IQ'] },
  { email: 'shiftlead@mdm.local', name: 'Shift Lead', role: 'SHIFT_LEAD', markets: ['LY', 'LB', 'IQ'] },
  { email: 'salma@mdm.local', name: 'Salma Ben Ali', role: 'OA_AGENT', markets: ['LY'] },
  { email: 'karim@mdm.local', name: 'Karim Haddad', role: 'OA_AGENT', markets: ['LB'] },
  { email: 'noor@mdm.local', name: 'Noor Al-Saadi', role: 'OA_AGENT', markets: ['IQ'] },
  { email: 'yassine@mdm.local', name: 'Yassine Trabelsi', role: 'ACCOUNT_MANAGER', markets: ['LY'], businessNumber: '+218915000011' },
  { email: 'rania@mdm.local', name: 'Rania Kassem', role: 'ACCOUNT_MANAGER', markets: ['LB'], businessNumber: '+96171500022' },
  { email: 'omar@mdm.local', name: 'Omar Belkacem', role: 'ACCOUNT_MANAGER', markets: ['IQ'], businessNumber: '+964780500033' },
  { email: 'viewer@mdm.local', name: 'Read-only Viewer', role: 'READ_ONLY', markets: [] },
];

const passwordHash = await hashPassword(password);
let created = 0;
for (const u of USERS) {
  const exists = await prisma.user.findUnique({ where: { email: u.email } });
  if (exists) continue;
  await prisma.user.create({ data: { ...u, markets: JSON.stringify(u.markets), passwordHash } });
  created++;
}
console.log(`Users: ${created} created, ${USERS.length - created} already present.${created ? ` Dev password: ${password}` : ''}`);
// Launch templates (OA 7.5, AM 7.6) — wording from the prototypes. All utility category.
// Seeded as approved for development; the WhatsApp connector (step 9) syncs real Meta status.
const TEMPLATES = [
  ['oa_intro_v2', 'oa', 'Salam {{1}}, this is {{2}} from MDM Express. You registered with us — I tried to reach you by phone. When is a good time for a two-minute call?'],
  ['oa_slot_proposal_v3', 'oa', '{{1}}, I can walk you through MDM with your own numbers on the pricing calculator. I have {{2}} or {{3}} — which works better?'],
  ['oa_hub_share_v1', 'oa', '{{1}}, everything we would have covered on the call is here: {{2}} — the recorded walkthrough, pricing for {{3}}, and how COD payouts work.'],
  ['oa_nudge_v2', 'oa', '{{1}}, what is holding you back — pricing, trust, or timing? Answer with one word and I will clear it up in a line.'],
  ['oa_winback_d30', 'oa', '{{1}}, we have added {{2}} since we last spoke. If you want to start, I can activate your account today. Reply anytime to reopen.', false],
  ['am_welcome_v1', 'am', 'Salam {{1}}, I am {{2}}, your account manager at MDM Express. I will call you within 24 hours to set your store up properly. Is now a good time, or later today?'],
  ['am_inactive_v2', 'am', '{{1}}, I noticed no orders on your store for {{2}} days. Is something blocking you — stock, pricing, or the store itself? Tell me and I will fix it today.'],
  ['am_returns_v1', 'am', '{{1}}, your return rate is running at {{2}}%. Most of it comes down to product photos and confirmation calls. Can I take 20 minutes with you this week to bring it down?'],
  ['am_qbr_invite_v1', 'am', '{{1}}, it is time for our quarterly review. I have your numbers for the last 90 days and two ideas to grow {{2}}. When suits you this week?'],
  ['am_save_v1', 'am', '{{1}}, we have not shipped for you in {{2}} days and I would rather fix that than lose you. Tell me what went wrong and I will make it right — I can also put you on our reduced rate for a month.'],
  ['am_expansion_v1', 'am', '{{1}}, your products would sell in {{2}}. We already deliver there. I can set you up with a test batch of 10–20 orders at no extra setup cost. Interested?'],
];
let tplCreated = 0;
for (const [key, module, bodyEn, enabled = true] of TEMPLATES) {
  if (await prisma.template.findUnique({ where: { key } })) continue;
  // oa_winback_d30 ships disabled with rule r9 (OA 5.5, decision 10).
  await prisma.template.create({ data: { key, module, category: 'utility', bodyEn, status: 'approved', enabled } });
  tplCreated++;
}
console.log(`Templates: ${tplCreated} created, ${TEMPLATES.length - tplCreated} already present.`);

// The six onboarding team macros (OA 6.5). Internal: they apply changes and insert text; never send.
const MACROS = [
  ['Log call — no answer', { op: 'log_call', outcome: 'no_answer' }, 'Called, no answer.'],
  ['Log call — answered, strong lead', { op: 'log_call', outcome: 'answered_strong' }, 'Answered — strong lead. Walkthrough next.'],
  ['Log call — answered, soft lead', { op: 'log_call', outcome: 'answered_soft' }, 'Answered — interested, not committed yet.'],
  ['Book the walkthrough', { op: 'book_walkthrough' }, 'Your walkthrough is booked. Here is the Resource Hub so you can arrive with questions.'],
  ['Send Hub instead of a call', { op: 'send_hub' }, ''],
  ['Mark junk — not a real seller', { op: 'mark_junk' }, 'Not a real seller.'],
];
let macroCreated = 0;
for (const [name, actions, insertText] of MACROS) {
  if (await prisma.macro.findFirst({ where: { module: 'oa', scope: 'team', name } })) continue;
  await prisma.macro.create({ data: { module: 'oa', scope: 'team', name, actions: JSON.stringify(actions), insertText } });
  macroCreated++;
}
console.log(`Macros: ${macroCreated} created, ${MACROS.length - macroCreated} already present.`);

await prisma.$disconnect();
