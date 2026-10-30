// Health score engine — AM Part 4.2 to 4.5, implemented exactly. Pure functions: the recompute
// job reads the seller record, calls computeHealth, and caches the result with its inputs.
//
//   health = round( Σ(score × weight) / Σ weight )   — denominator is the weights in use
//
// Weights are configuration; the arithmetic inside each component is not (AM 11.7).

const DAY = 86_400_000;
export const clamp = (x, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, x));
const daysSince = (d, now) => (d ? Math.max(0, Math.floor((now - new Date(d)) / DAY)) : null);
const pct = (n) => `${n > 0 ? '+' : ''}${Math.round(n)}%`;

export const BANDS = ['Critical', 'At Risk', 'Healthy', 'Thriving'];

/** AM 4.5: Critical 0–bandRisk, At Risk –bandHealthy, Healthy –bandThriving, Thriving above. */
export function bandOf(score, c) {
  if (score <= c['am.bandRisk']) return 'Critical';
  if (score <= c['am.bandHealthy']) return 'At Risk';
  if (score <= c['am.bandThriving']) return 'Healthy';
  return 'Thriving';
}

/** AM 4.4: while engagementLive is false, Engagement's weight is redistributed, not dropped. */
export function effectiveWeights(c) {
  const w = {
    activity: c['am.wActivity'], delivery: c['am.wDelivery'], engagement: c['am.wEngagement'],
    financial: c['am.wFinancial'], growth: c['am.wGrowth'],
  };
  if (!c['am.engagementLive']) {
    const e = w.engagement;
    w.engagement = 0;
    w.activity += Math.round(e / 2);
    w.delivery += e - Math.round(e / 2);
  }
  return w;
}

/** Days without an order: from the last order, or from activation if there has never been one. */
export function daysInactive(seller, now) {
  return daysSince(seller.lastOrderAt ?? seller.activatedAt, now) ?? 0;
}

export function orderWindows(seller) {
  const w = typeof seller.weeklyOrders === 'string' ? JSON.parse(seller.weeklyOrders) : seller.weeklyOrders ?? [];
  const weeks = [...Array(Math.max(0, 8 - w.length)).fill(0), ...w].slice(-8);
  const sum = (a) => a.reduce((s, x) => s + x, 0);
  return { weeks, prior: sum(weeks.slice(0, 4)), recent: sum(weeks.slice(4, 8)), thisWeek: weeks[7], lastWeek: weeks[6] };
}

/**
 * @param seller  the Seller row (mirror fields)
 * @param stage   the derived lifecycle stage (New scores 50 on Activity and Delivery)
 * @param c       configuration values
 * @returns { score, band, fallback, weights, components: [{key,label,weight,score,why,inputs,off}] }
 */
