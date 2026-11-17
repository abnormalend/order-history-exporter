// The retirement projection, checked against cases worked out by hand. Made-up data only.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase } = require('../server/db');
const { buildApp } = require('../server/dist/app');
const { incomeTax, taxableSocialSecurity, rmd, rmdAge, STATES } = require('../server/dist/retirement/tax');
const { simulate, lognormal, percentile, randomSource } = require('../server/dist/retirement/simulate');
const { claimFactor, spousalFactor, fullAgeMonths, returnsFor, project } = require('../server/dist/retirement/project');

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 0.01, `${message ?? ''} ${actual} ≠ ${expected}`);
const flat = { stocks: 0.02, bonds: 0.02, cash: 0.02, inflation: 0.02 }; // every real return is 0
const noTax = { enabled: false, state: 'none', rothConversionsTo: null, withdrawalOrder: 'standard', deferredYears: 5 };
const taxed = (over = {}) => ({ ...noTax, enabled: true, ...over });
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
const plan = (over = {}) => ({ me: person(), spouse: null, spending: 0, spendingChangeAt80: 0, markets: flat, streams: [], events: [], taxes: noTax, ...over });
const none = { cash: 0, taxable: 0, pre_tax: 0, pre_tax_spouse: 0, deferred: 0, hsa: 0, roth: 0 };
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

/* ---------- Taxes and RMDs ---------- */

const none0 = STATES.none;
const tax = (over) => incomeTax({ filing: 'mfj', year: 2026, over65: 0, ordinary: 0, retirement: 0, socialSecurity: 0, gains: 0, state: none0, ...over });

test('federal tax by hand: brackets, the senior deduction, gains on top, Social Security', () => {
  // 100,000 − 32,200 = 67,800 taxable: 24,800 at 10% + 43,000 at 12%.
  let t = tax({ ordinary: 100000 });
  assert.equal(t.taxableOrdinary, 67800);
  assert.equal(t.federal, 7640);
  // Both 65+: 32,200 + 2 × 1,650 + 2 × 6,000 = 47,500 off, so 52,500 taxable.
  t = tax({ ordinary: 100000, over65: 2 });
  assert.equal(t.taxableOrdinary, 52500);
  assert.equal(t.federal, 5804);
  assert.equal(tax({ ordinary: 100000, over65: 2, year: 2029 }).taxableOrdinary, 64500, 'the extra senior deduction ends after 2028');
  // Gains under the 0% line pay nothing; above it, 15%.
  assert.equal(tax({ gains: 50000 }).federal, 0);
  near(tax({ ordinary: 130900, gains: 10000 }).federal, bracketAt(98700) + 9800 * 0.15, "200 still fits under the 0% line");
  // Provisional income 30,000 + 20,000 = 50,000: 6,000 (half the middle band) + 85% of 6,000.
  assert.equal(taxableSocialSecurity('mfj', 40000, 30000), 11100);
  assert.equal(taxableSocialSecurity('mfj', 40000, 10000), 0);
});

function bracketAt(taxable) {
  return 2480 + (Math.min(taxable, 100800) - 24800) * 0.12;
}

test('state tax: North Carolina taxes retirement income, Illinois does not', () => {
  near(tax({ ordinary: 100000, retirement: 100000, state: STATES.NC }).state, (100000 - 25500) * 0.0399);
  assert.equal(tax({ ordinary: 100000, retirement: 100000, state: STATES.IL }).state, 0);
  near(tax({ ordinary: 100000, retirement: 0, state: STATES.IL }).state, (100000 - 5700) * 0.0495);
});

test('RMDs: the starting age by birth year and the uniform table', () => {
  assert.equal(rmdAge(1950), 72);
  assert.equal(rmdAge(1955), 73);
  assert.equal(rmdAge(1966), 75);
  assert.equal(rmd(1955, 73, 265000), 10000);
  assert.equal(rmd(1966, 73, 265000), 0, 'not until 75 for someone born in 1966');
});

test('the projection takes RMDs, and saves what is not spent', () => {
  const result = project(plan({ me: person({ birthYear: 1951, retireAge: 60, planToAge: 76 }) }), { ...none, pre_tax: 246000 }, allStocks, 2026);
  assert.equal(result.rows[0].rmd, 10000, '246,000 ÷ 24.6 at 75');
  assert.equal(result.rows[0].saved, 10000);
  assert.equal(result.rows[0].end.taxable, 10000);
});

