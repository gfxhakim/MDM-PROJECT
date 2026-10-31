// Reads the client's MDM platform API (https://api.mdm.express, docs on registry.scalar.com
// @mdmexpress/mdm-api) and turns it into the records the app works on:
//   • stores  → one merchant per sellerId (phone, name, country, created date);
//   • orders  → each seller's platform figures: 8 weeks of order counts, delivery / return /
//               cancel rates over those weeks, lifetime orders and the last order date.
// Health and lifecycle stage are never read from the platform: they are derived here (AC-03).
//
// The public docs list the paths, the x-api-key header, the sellerId filter, date-range filters
// and page/perPage paging, but cut off before the field lists. Every field name the code relies on
// is therefore read through the small helpers below, tolerant of the likely shapes, so that the
// full OpenAPI file only means adjusting this one file.
const WEEK = 7 * 86_400_000;

export const PATHS = {
  stores: '/api/stores/search',
  orders: '/api/v2/orders/search',
  statuses: '/api/v2/orders/statistics/statuses',
};

const itemsOf = (b) => b?.data ?? b?.items ?? b?.results ?? b?.stores ?? b?.orders ?? [];
const totalOf = (b) => Number(b?.pagination?.total ?? b?.total ?? b?.meta?.total ?? itemsOf(b).length) || 0;
const hasMore = (b) => !!(b?.pagination?.hasMore ?? (b?.pagination?.nextPage != null && b?.pagination?.nextPage !== undefined));
const sellerIdOf = (x) => x?.sellerId ?? x?.seller?.trackingId ?? x?.seller?.id ?? x?.seller ?? null;
const dateOf = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; };

export function client({ url, apiKey, fetchImpl = fetch }) {
  const call = async (method, path, { body, query } = {}) => {
    const qs = query ? `?${query}` : '';
    const res = await fetchImpl(`${url}${path}${qs}`, {
      method,
      headers: { 'x-api-key': apiKey, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`MDM API ${method} ${path} responded ${res.status}`);
    return res.json();
  };
  return {
    call,
    /** Every page of a search endpoint. */
    async *search(path, filters = {}, perPage = 100, maxPages = 1000) {
      for (let page = 1; page <= maxPages; page++) {
        const body = await call('POST', path, { body: { ...filters, pagination: { page, perPage } } });
        for (const item of itemsOf(body)) yield item;
        if (!hasMore(body)) return;
      }
    },
    /** How many records a search matches, without reading them. */
    async count(path, filters) {
      return totalOf(await call('POST', path, { body: { ...filters, pagination: { page: 1, perPage: 1 } } }));
    },
  };
}

/** A store record → the merchant row upsertFromMdm expects. */
export function storeToRow(store) {
  const phones = Array.isArray(store.phones) ? store.phones : [store.phone].filter(Boolean);
  const country = typeof store.country === 'string' && /^[A-Za-z]{2}$/.test(store.country) ? store.country.toUpperCase()
    : store.country?.code ?? store.country?.iso2 ?? null;
  return { mdmRef: sellerIdOf(store) ?? store.trackingId, phone: phones[0] ?? null, name: store.name ?? null, country, createdAt: dateOf(store.createdAt) };
}

/** Order status counts, in whichever shape the statistics endpoint returns them, → rates in %. */
export function ratesFromStatuses(body) {
  const raw = body?.data ?? body?.statuses ?? body;
  const pairs = Array.isArray(raw)
    ? raw.map((r) => [String(r.status ?? r._id ?? r.name ?? ''), Number(r.count ?? r.total ?? r.value ?? 0)])
    : Object.entries(raw ?? {}).filter(([, v]) => typeof v === 'number').map(([k, v]) => [k, v]);
  const sum = (re) => pairs.filter(([k]) => re.test(k)).reduce((a, [, n]) => a + n, 0);
  const all = pairs.reduce((a, [, n]) => a + n, 0);
  if (!all) return {};
  const pct = (n) => Math.round((n / all) * 1000) / 10;
  return { deliveryRate: pct(sum(/deliver|livr/i)), returnRate: pct(sum(/return|retour/i)), cancelRate: pct(sum(/cancel|annul/i)) };
}

/** The platform figures for one seller, over the last 8 complete-or-current weeks. */
export async function sellerMetrics(api, sellerId, now = new Date()) {
  const by = { sellerId: [String(sellerId)] };
  const weeklyOrders = [];
  for (let w = 7; w >= 0; w--) {
    const end = new Date(now.getTime() - w * WEEK); const start = new Date(end.getTime() - WEEK);
    weeklyOrders.push(await api.count(PATHS.orders, { ...by, createdAt: { start: start.toISOString(), end: end.toISOString() } }));
  }
  const since = new Date(now.getTime() - 8 * WEEK).toISOString();
  const q = new URLSearchParams({ sellerId: String(sellerId), 'createdAt[start]': since, 'createdAt[end]': now.toISOString() });
  const rates = ratesFromStatuses(await api.call('GET', PATHS.statuses, { query: q.toString() }));
  const latest = await api.call('POST', PATHS.orders, { body: { ...by, pagination: { page: 1, perPage: 1 } } });
  const last = itemsOf(latest)[0];
  return { weeklyOrders, ...rates, totalOrders: totalOf(latest), lastOrderAt: dateOf(last?.createdAt) };
}

/** sellerIds with orders created or changed since `since` (one pass over the changed orders). */
export async function sellersWithOrderChanges(api, since, now = new Date()) {
  const ids = new Set();
  for await (const o of api.search(PATHS.orders, { updatedAt: { start: since.toISOString(), end: now.toISOString() } })) {
    const id = sellerIdOf(o); if (id) ids.add(String(id));
  }
  return ids;
}
