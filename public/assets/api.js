// Session + API client shared by the login page and both consoles.
(function () {
  const KEY = 'mdm.session';
  const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } };
  const write = (v) => { try { v ? localStorage.setItem(KEY, JSON.stringify(v)) : localStorage.removeItem(KEY); } catch { /* private mode */ } };

  class ApiError extends Error {
    constructor(status, body) {
      super(body?.error?.message || `Request failed (${status})`);
      this.status = status; this.code = body?.error?.code; this.details = body?.error?.details;
    }
  }

  async function request(method, path, body) {
    const s = read();
    const res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json', ...(s?.token ? { authorization: `Bearer ${s.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !path.startsWith('/api/auth/login')) { API.logout(); throw new ApiError(401, data); }
    if (!res.ok) throw new ApiError(res.status, data);
    return data;
  }

  const ADMIN_VIEW_ROLES = ['ADMIN', 'MANAGER', 'SHIFT_LEAD', 'READ_ONLY'];

  window.API = {
    ApiError,
    get: (p) => request('GET', p),
    post: (p, b) => request('POST', p, b ?? {}),
    patch: (p, b) => request('PATCH', p, b ?? {}),
    del: (p, b) => request('DELETE', p, b),
    session: read,
    async login(email, password) {
      const r = await request('POST', '/api/auth/login', { email, password });
      write({ token: r.token, user: r.user });
      return r.user;
    },
    logout() { write(null); if (location.pathname !== '/') location.href = '/'; },
    /** Ensure a session; returns { user, grants } or redirects to the login page. */
    async me() {
      if (!read()?.token) { location.href = '/'; return new Promise(() => {}); }
      return request('GET', '/api/auth/me');
    },
    homeFor(role) { return role === 'ACCOUNT_MANAGER' ? '/am' : '/oa'; },
    canSeeAdmin: (role) => ADMIN_VIEW_ROLES.includes(role),
  };
})();
