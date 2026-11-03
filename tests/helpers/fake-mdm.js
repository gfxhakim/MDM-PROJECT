// A stand-in for the MDM platform API (shapes from its OpenAPI spec), for the connector tests.
// sellers: platform seller records; orders: { sellerId: count }; managers: platform AMs;
// reporting: { sellerId: [row per market] } overrides MDM's reporting rows (default: 80 delivered,
// 15 returned, 5 cancelled out of 100 orders in one market, for every seller that has orders).
// users: platform users (GetUserResponse shape); passwords: { username: password } accepted by
// the login endpoint (the profile returned is the matching user's).
// stores: platform stores (Store, `seller.trackingId` names the owner); teamMembers: { sellerId: TeamMember[] };
// fees: { sellerId: GetSellerServiceFeesResponse } (default: a small one for every seller).
export function fakeMdm({ sellers = [], orders = {}, managers = [], wallets = {}, reporting = {}, users = [], passwords = {}, fail = null, stores = [], teamMembers = {}, fees = {} } = {}) {
  const calls = [];
  const page = (list, body) => {
    const { page: p = 1, perPage = 100 } = body?.pagination ?? {};
    const slice = list.slice((p - 1) * perPage, p * perPage);
    return { list: slice, pagination: { page: p, perPage, total: list.length, hasMore: p * perPage < list.length } };
  };
  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ method: opts.method, path: u.pathname, query: u.search, key: opts.headers['x-api-key'], body, headers: opts.headers });
    const reply = (status, json) => ({ ok: status < 300, status, json: async () => json });
    const forced = fail?.(opts.method, u.pathname, body);
    if (forced) return reply(forced, { error: { code: 'x', message: `forced ${forced}` } });
    if (u.pathname === '/api/sellers/search') {
      const sorted = [...sellers].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
      return reply(200, page(sorted, body));
    }
    let m;
    if ((m = /^\/api\/sellers\/([^/]+)\/team-members\/search$/.exec(u.pathname))) return reply(200, page(teamMembers[decodeURIComponent(m[1])] ?? [], body));
    if ((m = /^\/api\/sellers\/([^/]+)\/service-fees$/.exec(u.pathname))) {
      const id = decodeURIComponent(m[1]);
      return reply(200, fees[id] ?? { currency: 'LYD', plan: { plan: { trackingId: 'p1', name: 'Starter', minPoints: 0, maxPoints: 100 }, totalPoints: 10 }, callCenter: { type: 'standard', lead: 1, confirmed: 2, delivered: 3, currency: 'LYD' }, fulfillment: {}, shipping: {}, sourcing: [], exchange: { usd: 4.8, euro: 5.2 } });
    }
    if (u.pathname === '/api/stores/search') {
      const sorted = [...stores].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
      return reply(200, page(sorted, body));
    }
    if (u.pathname.startsWith('/api/sellers/') && opts.method === 'GET') {
      return reply(200, sellers.find((s) => s.trackingId === decodeURIComponent(u.pathname.split('/')[3])) ?? {});
    }
    if (u.pathname === '/api/v2/orders/search') {
      const f = body.filters ?? {};
      if (f.updatedAt) {
        const list = Object.entries(orders).filter(([, n]) => n).map(([id]) => ({ trackingId: `o-${id}`, seller: { trackingId: id }, createdAt: '2026-10-29T10:00:00Z' }));
        return reply(200, page(list, body));
      }
      const id = f.sellerId?.[0]; const n = orders[id] ?? 0;
      const total = f.createdAt ? (n ? 1 : 0) : n; // one order in each weekly window
      return reply(200, { list: total ? [{ trackingId: 'o1', seller: { trackingId: id }, createdAt: '2026-10-29T10:00:00Z' }] : [], pagination: { page: 1, perPage: 1, total, hasMore: false } });
    }
    if (u.pathname === '/api/analytics/orders/sellers-status/search') {
      // MDM's reporting row per seller and market (GetOrdersSellersStatusAnalyticsResponseItem)
      const ids = body.filters?.sellerId ?? Object.keys(orders);
      const rows = ids.flatMap((id) => (reporting[id] ?? (orders[id] ? [{ delivered: 80, returned: 15, cancelled: 5, totalLeads: 100, totalParcels: 95 }] : []))
        .map((r) => ({ seller: { trackingId: id, firstName: id, lastName: '', pictureId: '' }, countryId: 'c-ly', pending: 0, callLater: 0, notAnswer: 0, confirmed: 0, outOfStock: 0,
          cancelledAfterOutOfStock: 0, cancelledWithoutOutOfStock: r.cancelled ?? 0, preparing: 0, received: 0, packaged: 0, lost: 0, refunded: 0, dispatched: 0, totalParcelsWithoutLead: 0, ...r })));
      return reply(200, page(rows, body));
    }
    if (u.pathname === '/api/v2/orders/statistics/statuses') {
      return reply(500, { error: { code: 'x', message: 'syntax error at or near "$1"' } }); // as the live platform answers
    }
    if (u.pathname === '/api/finance/seller-payments/wallets/search') {
      const id = body.filters.sellerId?.[0];
      return reply(200, page(id in wallets ? [{ seller: { trackingId: id }, ready: wallets[id], notReady: 0, paid: 0 }] : [], body));
    }
    if (u.pathname === '/api/omni-channel/account-managers/search') return reply(200, page(managers, body));
    if (u.pathname === '/api/users/search') return reply(200, page(users, body));
    if (u.pathname === '/api/auth/login/user') {
      const { username, password } = body ?? {};
      if (opts.headers['x-api-key']) return reply(400, { error: { code: 'x', message: 'login is a user call, not an API-key call' } });
      const user = users.find((x) => (x.usernames ?? []).includes(username) || x.email === username);
      if (!user || !password || passwords[username] !== password) return reply(401, { error: { code: 'unauthorized', message: 'Invalid credentials' } });
      return reply(201, { accessToken: `tok-${user.trackingId}`, tokenType: 'Bearer', expiresAt: '2030-01-01T00:00:00Z', refreshToken: 'r' });
    }
    if (u.pathname === '/api/auth/me') {
      const m = /^Bearer tok-(.+)$/.exec(opts.headers.authorization ?? '');
      const user = m && users.find((x) => x.trackingId === m[1]);
      return user ? reply(200, user) : reply(401, { error: { code: 'unauthorized', message: 'no session' } });
    }
    if (u.pathname.startsWith('/api/omni-channel/account-managers/sellers/')) return reply(200, { sellerId: u.pathname.split('/').pop(), accountManagerId: body.accountManagerId });
    if (/^\/api\/sellers\/[^/]+\/join\//.test(u.pathname)) return reply(200, { trackingId: u.pathname.split('/')[3] });
    return reply(404, { error: { code: 'not_found', message: 'no route' } });
  };
  return { fetchImpl, calls };
}

