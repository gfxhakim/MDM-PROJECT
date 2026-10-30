// Validation for configuration values.
//   validateValue — one key, type + bounds. Used when a value enters the draft.
//   validateConfig — a whole snapshot, including the cross-field gates. Used by simulate and publish.
import { PARAMETER_MAP, AM_HEALTH_WEIGHT_KEYS } from './parameters.js';

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function validateValue(key, value) {
  const def = PARAMETER_MAP[key];
  if (!def) return `Unknown configuration parameter "${key}".`;
  switch (def.type) {
    case 'bool':
      if (typeof value !== 'boolean') return `${key} must be true or false.`;
      return null;
    case 'enum':
      if (!def.values.includes(value)) return `${key} must be one of: ${def.values.join(', ')}.`;
      return null;
    case 'time':
      if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return `${key} must be a time like 08:30.`;
      return null;
    case 'weekdays': {
      const days = typeof value === 'string' ? value.split(',') : [];
      const ok = days.length > 0 && days.every((d) => WEEKDAYS.includes(d)) && new Set(days).size === days.length;
      return ok ? null : `${key} must be a comma-separated list of: ${WEEKDAYS.join(', ')}.`;
    }
    case 'int':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${key} must be a number.`;
      if (def.type === 'int' && !Number.isInteger(value)) return `${key} must be a whole number.`;
      if (def.min != null && value < def.min) return `${key} must be at least ${def.min}.`;
      if (def.max != null && value > def.max) return `${key} must be at most ${def.max}.`;
      return null;
    }
    default:
      return `${key} has an unsupported type.`;
  }
}

/**
 * Validate a full configuration snapshot. Returns a list of { key|keys, code, message }.
 * An empty list means it may be published.
 */
export function validateConfig(values) {
  const errors = [];
  for (const key of Object.keys(PARAMETER_MAP)) {
    if (!(key in values)) { errors.push({ key, code: 'missing', message: `${key} has no value.` }); continue; }
    const msg = validateValue(key, values[key]);
    if (msg) errors.push({ key, code: 'invalid', message: msg });
  }
  for (const key of Object.keys(values)) {
    if (!PARAMETER_MAP[key]) errors.push({ key, code: 'unknown', message: `Unknown configuration parameter "${key}".` });
  }
  if (errors.length) return errors;

  // AM 11.4 / AC-22: refused, not warned — and the refusal names the total.
  const total = AM_HEALTH_WEIGHT_KEYS.reduce((s, k) => s + values[k], 0);
  if (total !== 100) {
    errors.push({ keys: AM_HEALTH_WEIGHT_KEYS, code: 'health_weights_total', total,
      message: `Health weights total ${total}, not 100. Publishing is refused until the five weights total exactly 100.` });
  }

  const ascending = (keys, what) => {
    for (let i = 1; i < keys.length; i++) {
      if (!(values[keys[i - 1]] < values[keys[i]])) {
        errors.push({ keys, code: 'order', message: `${what} must be strictly ascending: ${keys.map((k) => `${k}=${values[k]}`).join(' < ')}.` });
        return;
      }
    }
  };
  ascending(['am.bandRisk', 'am.bandHealthy', 'am.bandThriving'], 'Health band ceilings');
  ascending(['am.inactiveDays', 'am.saveDays', 'am.churnDays'], 'Inactivity floor steps');

  if (values['oa.reserved_minutes'] >= values['oa.shift_minutes']) {
    errors.push({ keys: ['oa.reserved_minutes', 'oa.shift_minutes'], code: 'capacity',
      message: `Reserved blocks (${values['oa.reserved_minutes']} min) leave no assignable time in a ${values['oa.shift_minutes']}-minute shift.` });
  }
  if (values['oa.business_open'] >= values['oa.business_close']) {
    errors.push({ keys: ['oa.business_open', 'oa.business_close'], code: 'business_hours',
      message: `The shift must open (${values['oa.business_open']}) before it closes (${values['oa.business_close']}).` });
  }
  return errors;
}
