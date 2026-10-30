// Spin up the app on a random port and talk to it like a client would.
import assert from 'node:assert/strict';

export async function startApp(createApp) {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const tokens = {};

  async function call(method, path, { token, body } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  async function login(email, password) {
    if (!tokens[email]) {
      const r = await call('POST', '/api/auth/login', { body: { email, password } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      tokens[email] = r.body.token;
    }
    return tokens[email];
  }

  return { server, base, call, login, close: () => server.close() };
}
