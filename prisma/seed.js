// Seed: the versioned configuration (v1 = every Appendix D default from both specs).
// Idempotent — re-running leaves an existing configuration history untouched.
// Later build steps add users, templates and demo data here.
import { prisma } from '../src/db.js';
import { seedDefaults } from '../src/config/service.js';

const config = await seedDefaults();
console.log(config.created ? `Configuration v${config.version} written from Appendix D defaults.` : `Configuration already at v${config.version}; left unchanged.`);
await prisma.$disconnect();
