// Wealth: investment and retirement accounts beside the bank accounts, net worth over
// time, accounts typed in by hand, and admin logins that see everything.
// Made-up data only.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase } = require('../server/db');
const { buildApp } = require('../server/dist/app');
const { guessKind } = require('../server/dist/bank/simplefin');

let dir;
let db;
let app;
let base;
let cookie;

const call = (route, options = {}, as = cookie) =>
  fetch(`${base}${route}`, { ...options, headers: { cookie: as, 'x-requested-with': 'expense-hub', ...(options.body ? { 'content-type': 'application/json' } : {}) } });
const post = async (route, body = {}, as = cookie) => {
  const response = await call(route, { method: 'POST', body: JSON.stringify(body) }, as);
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error), { status: response.status });
  return data;
};
const get = async (route, as = cookie) => (await call(route, {}, as)).json();
const signIn = async (username, password) => {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'expense-hub' },
    body: JSON.stringify({ username, password }),
  });
  return { response, cookie: response.headers.get('set-cookie')?.split(';')[0], body: await response.json() };
};
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-wealth-'));
  db = openDatabase(path.join(dir, 'orders.db'));
  app = buildApp({ db, tokens: { get: () => 'tok', rotate: () => 'tok' }, allowedHosts: () => true });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;
  const setup = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'expense-hub' },
    body: JSON.stringify({ setupCode: 'tok', username: 'owner', password: 'a long test password' }),
  });
  cookie = setup.headers.get('set-cookie').split(';')[0];
});

