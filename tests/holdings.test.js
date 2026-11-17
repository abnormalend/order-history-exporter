// Holdings: brokerage positions files, asset classes, things worth a look, and the
// kinds of investment account names suggest. Made-up data only.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase } = require('../server/db');
const { buildApp } = require('../server/dist/app');
const { guessKind } = require('../server/dist/bank/simplefin');
const { readPositions, guessClass, guessInvestType, isFund } = require('../server/dist/wealth/positions');

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
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-holdings-'));
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

// Made-up downloads in each brokerage's layout.
const FIDELITY = [
  "Account number,Account name,Symbol,Description,Quantity,Last price,Last price change,Current value,Today's gain/loss dollar,Today's gain/loss percent,Total gain/loss dollar,Total gain/loss percent,Percent of account,Cost basis total,Average cost basis,Type",
  'X11112222,Individual,EXMP,EXAMPLE WIDGETS INC,100,$50.00,+$1.00,$5000.00,$100.00,2.00%,+$1000.00,+25.00%,50.00%,$4000.00,$40.00,Cash,',
  'X11112222,Individual,SPAXX**,HELD IN MONEY MARKET,,,,$5000.00,,,,,50.00%,,,Cash,',
  '90001,"EXAMPLE CORP 401(K) PLAN",,BROKERAGELINK,30000,$1.00,$0.00,$30000.00,$0.00,0.00%,$0.00,0.00%,--,$30000.00,$1.00,,',
  '90001,"EXAMPLE CORP 401(K) PLAN",TDF40,TARGETRETIREMENT2040,100,$20.00,$0.00,$2000.00,$0.00,0.00%,$0.00,0.00%,10%,$1800.00,$18.00,,',
  '555503333,BrokerageLink,912800AA1,UNITED STATES TREAS BILL 0% 01/01/2030,10000,$98.00,$0.00,$9800.00,$0.00,0.00%,-$200.00,-2.00%,30%,$10000.00,--,Cash,',
  '555503333,BrokerageLink,EXMP,EXAMPLE WIDGETS INC,400,$50.00,$0.00,$20000.00,$0.00,0.00%,+$5000.00,+33.00%,60%,$15000.00,$37.50,Cash,',
  '',
  '"Notes about the data, one long cell."',
  '',
  '"Date downloaded Mar-05-2026 4:00 p.m ET"',
].join('\n');
const SCHWAB = [
  '"Positions for account Individual ...789 as of 04:00 PM ET, 2026/03/05"',
  '',
  '"Symbol","Description","Qty (Quantity)","Price","Price Chng $ (Price Change $)","Price Chng % (Price Change %)","Mkt Val (Market Value)","Day Chng $ (Day Change $)","Day Chng % (Day Change %)","Cost Basis","Gain $ (Gain/Loss $)","Gain % (Gain/Loss %)","Ratings","Reinvest?","Reinvest Capital Gains?","% of Acct (% of Account)","Asset Type",',
  '"LOSS","EXAMPLE FALLING CO","10","100.00","-1","-1%","$1,000.00","-$10.00","-1%","$3,500.00","-$2,500.00","-71%","C","No","N/A","90%","Equity",',
  '"Cash & Cash Investments","--","--","--","--","--","$100.00","$0.00","0%","--","--","--","--","--","--","10%","Cash and Money Market",',
  '"Positions Total","","--","--","--","--","$1,100.00","-$10.00","-1%","$3,500.00","-$2,500.00","-71%","--","--","--","--","--",',
].join('\n');
const ETRADE = [
  'Account Summary',
  'Account,Net Account Value,Total Gain $,Total Gain %',
  '"Traditional IRA -4321",1250.00,250.00,25.00',
  '',
  'View Summary - Performance',
  "Symbol,Last Price $,Change $,Change %,Day's Gain $,Qty #,Price Paid $,Total Gain $,Total Gain %,Value $",
  'EXMP,50.00,0.10,0.2,1.0000,20.0000,40.00,200.0000,25.0000,1000.0000',
  'CASH,,,,,,,,,250.00,',
  'TOTAL,,,,1.00,,800.00,200.00,25.00,1250.00,',
  '',
  'Generated at Mar 05 2026 04:00 PM ET',
].join('\n');

