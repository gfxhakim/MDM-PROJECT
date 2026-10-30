// Demo data for a dev database (never production): merchants registering through the real
// onboarding engine, a few replies, and activated sellers with platform metrics so both consoles
// have something to show. Everything goes through the services, so rules, assignment and audit
// behave exactly as they will with live data. Run after db:seed: `npm run db:demo`.
import { prisma } from '../src/db.js';
import { getLiveConfig } from '../src/config/service.js';
import { registerOnboarding } from '../src/oa/index.js';
import { registerAccountManagement } from '../src/am/index.js';
import { registerMerchant } from '../src/oa/service.js';
import { receiveInbound } from '../src/core/contacts.js';
import { handover } from '../src/am/handover.js';
import { recomputeAll } from '../src/am/recompute.js';
import { runAmSweep } from '../src/am/rules.js';

if (process.env.NODE_ENV === 'production') throw new Error('Demo data is for development databases only.');
if (await prisma.contact.count()) { console.log('Contacts already exist; demo data not added.'); process.exit(0); }

registerOnboarding();
registerAccountManagement();

const LEADS = [
  ['+218912345601', 'Ahmed Al-Mansouri', 'LY', 'fb_ads_tripoli', 'Hi, I registered — how do I start selling?'],
  ['+218912345602', 'Fatima Zayed', 'LY', 'instagram', null],
  ['+218912345603', 'Mohamed Ben Khalifa', 'LY', 'referral', 'مرحبا، أريد معرفة الأسعار'],
  ['+218912345604', 'Huda Al-Fitouri', 'LY', 'google', null],
  ['+96171234505', 'Rami Khoury', 'LB', 'fb_ads_beirut', 'Do you deliver to Tripoli LB?'],
  ['+96171234506', 'Nour Haddad', 'LB', 'tiktok', null],
  ['+96171234507', 'Joelle Saab', 'LB', 'instagram', null],
  ['+9647712345608', 'Ali Al-Jubouri', 'IQ', 'fb_ads_baghdad', 'السلام عليكم، سجلت اليوم'],
  ['+9647712345609', 'Zainab Kareem', 'IQ', 'referral', null],
  ['+9647712345610', 'Hussein Abbas', 'IQ', 'google', null],
];

// Register during the most recent working morning (Sun–Thu, Tripoli time) so the engine assigns
// them as it would have live; outside business hours they would be held, correctly.
const at = new Date();
at.setUTCHours(7, 0, 0, 0);
while (at > new Date() || [5, 6].includes(at.getUTCDay())) at.setUTCDate(at.getUTCDate() - 1);
let i = 0;
for (const [phone, name, country, sourceUtm, reply] of LEADS) {
  const now = new Date(at.getTime() + i++ * 9 * 60000);
  const r = await registerMerchant({ phone, name, country, sourceUtm }, { now });
  if (reply) await receiveInbound({ phone, body: reply, at: new Date(now.getTime() + 20 * 60000) });
  console.log(`${name}: ${r.outcome}`);
}

// Activated sellers with an order history (weeks 1..8, oldest first). Rates are percentages.
const { values: config } = await getLiveConfig();
const DAY = 86400000;
const SELLERS = [
  ['+218913000001', 'Sara Boutique', 'LY', [30, 34, 38, 41, 44, 47, 52, 55], 42, 9, 2, 400, 90],
  ['+218913000002', 'Tripoli Electronics', 'LY', [60, 55, 48, 40, 31, 22, 14, 9], 31, 22, 4, 120, 140],
  ['+218913000003', 'Benghazi Home', 'LY', [5, 4, 3, 2, 1, 0, 0, 0], 18, 44, 18, -40, 200],
  ['+96171300004', 'Cedar Cosmetics', 'LB', [12, 14, 15, 15, 16, 18, 19, 21], 39, 11, 1, 260, 60],
  ['+96171300005', 'Beirut Kids', 'LB', [0, 0, 0, 0, 0, 1, 2, 3], 36, 14, 3, 30, 12],
  ['+9647713000006', 'Baghdad Fashion', 'IQ', [80, 82, 79, 85, 88, 90, 92, 95], 47, 7, 1, 900, 300],
  ['+9647713000007', 'Erbil Sports', 'IQ', [20, 18, 15, 10, 6, 3, 1, 0], 27, 31, 25, 10, 160],
];
let n = 0;
for (const [phone, name, market, weekly, deliveryRate, returnRate, lastOrderDaysAgo, wallet, ageDays] of SELLERS) {
  const contact = await prisma.contact.create({ data: { phone, name, country: market, contactType: 'seller', sourceUtm: 'demo' } });
  await prisma.conversation.create({ data: { contactId: contact.id } });
  const seller = await prisma.seller.create({
    data: {
      mdmRef: `MDM-S-${String(9000 + ++n).padStart(4, '0')}`, contactId: contact.id, market, joinStatus: 'accepted',
      activatedAt: new Date(Date.now() - ageDays * DAY), welcomeCallAt: ageDays > 14 ? new Date(Date.now() - (ageDays - 1) * DAY) : null, weeklyOrders: JSON.stringify(weekly), deliveryRate, returnRate,
      weeklyReturnRates: JSON.stringify(weekly.map(() => returnRate)), cancelRate: Math.max(5, 100 - deliveryRate - returnRate - 20), wallet, walletNegativeDays: wallet < 0 ? 9 : 0,
      products: 10 + n * 3, totalOrders: weekly.reduce((a, b) => a + b, 0) + 40, lastOrderAt: new Date(Date.now() - lastOrderDaysAgo * DAY),
    },
  });
  const h = await handover(seller.id, { config });
  console.log(`${name}: ${h.assigned ? 'assigned' : h.reason}`);
}
await recomputeAll({ config });
const sweep = await runAmSweep({ config });
console.log('AM sweep:', JSON.stringify(sweep).slice(0, 200));
await prisma.$disconnect();