after(async () => {
  await app.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('retirement and brokerage account names are recognised as investments', () => {
  for (const name of ['Fidelity 401(k)', 'ROTH IRA', 'Individual Brokerage', 'Rollover IRA', 'Health Savings HSA', 'Example 403b Plan']) assert.equal(guessKind(name), 'investment', name);
  assert.equal(guessKind('Everyday Checking'), 'checking');
  assert.equal(guessKind('Rewards Visa'), 'credit');
});

test('net worth adds up every household account, with money owed counted against it', async () => {
  const csv = (rows) => ['Date,Description,Amount', ...rows, ''].join('\n');
  await post('/api/bank/import', { content: csv([`${daysAgo(3).slice(5, 7)}/${daysAgo(3).slice(8)}/${daysAgo(3).slice(0, 4)},COFFEE,-4.00`]), fileName: 'c.csv', newAccount: { name: 'Home checking', kind: 'checking', owner: 'personal' } });
  await post('/api/bank/import', { content: csv([`${daysAgo(3).slice(5, 7)}/${daysAgo(3).slice(8)}/${daysAgo(3).slice(0, 4)},SUPPLIES,-40.00`]), fileName: 'b.csv', newAccount: { name: 'Shop checking', kind: 'checking', owner: 'business' } });
  await post('/api/bank/import', { content: csv([`${daysAgo(3).slice(5, 7)}/${daysAgo(3).slice(8)}/${daysAgo(3).slice(0, 4)},BOOKS,-25.00`]), fileName: 'v.csv', newAccount: { name: 'Travel card', kind: 'credit', owner: 'personal' } });
  const { accounts } = await get('/api/bank/accounts');
  const id = (name) => accounts.find((a) => a.name === name).id;
  db.raw.prepare('UPDATE bank_accounts SET balance = ?, balance_date = ? WHERE id = ?').run(12000, daysAgo(1), id('Home checking'));
  db.raw.prepare('UPDATE bank_accounts SET balance = ?, balance_date = ? WHERE id = ?').run(50000, daysAgo(1), id('Shop checking'));
  db.raw.prepare('UPDATE bank_accounts SET balance = ?, balance_date = ? WHERE id = ?').run(-1500, daysAgo(1), id('Travel card'));

  // A 401(k) nothing imports: typed in, with an older balance to start its history.
  const { id: k401 } = await post('/api/wealth/accounts', { name: 'Example 401(k)', institution: 'Fidelity', investType: '401k', holder: 'me', balance: 200000, day: daysAgo(40) });
  await post(`/api/wealth/accounts/${k401}/balance`, { balance: 210000 });
  const { id: roth } = await post('/api/wealth/accounts', { name: 'Spouse Roth', investType: 'roth_ira', holder: 'spouse', balance: 80000 });

  let wealth = await get('/api/wealth');
  assert.equal(wealth.totals.netWorth, 12000 - 1500 + 210000 + 80000, 'business accounts are left out');
  assert.equal(wealth.totals.invested, 290000);
  assert.equal(wealth.totals.owed, -1500);
  assert.equal(wealth.businessAccounts, 1);
  assert.deepEqual(
    wealth.byTreatment.map((t) => [t.key, t.amount]),
    [['cash', 12000], ['pre_tax', 210000], ['roth', 80000], ['owed', -1500]]
  );
  assert.deepEqual(wealth.byHolder.map((h) => [h.holder, h.amount]), [['me', 210000], ['spouse', 80000]]);
  const k = wealth.accounts.find((a) => a.id === k401);
  assert.equal(k.source, 'manual');
  assert.equal(k.removable, true);
  assert.equal(k.treatment, 'pre_tax');
  // History carries each balance forward: the oldest point is the first 401(k) balance alone.
  assert.equal(wealth.history[0].netWorth, 200000);
  assert.equal(wealth.history.at(-1).netWorth, wealth.totals.netWorth);
  assert.equal((await get(`/api/wealth/accounts/${k401}/balances`)).balances.length, 2);

  assert.equal((await get('/api/wealth?business=1')).totals.netWorth, wealth.totals.netWorth + 50000);

  // A balance from before the latest one fills in history without replacing today's.
  await post(`/api/wealth/accounts/${roth}/balance`, { balance: 70000, day: daysAgo(20) });
  wealth = await get('/api/wealth');
  assert.equal(wealth.accounts.find((a) => a.id === roth).balance, 80000);
  await assert.rejects(post(`/api/wealth/accounts/${roth}/balance`, { balance: 1, day: '2999-01-01' }), { status: 400 });

  // Marking an imported account as an investment takes it out of My money.
  assert.ok((await get('/api/personal')).accounts.some((a) => a.name === 'Home checking'));
  await post(`/api/wealth/accounts/${id('Home checking')}`, { investType: 'brokerage', holder: 'joint' });
  wealth = await get('/api/wealth');
  const home = wealth.accounts.find((a) => a.name === 'Home checking');
  assert.deepEqual([home.kind, home.treatment, home.source], ['investment', 'taxable', 'file']);
  assert.ok(!(await get('/api/personal')).accounts.some((a) => a.name === 'Home checking'));
  await post(`/api/wealth/accounts/${id('Home checking')}`, { investType: null });
  assert.equal((await get('/api/wealth')).accounts.find((a) => a.name === 'Home checking').kind, 'other');
  await assert.rejects(post(`/api/wealth/accounts/${id('Travel card')}`, { investType: '401k' }), { status: 400 });
  await assert.rejects(post('/api/wealth/accounts', { name: 'X', investType: 'nonsense', holder: null, balance: 1 }), { status: 400 });

  // Only a typed-in account can be removed.
  await assert.rejects(post(`/api/wealth/accounts/${id('Travel card')}/delete`), { status: 400 });
  await post(`/api/wealth/accounts/${roth}/delete`);
  assert.ok(!(await get('/api/wealth')).accounts.some((a) => a.id === roth));
});

test('a second admin sees and manages everything; a family login sees none of it', async () => {
  let { admins, selfId } = await get('/api/admins');
  assert.deepEqual(admins.map((a) => a.username), ['owner']);
  await post('/api/admins', { username: 'spouse', password: 'spouse test password' });
  await assert.rejects(post('/api/admins', { username: 'Spouse', password: 'spouse test password' }), { status: 409 });
  await assert.rejects(post('/api/admins', { username: 'short', password: 'short' }), { status: 400 });

  const spouse = await signIn('spouse', 'spouse test password');
  assert.equal(spouse.response.status, 200);
  assert.equal(spouse.body.user.role, 'owner');
  assert.equal((await call('/api/wealth', {}, spouse.cookie)).status, 200);
  assert.equal((await call('/api/bank/accounts', {}, spouse.cookie)).status, 200);
  assert.equal((await call('/api/people', {}, spouse.cookie)).status, 200);

  ({ admins, selfId } = await get('/api/admins'));
  const other = admins.find((a) => a.username === 'spouse').id;
  // Nobody removes or resets their own login here.
  await assert.rejects(post(`/api/admins/${selfId}/delete`), { status: 400 });
  await assert.rejects(post(`/api/admins/${selfId}/password`, { password: 'another long password' }), { status: 400 });
  await post(`/api/admins/${other}/password`, { password: 'a new spouse password' });
  assert.equal((await call('/api/wealth', {}, spouse.cookie)).status, 401, 'a reset signs them out');
  assert.equal((await signIn('spouse', 'a new spouse password')).response.status, 200);

  // A family member's login can't reach any of it.
  const { id: kid } = await post('/api/people', { name: 'Kid Example' });
  await post(`/api/people/${kid}/login`, { username: 'kid', password: 'kid test password' });
  const member = await signIn('kid', 'kid test password');
  for (const route of ['/api/wealth', '/api/admins']) assert.equal((await call(route, {}, member.cookie)).status, 403, route);
  await assert.rejects(post('/api/admins', { username: 'x', password: 'kid test password long' }, member.cookie), { status: 403 });
  // A member's id is not an admin's.
  const kidLogin = (await get('/api/people')).people[0].login.id;
  await assert.rejects(post(`/api/admins/${kidLogin}/delete`), { status: 404 });

  await post(`/api/admins/${other}/delete`);
  assert.equal((await signIn('spouse', 'a new spouse password')).response.status, 401);
  assert.deepEqual((await get('/api/admins')).admins.map((a) => a.username), ['owner']);
});