test('positions files from Fidelity, Schwab and E*Trade are read, without counting a BrokerageLink twice', () => {
  const fidelity = readPositions(FIDELITY);
  assert.equal(fidelity.brokerage, 'fidelity');
  assert.equal(fidelity.asOf, '2026-03-05');
  assert.deepEqual(
    fidelity.accounts.map((a) => [a.label, a.last4, a.positions.length, a.total]),
    [
      ['Individual', '2222', 2, 10000],
      ['EXAMPLE CORP 401(K) PLAN', '0001', 1, 2000],
      ['BrokerageLink', '3333', 2, 29800],
    ]
  );
  assert.equal(fidelity.skipped.length, 1, "the plan's BrokerageLink line is left out");
  const schwab = readPositions(SCHWAB);
  assert.equal(schwab.asOf, '2026-03-05');
  assert.deepEqual(schwab.accounts.map((a) => [a.label, a.last4, a.total]), [['Individual ...789', '789', 1100]]);
  assert.equal(schwab.accounts[0].positions[0].costBasis, 3500);
  const etrade = readPositions(ETRADE);
  assert.equal(etrade.asOf, '2026-03-05');
  assert.deepEqual(etrade.accounts.map((a) => [a.label, a.last4, a.positions.length, a.total]), [['Traditional IRA', '4321', 2, 1250]]);
  assert.equal(etrade.accounts[0].positions[0].costBasis, 800);
  assert.throws(() => readPositions('Date,Description,Amount\n01/02/2026,COFFEE,-4.00'), /positions download/);
});

test('holdings and accounts are sorted into kinds from their names', () => {
  assert.equal(guessClass('SPAXX', 'HELD IN MONEY MARKET'), 'cash');
  assert.equal(guessClass('912800AA1', 'UNITED STATES TREAS BILL 0% 01/01/2030'), 'bond');
  assert.equal(guessClass('TDF40', 'TARGETRETIREMENT2040'), 'target_date');
  assert.equal(guessClass('EXIF', 'EXAMPLE INTERNATIONAL INDEX FUND'), 'intl_stock');
  assert.equal(guessClass('EXBM', 'INTERNATIONAL EXAMPLE MACHS'), 'us_stock', 'a company named International is still a US stock');
  assert.equal(guessClass('EXCW', 'EXAMPLE WORLD HLDGS INC'), 'us_stock');
  assert.ok(isFund('EXIX', 'EXAMPLE 500 INDEX FUND'), "a fund isn't one company's risk");
  assert.ok(!isFund('EXMP', 'EXAMPLE WIDGETS INC'));
  const cases = [
    ['BrokerageLink (1234)', 'Fidelity Investments', '401k'],
    ['BrokerageLink Roth (1234)', 'Fidelity Investments', 'roth_401k'],
    ['EXCESS SAVINGS PLAN (1234)', 'Fidelity Investments', 'deferred_comp'],
    ['Health Savings Account (1234)', 'Fidelity Investments', 'hsa'],
    ['Example Personal Pension Plan (1234)', 'Fidelity Investments', 'pension'],
    ['Share Units (RSU)', 'Example at Work (StockPlan)', 'espp'],
    ['Joint JTWROS (1234)', 'E*Trade', 'brokerage'],
    ['Traditional IRA (1234)', 'E*Trade', 'ira'],
    ['Individual ...789 (789)', 'Charles Schwab US', 'brokerage'],
    ['Premium Savings (1234)', 'E*Trade', null],
    ['Everyday Checking', 'Example Bank', null],
  ];
  for (const [name, institution, kind] of cases) assert.equal(guessInvestType(name, institution), kind, name);
  assert.equal(guessKind('Premium Savings'), 'savings');
});

