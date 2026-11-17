// The retirement projection, checked against cases worked out by hand. Made-up data only.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase } = require('../server/db');
const { buildApp } = require('../server/dist/app');
const { claimFactor, spousalFactor, fullAgeMonths, returnsFor, project } = require('../server/dist/retirement/project');

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 0.01, `${message ?? ''} ${actual} ≠ ${expected}`);
const flat = { stocks: 0.02, bonds: 0.02, cash: 0.02, inflation: 0.02 }; // every real return is 0
const person = (over = {}) => ({
  name: 'Example',
  birthYear: 1966,
  retireAge: 61,
  planToAge: 63,
  takeHome: 0,
  contributions: { pre_tax: 0, roth: 0, hsa: 0 },
  ssAtFullAge: 0,
  ssClaimAge: 67,
  ...over,
});
const plan = (over = {}) => ({ me: person(), spouse: null, spending: 0, spendingChangeAt80: 0, markets: flat, streams: [], events: [], ...over });
const none = { cash: 0, taxable: 0, pre_tax: 0, hsa: 0, roth: 0 };
const allStocks = { stocks: 1, bonds: 0, cash: 0 };

test('Social Security: full retirement age, early cuts, delayed credits and the spousal half', () => {
  assert.equal(fullAgeMonths(1965), 67 * 12);
  assert.equal(fullAgeMonths(1957), 66 * 12 + 6);
  assert.equal(fullAgeMonths(1950), 66 * 12);
  near(claimFactor(1965, 62), 0.7);
  near(claimFactor(1965, 67), 1);
  near(claimFactor(1965, 70), 1.24);
  near(claimFactor(1965, 72), 1.24, 'nothing more after 70');
  near(claimFactor(1957, 62), 0.725, '54 months early');
  near(spousalFactor(1965, 62), 0.325);
  near(spousalFactor(1965, 70), 0.5, 'a spousal benefit never grows by waiting');
});

test('returns are after inflation, from what the money is in', () => {
  const r = returnsFor({ stocks: 0.07, bonds: 0.04, cash: 0.03, inflation: 0.028 }, { stocks: 0.5, bonds: 0.5, cash: 0 });
  near(r.invested * 1e4, ((1.055 / 1.028 - 1) * 1e4));
  near(r.cash * 1e4, ((1.03 / 1.028 - 1) * 1e4));
});

test('a plan with no growth can be followed year by year by hand', () => {
  const p = plan({ me: person({ takeHome: 100000, contributions: { pre_tax: 20000, roth: 0, hsa: 0 } }), spending: 80000 });
  const result = project(p, { ...none, cash: 50000, taxable: 100000, pre_tax: 200000 }, allStocks, 2026);
  assert.deepEqual(
    result.rows.map((r) => [r.year, r.ages[0], r.saved, r.withdrawn.cash, r.withdrawn.taxable, r.withdrawn.pre_tax, r.total]),
    [
      [2026, 60, 20000, 0, 0, 0, 390000], // working: 20,000 into the 401(k), 20,000 left over saved
      [2027, 61, 0, 50000, 30000, 0, 310000], // retired: cash first, then taxable
      [2028, 62, 0, 0, 80000, 0, 230000],
      [2029, 63, 0, 0, 10000, 70000, 150000], // then pre-tax
    ]
  );
  assert.equal(result.runsOut, null);
  assert.deepEqual(result.atRetirement, { year: 2027, total: 310000 });
  assert.equal(result.atEnd, 150000);

  const short = project({ ...p, spending: 200000 }, { ...none, cash: 100000 }, allStocks, 2026);
  assert.deepEqual(short.runsOut, { year: 2027, ages: [61, null] });
  assert.equal(short.rows[0].shortfall, 0, 'the first year: 100,000 pay + 100,000 cash covers 200,000 spending');
  assert.ok(short.rows[1].shortfall > 0);
});

