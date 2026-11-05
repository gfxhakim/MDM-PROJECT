// A date range from a query string (?from=…&to=…), as the filter panels send it: ISO date-times the
// browser computed from the viewer's own calendar day, so "from 1 Nov" means midnight where they are.
import { badRequest } from './errors.js';

export function dateRange(query = {}) {
  const read = (k) => {
    const v = query[k];
    if (v === undefined || v === null || v === '') return null;
    const d = new Date(String(v));
    if (Number.isNaN(d.getTime())) throw badRequest(`"${k}" is not a date.`);
    return d;
  };
  const from = read('from'); const to = read('to');
  if (from && to && from > to) throw badRequest('The start of the range is after its end.');
  return { from, to };
}