test('positions are matched to accounts, saved, and show what the invested money is in', async () => {
  const { id: individual } = await post('/api/wealth/accounts', { name: 'Individual (2222)', institution: 'Fidelity', investType: 'brokerage', holder: 'me', balance: 9000, day: daysAgo(2) });
  const { id: plan } = await post('/api/wealth/accounts', { name: 'EXAMPLE CORP 401(K) PLAN (7777)', investType: '401k', holder: null, balance: 2000 });
  const seen = await post('/api/wealth/positions/inspect', { fileName: 'positions.csv', text: FIDELITY });
  assert.deepEqual(
    seen.accounts.map((a) => a.match),
    [individual, plan, null],
    'by last four digits, then by name'
  );
  await assert.rejects(post('/api/wealth/positions', { text: FIDELITY, assign: { 0: individual, 1: individual } }), { status: 400 });
  const saved = await post('/api/wealth/positions', { text: FIDELITY, assign: { 0: individual, 1: plan, 2: 'new' } });
  assert.deepEqual(saved, { accounts: 3, positions: 5, asOf: '2026-03-05' });

  let wealth = await get('/api/wealth');
  const link = wealth.accounts.find((a) => a.name === 'BrokerageLink (3333)');
  assert.ok(link, 'a new account is added for the BrokerageLink');
  assert.equal(link.investType, '401k', 'with the kind its name suggests');
  assert.equal(link.balance, 29800);
  // A typed-in account keeps a newer balance than the file's.
  assert.equal(wealth.accounts.find((a) => a.id === individual).balance, 9000);
  assert.deepEqual(wealth.accounts.find((a) => a.id === individual).positions, { count: 2, total: 10000, asOf: '2026-03-05' });

  const top = wealth.topHoldings[0];
  assert.equal(top.symbol, 'EXMP');
  assert.equal(top.value, 25000, 'the same security adds up across accounts');
  assert.deepEqual(top.accounts.sort(), ['BrokerageLink (3333)', 'Individual (2222)']);
  const classes = Object.fromEntries(wealth.allocation.map((c) => [c.key, c.amount]));
  assert.equal(classes.bond, 9800);
  assert.equal(classes.cash, 5000);
  assert.equal(classes.target_date, 2000);
  assert.ok(wealth.checks.some((c) => c.key === 'concentrated:EXMP'), 'one company this big a share is pointed out');
  assert.ok(wealth.checks.some((c) => c.key === 'positions-stale'));
  assert.ok(wealth.checks.some((c) => c.key === 'no-holder' && c.accountIds.includes(plan)));

  // A class chosen by hand applies wherever the security is held; null goes back to the guess.
  await post('/api/wealth/classes', { key: 'EXMP', assetClass: 'other' });
  const { holdings } = await get(`/api/wealth/accounts/${link.id}/holdings`);
  assert.deepEqual(
    holdings.map((h) => [h.symbol, h.assetClass, h.chosen]),
    [
      ['EXMP', 'other', true],
      ['912800AA1', 'bond', false],
    ]
  );
  await post('/api/wealth/classes', { key: 'EXMP', assetClass: null });
  wealth = await get('/api/wealth');
  assert.equal(wealth.topHoldings[0].assetClass, 'us_stock');

  // A later file replaces an account's positions; a loss in a taxable account is pointed out.
  const { id: schwab } = await post('/api/wealth/accounts', { name: 'Individual ...789 (789)', investType: 'brokerage', holder: 'me', balance: 1100 });
  const again = await post('/api/wealth/positions/inspect', { text: SCHWAB });
  assert.equal(again.accounts[0].match, schwab);
  await post('/api/wealth/positions', { text: SCHWAB, assign: { 0: schwab } });
  await post('/api/wealth/positions', { text: SCHWAB, assign: { 0: schwab } });
  assert.equal((await get(`/api/wealth/accounts/${schwab}/holdings`)).holdings.length, 2);
  wealth = await get('/api/wealth');
  const losses = wealth.checks.find((c) => c.key === 'taxable-losses');
  assert.ok(losses && /\$2,500/.test(losses.title), 'losses in a taxable account');
  await assert.rejects(post('/api/wealth/positions/inspect', { text: 'not,a\npositions,file' }), { status: 400 });
});

test("an investment account's own transactions stay out of Review, and its kind can be taken from its name", async () => {
  const day = daysAgo(5);
  const csv = ['Date,Description,Amount', `${day.slice(5, 7)}/${day.slice(8)}/${day.slice(0, 4)},DIVIDEND RECEIVED EXAMPLE FUND,3.21`, ''].join('\n');
  await post('/api/bank/import', { content: csv, fileName: 'hsa.csv', newAccount: { name: 'Health Savings Account (6543)', kind: 'savings', owner: 'mixed' } });
  const hsa = (await get('/api/bank/accounts')).accounts.find((a) => a.name === 'Health Savings Account (6543)').id;
  const inReview = async () => (await get('/api/bank/transactions?review=1&preset=all')).transactions.filter((t) => t.accountId === hsa).length;
  assert.equal(await inReview(), 1);

  const suggested = (await get('/api/wealth')).accounts.find((a) => a.id === hsa);
  assert.equal(suggested.suggestedType, 'hsa');
  assert.deepEqual(await post('/api/wealth/suggestions', { ids: [hsa] }), { changed: 1 });
  const changed = (await get('/api/wealth')).accounts.find((a) => a.id === hsa);
  assert.equal(changed.kind, 'investment');
  assert.equal(changed.investType, 'hsa');
  assert.equal(changed.suggestedType, null);
  assert.equal(await inReview(), 0, 'dividends and contributions inside it are not spending');
});
