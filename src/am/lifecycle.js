// Lifecycle stage (AM 2.4) — derived on read from account age, order history and open work.
// Never a column anyone can set: the cached Seller.stage is written only by the recompute job.
//
// The spec gives each stage's entry condition and typical age; this derivation applies them in
// order of precedence:
//   not accepted                       → Pending Activation
//   churnedAt set (by hand until D-04) → Churned
//   no welcome call logged             → New
//   welcome logged, no order yet       → Onboarding
//   an intervention or save is open    → Recovering
//   first order placed: account age  <14 d Activated · <90 d Active · <180 d Growth · else Mature
export const STAGES = ['Pending Activation', 'New', 'Onboarding', 'Activated', 'Active', 'Growth', 'Mature', 'Recovering', 'Churned'];

const DAY = 86_400_000;

export function deriveStage(seller, openTasks = [], now = new Date()) {
  if (seller.joinStatus !== 'accepted') return 'Pending Activation';
  if (seller.churnedAt) return 'Churned';
  if (!seller.welcomeCallAt) return 'New';
  const hasOrdered = (seller.totalOrders ?? 0) > 0 || !!seller.lastOrderAt;
  if (!hasOrdered) return 'Onboarding';
  if (openTasks.some((t) => t.taskType === 'intervention' || t.taskType === 'save')) return 'Recovering';
  const age = (now - new Date(seller.activatedAt ?? now)) / DAY;
  if (age < 14) return 'Activated';
  if (age < 90) return 'Active';
  if (age < 180) return 'Growth';
  return 'Mature';
}

/** Stage baseline minutes per week (AM 8.2); Recovering uses bAtRisk. */
export function stageBaseline(stage, c) {
  return {
    New: c['am.bNew'], Onboarding: c['am.bOnboarding'], Activated: c['am.bActivated'], Active: c['am.bActive'],
    Growth: c['am.bGrowth'], Mature: c['am.bMature'], Recovering: c['am.bAtRisk'], Churned: c['am.bChurned'],
  }[stage] ?? 0;
}
