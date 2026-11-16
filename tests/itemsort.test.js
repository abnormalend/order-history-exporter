// Sorting item names the keyword rules can't place, with Claude stood in for by a fake
// that answers from a list. Made-up data only; nothing is sent anywhere.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase } = require('../server/db');
const { buildApp } = require('../server/dist/app');
const { createClassifier } = require('../server/categories');

let dir;
let db;
let app;
let base;
let cookie;
const asked = [];
// What the stand-in for Claude knows; anything else it isn't sure about.
const answers = { 'Hachiya Kaki, 2 lb bag': 'Grocery', 'Zorblax 3000 thingamajig': null, 'Acme Widget Pro, Blue': 'Tools & Hardware' };

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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-itemsort-'));
  db = openDatabase(path.join(dir, 'orders.db'));
  const itemSorter = async (names, categories) => {
    asked.push({ names, categories });
    return { categories: names.map((n) => answers[n] ?? null), model: 'fake-model' };
  };
  app = buildApp({ db, tokens: { get: () => 'tok', rotate: () => 'tok' }, allowedHosts: () => true, itemSorter });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;
  const setup = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'expense-hub' },
    body: JSON.stringify({ setupCode: 'tok', username: 'owner', password: 'a long test password' }),
  });
  cookie = setup.headers.get('set-cookie').split(';')[0];
  db.saveOrders('amazon', [
    {
      orderId: 'SORT-1',
      date: '2026-10-01',
      total: 60,
      detailRead: true,
      items: [
        { name: 'Organic Sweet Potatoes, 3 lb', price: 5 },
        { name: 'Hachiya Kaki, 2 lb bag', price: 8 },
        { name: 'Zorblax 3000 thingamajig', price: 20 },
        { name: 'Acme Widget Pro, Blue', price: 27 },
      ],
    },
  ]);
});

after(async () => {
  await app.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('everyday produce is recognised by the keyword rules, plurals included', () => {
  const classify = createClassifier([]);
  for (const name of ['Organic Sweet Potatoes, 3 lb', 'Roma Tomatoes', 'Fresh Persimmon', 'Ataulfo Mangoes 4 ct', 'Baby Kale Salad Mix']) assert.equal(classify(name).category, 'Grocery', name);
  assert.equal(classify('Running Shoes Size 10').category, 'Clothing', 'shoes still read as shoe');
});

test('names nothing places are sorted by Claude, unsure ones are left, and your choice still wins', async () => {
  let status = await get('/api/items/auto-sort');
  assert.equal(status.waiting, 3, 'sweet potatoes are already placed by the rules');
  // No API key in this test app, so the page offers Settings; the fake sorter still runs.
  assert.equal(status.hasKey, false);

  const run = await post('/api/items/auto-sort');
  assert.deepEqual([run.asked, run.sortedNow, run.unsureNow], [3, 2, 1]);
  assert.ok(!asked[0].categories.includes('Rental Income'), 'income categories are not offered');
  assert.ok(!asked[0].categories.includes('Refunds & Returns'));
  assert.ok(asked[0].categories.includes('Grocery'));

  const items = (await get('/api/items?limit=50')).items;
  const of = (name) => items.find((i) => i.name === name);
  assert.deepEqual([of('Hachiya Kaki, 2 lb bag').category, of('Hachiya Kaki, 2 lb bag').categorySource], ['Grocery', 'ai']);
  assert.equal(of('Zorblax 3000 thingamajig').category, 'Uncategorized');
  assert.equal(of('Organic Sweet Potatoes, 3 lb').categorySource, 'rule');

  // Nothing is asked twice.
  status = await get('/api/items/auto-sort');
  assert.deepEqual([status.waiting, status.unsure, status.sorted], [0, 1, 2]);
  await post('/api/items/auto-sort');
  assert.equal(asked.length, 1, 'nothing left to ask, so Claude is not called');

  // The user's choice beats Claude's.
  await post('/api/items/category', { name: 'Acme Widget Pro, Blue', category: 'Office Supplies' });
  assert.equal((await get('/api/items?limit=50')).items.find((i) => i.name === 'Acme Widget Pro, Blue').category, 'Office Supplies');

  // Unsure ones can be asked about again, after adding a category that fits.
  answers['Zorblax 3000 thingamajig'] = 'Electronics & Computers';
  const again = await post('/api/items/auto-sort', { retryUnsure: true });
  assert.deepEqual([again.asked, again.sortedNow, again.unsureNow], [1, 1, 0]);
  assert.equal((await get('/api/items?category=Uncategorized&limit=50')).total, 0);
});
