// Sign-in, two-factor, sessions, the access token and backups, each against a fresh server.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { openDatabase } = require('../server/db');
const { buildApp } = require('../server/dist/app');
const { base32Decode, base32Encode, checkTotp, hashPassword, totpCode, verifyPassword } = require('../server/dist/auth');
const { backup } = require('../server/dist/backup');
const { Throttle } = require('../server/dist/security');

const PASSWORD = 'correct horse battery';

async function server() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohe-auth-'));
  const db = openDatabase(path.join(dir, 'orders.db'));
  let token = 'first-token';
  const app = buildApp({ db, tokens: { get: () => token, rotate: () => (token = 'second-token') }, allowedHosts: () => true });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (route, body, cookie, extra = {}) => {
    const response = await fetch(`${base}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-requested-with': 'expense-hub', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get('set-cookie');
    return { status: response.status, body: await response.json().catch(() => ({})), cookie: setCookie ? setCookie.split(';')[0] : null, setCookie };
  };
  return {
    dir,
    db,
    base,
    request,
    async close() {
      await app.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('passwords are salted scrypt hashes that verify only the right password', () => {
  const first = hashPassword(PASSWORD);
  assert.match(first, /^scrypt\$32768\$8\$1\$/);
  assert.notEqual(first, hashPassword(PASSWORD), 'each hash has its own salt');
  assert.equal(verifyPassword(PASSWORD, first), true);
  assert.equal(verifyPassword('wrong password', first), false);
});

test('two-factor codes match the RFC 6238 test vector, and are single use', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(base32Decode(secret).toString(), '12345678901234567890');
  assert.equal(totpCode(secret, 1, 8), '94287082'); // T = 59 seconds
  assert.equal(totpCode(secret, Math.floor(1111111109 / 30), 8), '07081804');

  const now = 1_700_000_000_000;
  const step = Math.floor(now / 30000);
  assert.equal(checkTotp(secret, totpCode(secret, step), 0, now), step);
  assert.equal(checkTotp(secret, totpCode(secret, step - 1), 0, now), step - 1, 'one step of clock drift is allowed');
  assert.equal(checkTotp(secret, totpCode(secret, step - 2), 0, now), null);
  assert.equal(checkTotp(secret, totpCode(secret, step), step, now), null, 'a used code is refused');
  assert.equal(checkTotp(secret, 'abcdef', 0, now), null);
});

test('throttle blocks after the limit and clears on success', () => {
  const throttle = new Throttle(3, 1000);
  for (let i = 0; i < 3; i++) throttle.fail('k', 0);
  assert.equal(throttle.blocked('k', 10), true);
  assert.equal(throttle.blocked('k', 1001), false, 'the window expires');
  throttle.fail('k', 2000);
  throttle.clear('k');
  assert.equal(throttle.blocked('k', 2001), false);
});

test('first-run setup needs the setup code, and happens only once', async () => {
  const s = await server();
  try {
    assert.deepEqual((await s.request('/api/auth/state')).body, { setupNeeded: true, user: null });
    assert.equal((await s.request('/api/auth/setup', { setupCode: 'guess', username: 'me', password: PASSWORD })).status, 403);
    assert.equal((await s.request('/api/auth/setup', { setupCode: 'first-token', username: 'me', password: 'short' })).status, 400);
    const ok = await s.request('/api/auth/setup', { setupCode: ' first-\ntoken\n', username: 'me', password: PASSWORD });
    assert.equal(ok.status, 200);
    assert.match(ok.setCookie, /HttpOnly/i);
    assert.match(ok.setCookie, /SameSite=Strict/i);
    assert.equal((await s.request('/api/auth/state', undefined, ok.cookie)).body.user.username, 'me');
    assert.equal((await s.request('/api/auth/setup', { setupCode: 'first-token', username: 'two', password: PASSWORD })).status, 409);
  } finally {
    await s.close();
  }
});

test('sign-in, sign-out, password change and repeated failures', async () => {
  const s = await server();
  try {
    await s.request('/api/auth/setup', { setupCode: 'first-token', username: 'me', password: PASSWORD });
    assert.equal((await s.request('/api/auth/login', { username: 'me', password: 'nope' })).status, 401);
    const login = await s.request('/api/auth/login', { username: 'ME', password: PASSWORD });
    assert.equal(login.status, 200, 'usernames ignore case');
    const other = await s.request('/api/auth/login', { username: 'me', password: PASSWORD });

    assert.equal((await s.request('/api/status', undefined, login.cookie)).status, 200);
    await s.request('/api/auth/logout', {}, login.cookie);
    assert.equal((await s.request('/api/status', undefined, login.cookie)).status, 401, 'signed out');

    assert.equal((await s.request('/api/auth/password', { current: 'nope', next: 'another long password' }, other.cookie)).status, 403);
    assert.equal((await s.request('/api/auth/password', { current: PASSWORD, next: 'another long password' }, other.cookie)).status, 200);
    assert.equal((await s.request('/api/status', undefined, other.cookie)).status, 401, 'a password change signs out every session');
    assert.equal((await s.request('/api/auth/login', { username: 'me', password: 'another long password' })).status, 200);

    // The session is stored only as a hash, so a copy of the database can't sign in.
    const stored = s.db.raw.prepare('SELECT id_hash FROM sessions').all().map((r) => r.id_hash);
    assert.ok(!stored.includes(other.cookie.split('=')[1]));

    for (let i = 0; i < 8; i++) await s.request('/api/auth/login', { username: 'me', password: 'wrong' });
    assert.equal((await s.request('/api/auth/login', { username: 'me', password: 'another long password' })).status, 429, 'too many failures pause sign-in');
    const audit = s.db.raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'login.failed'").get().n;
    assert.ok(audit >= 8);
  } finally {
    await s.close();
  }
});

test('two-factor setup, sign-in with a code, and turning it off', async () => {
  const s = await server();
  try {
    const { cookie } = await s.request('/api/auth/setup', { setupCode: 'first-token', username: 'me', password: PASSWORD });
    const start = await s.request('/api/auth/totp/start', {}, cookie);
    assert.match(start.body.uri, /^otpauth:\/\/totp\/Business%20Hub%3Ame\?secret=/);
    assert.match(start.body.qrSvg, /^<svg/);
    const secret = start.body.secret;
    const step = () => Math.floor(Date.now() / 30000);
    assert.equal((await s.request('/api/auth/totp/enable', { code: '000000' }, cookie)).status, 400);
    assert.equal((await s.request('/api/auth/totp/enable', { code: totpCode(secret, step()) }, cookie)).status, 200);

    const first = await s.request('/api/auth/login', { username: 'me', password: PASSWORD });
    assert.deepEqual(first.body, { needCode: true });
    assert.equal(first.cookie, null, 'no session until the code is given');
    const withCode = await s.request('/api/auth/login', { username: 'me', password: PASSWORD, code: totpCode(secret, step() + 1) });
    assert.equal(withCode.status, 200);
    assert.equal(withCode.body.user.totpEnabled, true);
    const reused = await s.request('/api/auth/login', { username: 'me', password: PASSWORD, code: totpCode(secret, step() + 1) });
    assert.equal(reused.status, 401, 'a code works once');

    assert.equal((await s.request('/api/auth/totp/disable', { password: PASSWORD, code: '000000' }, withCode.cookie)).status, 403);
    // Codes are single use, so wait for a fresh window.
    const wait = 30000 - (Date.now() % 30000) + 50;
    await new Promise((resolve) => setTimeout(resolve, wait));
    const off = await s.request('/api/auth/totp/disable', { password: PASSWORD, code: totpCode(secret, step() + 1) }, withCode.cookie);
    assert.equal(off.status, 200);
    assert.equal((await s.request('/api/auth/login', { username: 'me', password: PASSWORD })).status, 200);
  } finally {
    await s.close();
  }
});

test('the access token can be shown and replaced, and the old one stops working', async () => {
  const s = await server();
  try {
    const { cookie } = await s.request('/api/auth/setup', { setupCode: 'first-token', username: 'me', password: PASSWORD });
    assert.equal((await s.request('/api/settings/token', undefined, cookie)).body.token, 'first-token');
    assert.equal((await s.request('/api/settings/token')).status, 401);
    assert.equal((await s.request('/api/settings/token/rotate', {}, cookie)).body.token, 'second-token');
    const health = (token) => fetch(`${s.base}/api/health`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.status);
    assert.equal(await health('first-token'), 401);
    assert.equal(await health('second-token'), 200);
  } finally {
    await s.close();
  }
});

test('backups are consistent copies, and only the newest are kept', async () => {
  const s = await server();
  try {
    s.db.saveOrders('amazon', [{ orderId: 'B1', date: '2024-01-01' }]);
    const files = [];
    for (let i = 0; i < 3; i++) {
      files.push(backup(s.dir, 2));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const kept = fs.readdirSync(path.join(s.dir, 'backups'));
    assert.equal(kept.length, 2);
    assert.ok(!kept.includes(path.basename(files[0])), 'the oldest was removed');
    const copy = new DatabaseSync(files[2], { readOnly: true });
    assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 1);
    copy.close();
  } finally {
    await s.close();
  }
});

test('local names from OHE_LAN_HOSTS are accepted beside the tailnet name', () => {
  const { allowedHostsFor, loadConfig } = require('../server/dist/config');
  const config = loadConfig(['node', 'index.js'], { OHE_NETWORK: '1', OHE_PUBLIC_HOST: 'hub.example.ts.net', OHE_LAN_HOSTS: 'Hub.Home, books.lan:9000' });
  assert.equal(config.host, '0.0.0.0');
  assert.deepEqual(config.lanHosts, ['hub.home', 'books.lan:9000']);
  const hosts = allowedHostsFor(config, ['10.0.0.5']);
  for (const host of ['10.0.0.5:8787', 'hub.home:8787', 'hub.home', 'books.lan:9000', 'hub.example.ts.net']) assert.ok(hosts.includes(host), host);
  assert.ok(!hosts.includes('evil.example:8787'));
  assert.deepEqual(loadConfig(['node', 'index.js'], {}).lanHosts, [], 'none unless set');
});

test('access switches: Tailscale only by default, the home network when turned on, and never both off', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohe-access-'));
  const db = openDatabase(path.join(dir, 'orders.db'));
  const tailnet = 'hub.example.ts.net';
  const app = buildApp({ db, tokens: { get: () => 'first-token', rotate: () => 'x' }, allowedHosts: () => true, access: { tailnetHost: tailnet, lanReady: true, lanUrls: ['http://10.0.0.5:8787'] } });
  let cookie = '';
  // Tailscale's proxy runs on the same machine; the home network comes from another one.
  const ways = { tailscale: { remoteAddress: '127.0.0.1', host: tailnet }, lan: { remoteAddress: '10.0.0.20', host: '10.0.0.5:8787' }, spoof: { remoteAddress: '10.0.0.20', host: tailnet } };
  const send = async (way, url, payload) => {
    const r = await app.inject({
      method: payload === undefined ? 'GET' : 'POST',
      url,
      remoteAddress: ways[way].remoteAddress,
      headers: { host: ways[way].host, 'x-requested-with': 'expense-hub', ...(cookie ? { cookie } : {}) },
      ...(payload !== undefined ? { payload } : {}),
    });
    const set = r.headers['set-cookie'];
    if (set) cookie = String(Array.isArray(set) ? set[0] : set).split(';')[0];
    return { status: r.statusCode, body: r.json() };
  };
  try {
    assert.equal((await send('tailscale', '/api/auth/setup', { setupCode: 'first-token', username: 'me', password: PASSWORD })).status, 200);
    const start = await send('tailscale', '/api/settings/access');
    assert.equal(start.body.via, 'tailscale');
    assert.equal(start.body.tailscale, true);
    assert.deepEqual(start.body.lan, { on: false, until: null });
    assert.equal((await send('lan', '/api/settings/access')).status, 403, 'the home network is shut by default');
    assert.equal((await send('spoof', '/api/settings/access')).status, 403, "naming the tailnet from another machine doesn't count as Tailscale");

    assert.equal((await send('tailscale', '/api/settings/access', { tailscale: false })).status, 400, "Tailscale can't go off while it's the only way in");
    const week = await send('tailscale', '/api/settings/access', { lan: { on: true, days: 7 } });
    assert.equal(week.body.lan.on, true);
    assert.ok(new Date(week.body.lan.until) > new Date());
    assert.equal((await send('lan', '/api/settings/access')).body.via, 'lan');
    assert.equal((await send('tailscale', '/api/settings/access', { tailscale: false })).status, 400, 'nor while the home network has an end date');

    assert.equal((await send('lan', '/api/settings/access', { lan: { on: true, days: null } })).body.lan.until, null);
    assert.equal((await send('lan', '/api/settings/access', { tailscale: false })).body.tailscale, false);
    assert.equal((await send('tailscale', '/api/settings/access')).status, 403, 'Tailscale is shut');
    assert.equal((await send('lan', '/api/settings/access', { lan: { on: false } })).status, 400, "the home network can't go off while Tailscale is");
    assert.equal((await send('lan', '/api/settings/access', { tailscale: true })).body.tailscale, true);
    assert.equal((await send('tailscale', '/api/settings/access', { lan: { on: false } })).body.lan.on, false);
    assert.equal((await send('lan', '/api/settings/access')).status, 403);

    // A timed opening shuts by itself once its time is up.
    db.raw.prepare("INSERT INTO app_settings (key, value) VALUES ('access.lan', ?)").run(JSON.stringify({ on: true, until: '2000-01-01T00:00:00.000Z' }));
    db.raw.prepare("INSERT INTO app_settings (key, value) VALUES ('access.tailscale', 'off')").run();
    assert.equal((await send('lan', '/api/settings/access')).status, 403, 'expired');
    assert.equal((await send('tailscale', '/api/settings/access')).body.tailscale, true, 'and Tailscale comes back on, so something is always open');
  } finally {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a shut way in tells a browser in plain words', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohe-access-page-'));
  const db = openDatabase(path.join(dir, 'orders.db'));
  const app = buildApp({ db, tokens: { get: () => 't', rotate: () => 't' }, allowedHosts: () => true, access: { tailnetHost: 'hub.example.ts.net', lanReady: true, lanUrls: [] } });
  try {
    const r = await app.inject({ url: '/settings', remoteAddress: '10.0.0.20', headers: { host: '10.0.0.5:8787' } });
    assert.equal(r.statusCode, 403);
    assert.match(r.headers['content-type'], /text\/plain/);
    assert.match(r.body, /Home-network access to Business Hub is turned off/);
  } finally {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