test('growth, a pension without a raise, events, and spending after 80', () => {
  const markets = { stocks: 0.07, bonds: 0.04, cash: 0.028, inflation: 0.028 };
  const me = person({ birthYear: 1946, retireAge: 60, planToAge: 82 });
  const result = project(
    plan({
      me,
      markets,
      spending: 50000,
      spendingChangeAt80: -0.2,
      streams: [{ name: 'Pension', owner: 'me', startAge: 70, endAge: null, yearly: 12000, inflationAdjusted: false }],
      events: [{ name: 'Car', year: 2027, years: 1, amount: -30000 }],
    }),
    { ...none, taxable: 1000000 },
    allStocks,
    2026
  );
  const [y2026, y2027] = result.rows;
  near(y2026.growth, 1000000 * (1.07 / 1.028 - 1), 'a year of real growth');
  assert.equal(y2026.spending, 40000, '80 already: 20% less');
  near(y2026.other, 12000, 'the pension at its stated amount this year');
  near(y2027.other, 12000 / 1.028, 'and worth less each year after');
  assert.equal(y2027.events, -30000);
});

test('Social Security for a couple: the spousal half, then the survivor keeps the larger', () => {
  const me = person({ birthYear: 1960, retireAge: 60, planToAge: 68, ssAtFullAge: 3000, ssClaimAge: 67 });
  const spouse = person({ birthYear: 1960, retireAge: 60, planToAge: 72, ssAtFullAge: 1000, ssClaimAge: 67 });
  const result = project(plan({ me, spouse }), { ...none, cash: 1 }, allStocks, 2027);
  assert.deepEqual(result.socialSecurity, { me: 36000, spouse: 18000 });
  const at = (year) => result.rows.find((r) => r.year === year).socialSecurity;
  assert.equal(at(2027), 54000, 'both at 67');
  assert.equal(at(2029), 36000, 'after the first death, the larger one');
  assert.equal(result.rows[result.rows.length - 1].year, 2032, 'until the second reaches the plan age');
});

/* ---------- The API ---------- */

let dir;
let db;
let app;
let base;
let cookie;
const call = (route, options = {}) =>
  fetch(`${base}${route}`, { ...options, headers: { cookie, 'x-requested-with': 'expense-hub', ...(options.body ? { 'content-type': 'application/json' } : {}) } });
const post = async (route, body = {}) => {
  const response = await call(route, { method: 'POST', body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error), { status: response.status });
  return data;
};
const get = async (route) => (await call(route)).json();

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-retire-'));
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

test('the plan starts from Wealth balances, can be tried without saving, and is kept once saved', async () => {
  await post('/api/wealth/accounts', { name: 'Example 401(k)', investType: '401k', holder: 'me', balance: 300000 });
  await post('/api/wealth/accounts', { name: 'Example Roth', investType: 'roth_ira', holder: 'spouse', balance: 50000 });
  await post('/api/wealth/accounts', { name: 'Example 529', investType: '529', holder: 'joint', balance: 20000 });
  let data = await get('/api/retirement');
  assert.equal(data.plan, null);
  assert.deepEqual(data.start.balances, { cash: 0, taxable: 0, pre_tax: 300000, hsa: 0, roth: 50000 });
  assert.deepEqual(data.start.left.map((l) => l.why), ['education'], "a 529 isn't for retirement");

  const year = new Date().getFullYear();
  const mine = plan({ me: person({ birthYear: year - 60, retireAge: 62, planToAge: 90 }), spending: 40000, markets: data.defaults.markets });
  await assert.rejects(post('/api/retirement/preview', { ...mine, me: { ...mine.me, ssClaimAge: 60 } }), { status: 400 });
  const tried = await post('/api/retirement/preview', mine);
  assert.equal(tried.rows[0].year, year);
  assert.equal((await get('/api/retirement')).plan, null, 'trying a plan saves nothing');

  await post('/api/retirement/plan', mine);
  data = await get('/api/retirement');
  assert.equal(data.plan.spending, 40000);
  assert.equal(data.projection.rows.length, 31);
});