test('deferred compensation pays out in five equal installments from the year after retiring', () => {
  const me = person({ retireAge: 61, planToAge: 70, contributions: { pre_tax: 0, roth: 0, hsa: 0, deferred: 20000 }, takeHome: 1 });
  const result = project(plan({ me }), { ...none, deferred: 80000 }, allStocks, 2026);
  // 2026: still working, 20,000 more goes in; retires 2027; paid 2028–2032.
  const paid = result.rows.map((r) => [r.year, r.deferredPaid]);
  assert.deepEqual(paid.slice(0, 8), [[2026, 0], [2027, 0], [2028, 20000], [2029, 20000], [2030, 20000], [2031, 20000], [2032, 20000], [2033, 0]]);
  assert.equal(result.rows.at(-1).end.deferred, 0);
});

test('taking money out covers its own tax', () => {
  const me = person({ retireAge: 55, planToAge: 61 });
  const result = project(plan({ me, spending: 50000, taxes: taxed() }), { ...none, pre_tax: 1000000 }, allStocks, 2026);
  // Single: W − (1,240 + 12% × (W − 16,100 − 12,400)) = 50,000, so W = 47,820 ÷ 0.88.
  const [first] = result.rows;
  assert.ok(Math.abs(first.withdrawn.pre_tax - 47820 / 0.88) < 1, String(first.withdrawn.pre_tax));
  assert.ok(Math.abs(first.tax.federal - (47820 / 0.88 - 50000)) < 1);
  assert.equal(first.shortfall, 0);
  assert.ok(result.lifetimeTax > first.tax.federal);
});

test('Roth conversions fill the chosen bracket, with the tax paid from cash', () => {
  const me = person({ retireAge: 55, planToAge: 61 });
  const result = project(plan({ me, taxes: taxed({ rothConversionsTo: 0.12 }) }), { ...none, cash: 100000, pre_tax: 1000000 }, allStocks, 2026);
  const [first] = result.rows;
  // Single: 16,100 deduction + 50,400 to the top of the 12% bracket.
  assert.equal(first.conversion, 66500);
  assert.equal(first.taxableOrdinary, 50400);
  assert.equal(first.tax.federal, 5800);
  assert.equal(first.withdrawn.cash, 5800);
  assert.equal(first.end.roth, 66500);
  assert.equal(first.end.pre_tax, 1000000 - 66500);
});

test('a survivor takes over the pre-tax accounts and files single', () => {
  const me = person({ birthYear: 1960, retireAge: 60, planToAge: 67 });
  const spouse = person({ birthYear: 1960, retireAge: 60, planToAge: 70 });
  const result = project(plan({ me, spouse }), { ...none, pre_tax: 100000, pre_tax_spouse: 50000 }, allStocks, 2026);
  const after = result.rows.find((r) => r.year === 2028);
  assert.equal(after.end.pre_tax, 0);
  assert.equal(after.end.pre_tax_spouse, 150000);
});

/* ---------- Monte Carlo ---------- */

const still = { stocks: 0, bonds: 0, cash: 0 };

test('the random pieces: percentiles, a lognormal that keeps its average, a repeatable seed', () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([1, 2, 3, 4], 0), 1);
  assert.equal(percentile([1, 2, 3, 4], 1), 4);
  near(lognormal(0.07, 0, 1.5), 0.07, 'no spread: always the average');
  const random = randomSource(7);
  let sum = 0;
  for (let i = 0; i < 200000; i++) sum += lognormal(0.07, 0.17, random.normal());
  assert.ok(Math.abs(sum / 200000 - 0.07) < 0.002, 'the average return is the expected one');
  const a = randomSource(1);
  const b = randomSource(1);
  assert.deepEqual([a.next(), a.next()], [b.next(), b.next()]);
});

