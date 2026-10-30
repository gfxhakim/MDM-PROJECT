// The first-thirty-days playbook (AM 6.1). Step definitions and gates are code (AM 11.7); gates
// are read LIVE from the seller record every time, never stored as truth. A step whose gate is
// false cannot be ticked (AC-14), for any role.
export const STEPS = [
  { day: 0, title: 'Assignment and welcome message', gate: 'none', taskType: null },
  { day: 1, title: 'Welcome call', gate: 'Call logged', taskType: null }, // the r1 welcome task
  { day: 3, title: 'Store setup complete', gate: '≥ 3 products', taskType: 'checkin' },
  { day: 5, title: 'First order coaching', gate: '≥ 1 order', taskType: 'coach' },
  { day: 7, title: 'Day-7 check-in', gate: 'First order placed', taskType: 'checkin' },
  { day: 14, title: 'Performance review', gate: '≥ 5 orders', taskType: 'coach' },
  { day: 21, title: 'Growth conversation', gate: '≥ 5 products', taskType: 'coach' },
  { day: 30, title: 'Month-one review', gate: 'Health > 60', taskType: 'checkin' },
];

const orders = (s) => s.totalOrders ?? 0;

/** Evaluate a step's gate against the seller as it is right now. */
export function gateOpen(step, seller) {
  switch (step.day) {
    case 0: return true;
    case 1: return !!seller.welcomeCallAt;
    case 3: return seller.products >= 3;
    case 5: return orders(seller) >= 1;
    case 7: return orders(seller) >= 1 || !!seller.lastOrderAt;
    case 14: return orders(seller) >= 5;
    case 21: return seller.products >= 5;
    case 30: return (seller.healthScore ?? 0) > 60;
    default: return false;
  }
}

export const stepFor = (day) => STEPS.find((s) => s.day === Number(day));