export function computeHealth(seller, stage, c, now = new Date()) {
  const W = effectiveWeights(c);
  const isNew = stage === 'New';
  const di = daysInactive(seller, now);
  const C = [];

  // Order Activity
  const { recent, prior } = orderWindows(seller);
  let a; let why;
  if (isNew) { a = 50; why = 'No order baseline yet — the first order is the gate.'; }
  else if (prior === 0 && recent === 0) { a = 5; why = 'No orders in eight weeks.'; }
  else if (prior === 0) { a = 85; why = `${recent} orders in the last four weeks, first activity on record.`; }
  else {
    a = clamp(50 + 55 * (recent - prior) / prior);
    why = `${recent} orders in the last four weeks against ${prior} before — ${pct(((recent - prior) / prior) * 100)}.`;
  }
  // AM 4.3 — the inactivity floor overrides the trend
  if (di >= c['am.churnDays'] && a > 5) { a = 5; why = `No orders for ${di} days (floor at ${c['am.churnDays']} days).`; }
  else if (di >= c['am.saveDays'] && a > 20) { a = 20; why = `No orders for ${di} days (floor at ${c['am.saveDays']} days).`; }
  else if (di >= c['am.inactiveDays'] && a > 40) { a = 40; why = `No orders for ${di} days (floor at ${c['am.inactiveDays']} days).`; }
  C.push({ key: 'activity', label: 'Order Activity', weight: W.activity, score: Math.round(a), why, inputs: { recent, prior, daysInactive: di } });

  // Delivery Performance
  const deliveryPart = clamp(seller.deliveryRate / c['am.deliveryTarget'] * 70);
  const returnsPart = clamp(100 - Math.max(0, seller.returnRate - 15) * 3.2);
  C.push({
    key: 'delivery', label: 'Delivery Performance', weight: W.delivery,
    score: isNew ? 50 : Math.round(deliveryPart * 0.65 + returnsPart * 0.35),
    why: isNew ? 'No parcels yet.' : `Delivery ${seller.deliveryRate}% against a ${c['am.deliveryTarget']}% target, returns ${seller.returnRate}%.`,
    inputs: { deliveryRate: seller.deliveryRate, returnRate: seller.returnRate, cancelRate: seller.cancelRate, deliveryTarget: c['am.deliveryTarget'] },
  });

  // Engagement (F5) — computed for display, weighted 0 while the fallback is active
  const sinceLogin = daysSince(seller.lastLoginAt, now);
  const sinceContact = daysSince(seller.lastContactAt ?? seller.activatedAt, now) ?? 0;
  const e = Math.round(clamp(100 - (sinceLogin ?? 999) * 7) * 0.6 + clamp(100 - sinceContact * 3.5) * 0.4);
  C.push({
    key: 'engagement', label: 'Engagement', weight: W.engagement, score: c['am.engagementLive'] ? e : null, off: !c['am.engagementLive'],
    why: c['am.engagementLive']
      ? `Last login ${sinceLogin === null ? 'never recorded' : sinceLogin === 0 ? 'today' : `${sinceLogin} d ago`}, last contact ${sinceContact === 0 ? 'today' : `${sinceContact} d ago`}.`
      : 'F5 Seller Activity Tracking is not live — weight redistributed to Order Activity and Delivery.',
    inputs: { daysSinceLogin: sinceLogin, daysSinceContact: sinceContact },
  });

  // Financial Health
  const f = seller.wallet >= 0
    ? Math.round(clamp(80 + Math.min(20, seller.wallet / 250)))
    : Math.round(clamp(60 - seller.walletNegativeDays * 1.6, 0, 60));
  C.push({
    key: 'financial', label: 'Financial Health', weight: W.financial, score: f,
    why: seller.wallet >= 0 ? `Wallet $${Math.round(seller.wallet)}, no payment friction.` : `Wallet −$${Math.abs(Math.round(seller.wallet))}, negative for ${seller.walletNegativeDays} days.`,
    inputs: { wallet: seller.wallet, walletNegativeDays: seller.walletNegativeDays },
  });

  // Growth Potential
  const g = clamp(30 + Math.min(seller.products, 40) * 1.1 + (seller.marketsServed - 1) * 14 + clamp(seller.momGrowthPct, -40, 60) * 0.5);
  C.push({
    key: 'growth', label: 'Growth Potential', weight: W.growth, score: Math.round(g),
    why: `${seller.products} products, ${seller.marketsServed} market${seller.marketsServed === 1 ? '' : 's'}, ${pct(seller.momGrowthPct)} month over month.`,
    inputs: { products: seller.products, marketsServed: seller.marketsServed, momGrowthPct: seller.momGrowthPct },
  });

  const used = C.filter((x) => x.weight > 0);
  const totalWeight = used.reduce((s, x) => s + x.weight, 0) || 1;
  const score = Math.round(used.reduce((s, x) => s + x.score * x.weight, 0) / totalWeight);
  return { score, band: bandOf(score, c), fallback: !c['am.engagementLive'], weights: W, components: C };
}