test('with no swings every trial is the steady plan', () => {
  const p = plan({ me: person({ takeHome: 100000, contributions: { pre_tax: 20000, roth: 0, hsa: 0 } }), spending: 80000 });
  const start = { balances: { ...none, cash: 50000, taxable: 100000, pre_tax: 200000 }, taxableBasis: 100000 };
  const sim = simulate(p, start, allStocks, 2026, { trials: 100, volatility: still });
  assert.equal(sim.successRate, 1);
  assert.deepEqual(sim.years.map((y) => [y.year, y.p10, y.p50, y.p90]), [
    [2026, 390000, 390000, 390000],
    [2027, 310000, 310000, 310000],
    [2028, 230000, 230000, 230000],
    [2029, 150000, 150000, 150000],
  ]);
  assert.equal(sim.shortfall, null);

  const short = simulate({ ...p, spending: 200000 }, { balances: { ...none, cash: 100000 }, taxableBasis: 0 }, allStocks, 2026, { trials: 100, volatility: still });
  assert.equal(short.successRate, 0);
  assert.deepEqual(short.shortfall, { medianYear: 2027, earlyYear: 2027 });
});

test('swings spread the outcomes around the steady plan, the same way each time', () => {
  const markets = { stocks: 0.07, bonds: 0.04, cash: 0.03, inflation: 0.03 };
  const p = plan({ me: person({ retireAge: 60, planToAge: 90 }), markets, spending: 40000 });
  const start = { balances: { ...none, taxable: 1000000 }, taxableBasis: 1000000 };
  const once = simulate(p, start, allStocks, 2026, { trials: 400 });
  const again = simulate(p, start, allStocks, 2026, { trials: 400 });
  assert.deepEqual(once, again, 'a fixed seed gives the same answer');
  const last = once.years.at(-1);
  assert.ok(last.p10 < last.p50 && last.p50 < last.p90);
  assert.ok(once.successRate > 0.5 && once.successRate < 1, String(once.successRate));
  const calmer = simulate({ ...p, markets: { ...markets, volatility: { stocks: 0.05, bonds: 0.02 } } }, start, allStocks, 2026, { trials: 400 });
  assert.ok(calmer.years.at(-1).p90 - calmer.years.at(-1).p10 < last.p90 - last.p10, 'smaller swings, a narrower range');
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
  assert.deepEqual(data.start.balances, { ...none, pre_tax: 300000, roth: 50000 });
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

test('trials, saved scenarios and the comparison', async () => {
  const year = new Date().getFullYear();
  const mine = plan({ me: person({ birthYear: year - 60, retireAge: 62, planToAge: 90 }), spending: 40000, markets: { stocks: 0.07, bonds: 0.045, cash: 0.035, inflation: 0.028 } });
  const sim = await post('/api/retirement/simulate', { plan: mine, trials: 200 });
  assert.equal(sim.trials, 200);
  assert.equal(sim.years.length, 31);
  await assert.rejects(post('/api/retirement/simulate', { plan: mine, trials: 50 }), { status: 400 });

  let { scenarios } = await post('/api/retirement/scenarios', { name: 'Retire at 65', plan: { ...mine, me: { ...mine.me, retireAge: 65 } } });
  assert.deepEqual(scenarios.map((x) => [x.id, x.name]), [[1, 'Retire at 65']]);
  ({ scenarios } = await post('/api/retirement/scenarios', { name: 'Spend less', plan: { ...mine, spending: 30000 } }));
  ({ scenarios } = await post('/api/retirement/scenarios', { name: 'retire at 65', plan: { ...mine, me: { ...mine.me, retireAge: 66 } } }));
  assert.deepEqual(scenarios.map((x) => [x.id, x.name, x.plan.me.retireAge]), [[1, 'retire at 65', 66], [2, 'Spend less', 62]], 'the same name replaces it');
  await assert.rejects(post('/api/retirement/scenarios', { name: ' ', plan: mine }), { status: 400 });
  assert.equal((await get('/api/retirement')).scenarios.length, 2);

  const compared = await post('/api/retirement/compare', mine);
  assert.deepEqual(compared.map((c) => [c.id, c.name, c.retireYear, c.spending]), [
    [null, 'This plan', year + 2, 40000],
    [1, 'retire at 65', year + 6, 40000],
    [2, 'Spend less', year + 2, 30000],
  ]);
  assert.ok(compared.every((c) => c.successRate >= 0 && c.successRate <= 1));

  ({ scenarios } = await post('/api/retirement/scenarios/1/delete'));
  assert.deepEqual(scenarios.map((x) => x.name), ['Spend less']);
  await assert.rejects(post('/api/retirement/scenarios/1/delete'), { status: 404 });
});