// Country codes as the live platform writes them: ISO alpha-3 (LBY, IRQ, LBN, DZA …).
export const mdmSeller = (id, phone, extra = {}) => ({
  trackingId: id, firstName: extra.firstName ?? id, lastName: '', phones: [phone],
  country: { id: 'c-ly', name: 'Libya', code: 'LBY' }, countries: [{ id: 'c-ly', name: 'Libya', code: 'LBY' }],
  joinStatus: 'pending', joinStatusDate: '2026-10-30T00:00:00Z',
  createdAt: '2026-10-30T00:00:00Z', updatedAt: '2026-10-30T00:00:00Z', utm: { utmSource: 'fb_ads' }, accountManager: null, ...extra,
});

// A platform user as GET /api/users/search lists them (GetUserResponse).
export const mdmUser = (id, email, extra = {}) => ({
  trackingId: id, usernames: [email, ...(extra.usernames ?? [])], role: 'commercial-agent', scope: 'commercial', permissions: [],
  firstName: extra.firstName ?? id, lastName: extra.lastName ?? '', email, phones: extra.phones ?? [], pictureId: null, restricted: false, custom: false,
  shouldChangePassword: false, shouldReLogin: false, lastLogin: '2026-10-30T08:00:00Z', lastLogout: null, countries: ['c-ly'],
  createdAt: '2025-01-01T00:00:00Z', updatedAt: '2026-10-30T00:00:00Z', ...extra,
});
