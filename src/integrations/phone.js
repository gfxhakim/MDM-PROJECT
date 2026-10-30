// Market from a phone number's country code — the three MDM markets.
const PREFIX = [['+218', 'LY'], ['+961', 'LB'], ['+964', 'IQ']];

export function countryFromPhone(e164) {
  const p = String(e164 || '').replace(/[^\d+]/g, '');
  const n = p.startsWith('+') ? p : `+${p}`;
  return PREFIX.find(([pre]) => n.startsWith(pre))?.[1] ?? null;
}
