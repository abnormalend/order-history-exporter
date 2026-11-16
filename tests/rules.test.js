// Categories of the user's own for income, and rules made from a bulk change in
// Transactions. Made-up data only.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase } = require('../server/db');
const { buildApp } = require('../server/dist/app');

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
const usDate = (iso) => `${iso.slice(5, 7)}/${iso.slice(8)}/${iso.slice(0, 4)}`;
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const csv = (rows) => ['Date,Description,Amount', ...rows, ''].join('\n');

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-rules-'));
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

test('a category of your own can be income, so money in under it is revenue rather than a refund', async () => {
  // The built-in income categories are marked as income.
  const { categories } = await get('/api/categories');
  assert.equal(categories.find((c) => c.name === 'Rental Income').expenseClass, 'income');
  assert.equal(categories.find((c) => c.name === 'Office Supplies').expenseClass, 'opex');

  await post('/api/bank/import', {
    content: csv([`${usDate(daysAgo(10))},EXAMPLE CLIENT CO PAYMENT 88812,1200.00`, `${usDate(daysAgo(9))},PAPER STORE,-50.00`]),
    fileName: 'biz.csv',
    newAccount: { name: 'Biz checking', kind: 'checking', owner: 'business' },
  });
  const deposit = (await get('/api/bank/transactions?preset=all&q=EXAMPLE%20CLIENT')).transactions[0];

  // Under an expense category, money in is a refund of that spending.
  await post('/api/categories', { name: 'Consulting Fees', scheduleC: null, scheduleE: null });
  await post('/api/bank/transactions/update', { ids: [deposit.id], category: 'Consulting Fees' });
  assert.equal((await get('/api/bank/transactions?preset=all&direction=in')).transactions.length, 0);
  assert.equal((await get('/api/bank/transactions?preset=all&direction=out')).transactions.length, 2);

  // Made income, the same money is revenue: in Transactions and in Profit & loss.
  await post('/api/categories', { name: 'Consulting Fees', scheduleC: null, scheduleE: null, expenseClass: 'income' });
  assert.deepEqual((await get('/api/bank/transactions?preset=all&direction=in')).transactions.map((t) => t.id), [deposit.id]);
  const pl = await get('/api/pl');
  assert.ok(JSON.stringify(pl).includes('Consulting Fees'), 'the category shows in revenue');

  // A new category can be income from the start.
  await post('/api/categories', { name: 'Laundry Machines', scheduleC: null, scheduleE: null, expenseClass: 'income' });
  assert.equal((await get('/api/categories')).categories.find((c) => c.name === 'Laundry Machines').expenseClass, 'income');
});

test('a bulk change can also save a rule, which sorts past and future transactions alike', async () => {
  await post('/api/bank/import', {
    content: csv([
      `${usDate(daysAgo(40))},ACME PROPERTY MGMT 0423 RENT,2100.00`,
      `${usDate(daysAgo(30))},ACME PROPERTY MGMT 0523 RENT,2100.00`,
      `${usDate(daysAgo(20))},ACME PROPERTY MGMT 0623 RENT,2100.00`,
      `${usDate(daysAgo(15))},CORNER CAFE,-9.00`,
    ]),
    fileName: 'rent.csv',
    newAccount: { name: 'Rent checking', kind: 'checking', owner: 'business' },
  });
  const all = (await get('/api/bank/transactions?preset=all&q=ACME')).transactions;
  assert.equal(all.length, 3);
  const { accounts } = await get('/api/bank/accounts');
  const rentAccount = accounts.find((a) => a.name === 'Rent checking').id;

  // Only two are chosen; the rule also sorts the third.
  const { ruleId } = await post('/api/bank/transactions/update', {
    ids: all.slice(0, 2).map((t) => t.id),
    category: 'Rental Income',
    status: 'business',
    rule: { pattern: 'ACME PROPERTY MGMT', accountId: rentAccount },
  });
  assert.ok(ruleId);
  let after = (await get('/api/bank/transactions?preset=all&q=ACME')).transactions;
  assert.ok(after.every((t) => t.category === 'Rental Income' && t.status === 'business'));
  assert.equal(after.filter((t) => t.categorySource === 'rule').length, 1, 'the one not chosen was sorted by the rule');
  assert.ok((await get('/api/bank/rules')).rules.some((r) => r.id === ruleId && r.pattern === 'ACME PROPERTY MGMT' && r.accountId === rentAccount));

  // Future imports are sorted as they arrive.
  await post('/api/bank/import', { content: csv([`${usDate(daysAgo(2))},ACME PROPERTY MGMT 0723 RENT,2100.00`]), fileName: 'rent2.csv', accountId: rentAccount });
  after = (await get('/api/bank/transactions?preset=all&q=ACME')).transactions;
  assert.equal(after.length, 4);
  assert.ok(after.every((t) => t.category === 'Rental Income'));

  // Limited to one account, it leaves the same words elsewhere alone.
  await post('/api/bank/import', { content: csv([`${usDate(daysAgo(2))},ACME PROPERTY MGMT REFUND,5.00`]), fileName: 'other.csv', accountId: accounts.find((a) => a.name === 'Biz checking').id });
  const elsewhere = (await get('/api/bank/transactions?preset=all&q=ACME%20PROPERTY%20MGMT%20REFUND')).transactions[0];
  assert.notEqual(elsewhere.categorySource, 'rule');

  // A pattern needs at least 3 characters.
  await assert.rejects(post('/api/bank/transactions/update', { ids: [after[0].id], category: 'Rental Income', rule: { pattern: 'AC' } }), { status: 400 });
});

test('items with no category can be picked on their own', () => {
  db.saveOrders('ebay', [{ orderId: 'UNCAT-1', date: '2026-01-05', total: 30, detailRead: true, items: [{ name: 'Zqxv mystery part', price: 10 }, { name: 'Printer paper ream', price: 20 }] }]);
  const all = db.listItems({}, { limit: 100 }).items.filter((i) => i.orderId === 'UNCAT-1');
  assert.equal(all.length, 2);
  const picked = db.listItems({ category: ['Uncategorized'] }, { limit: 100 }).items;
  assert.ok(picked.length >= 1);
  assert.ok(picked.every((i) => i.category === 'Uncategorized'));
  assert.ok(picked.some((i) => i.name === 'Zqxv mystery part'));
});
