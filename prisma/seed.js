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
await prisma.$disconnect();
