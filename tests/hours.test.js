// Material participation hours: turnovers worked out from stays, the ones a paid cleaner
// did left out, repeating work, purchases the owner installed, and the yearly tests.
// Made-up data only.
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

const call = (route, options = {}) => fetch(`${base}${route}`, { ...options, headers: { cookie, 'x-requested-with': 'expense-hub', ...(options.body ? { 'content-type': 'application/json' } : {}) } });
const post = async (route, body = {}) => {
  const response = await call(route, { method: 'POST', body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error), { status: response.status });
  return data;
};
const get = async (route) => (await call(route)).json();

let entityId;
let logId;
let kidLogId;
let pat;
let sam;
let lee;
const entries = async (query = '') => get(`/api/hours/entries?log=${logId}&limit=500${query}`);

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-hours-'));
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

  const raw = db.raw;
  const at = '2026-01-01T00:00:00Z';
  entityId = Number(raw.prepare("INSERT INTO entities (name, kind, activity, created_at) VALUES ('Sample Cabins LLC', 'rental', 'str', ?)").run(at).lastInsertRowid);
  raw.prepare("INSERT INTO stay_properties (id, name, synced_at, entity_id) VALUES ('p-cabin', 'Cabin', ?, ?), ('p-cottage', 'Cottage', ?, ?)").run(at, entityId, at, entityId);
  const stay = raw.prepare("INSERT INTO stays (id, platform, property_id, status, arrival, departure, nights, synced_at) VALUES (?, 'airbnb', ?, ?, ?, ?, 2, ?)");
  stay.run('s1', 'p-cabin', 'accepted', '2026-03-08', '2026-03-10', at);
  stay.run('s2', 'p-cabin', 'accepted', '2026-04-29', '2026-05-01', at);
  stay.run('s3', 'p-cabin', 'cancelled', '2026-05-10', '2026-05-12', at);
  stay.run('s4', 'p-cabin', 'accepted', '2099-01-03', '2099-01-05', at);
  stay.run('c1', 'p-cottage', 'accepted', '2026-05-30', '2026-06-01', at);

  await post('/api/bank/import', {
    content: [
      'Date,Description,Amount',
      '05/03/2026,Zelle payment to Example Helper for Cleaning,-270.00',
      '04/02/2026,LOWES #00001,-3143.66',
      '04/03/2026,LOWES #00001,-20.00',
      '04/04/2026,CITY WATER,-80.00',
    ].join('\n'),
    fileName: 'checking.csv',
    newAccount: { name: 'Cabins checking', kind: 'checking', owner: 'business' },
  });
  raw.prepare('UPDATE bank_transactions SET entity_id = ?').run(entityId);
  raw.prepare("UPDATE bank_transactions SET category = 'Garden & Outdoor' WHERE description LIKE 'LOWES%'").run();
  raw.prepare("UPDATE bank_transactions SET category = 'Cleaning & Maintenance Services' WHERE description LIKE 'Zelle%'").run();
});

after(async () => {
  await app.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('two logs, each with its own people', async () => {
  const first = await post('/api/hours/logs', { name: 'Pat & Sam', people: ['Pat', 'Sam'] });
  logId = first.id;
  const second = await post('/api/hours/logs', { name: 'Lee', people: ['Lee'] });
  kidLogId = second.id;
  const people = second.logs.flatMap((l) => l.people);
  [pat, sam, lee] = ['Pat', 'Sam', 'Lee'].map((n) => people.find((p) => p.name === n).id);
  assert.deepEqual(
    second.logs.map((l) => [l.name, l.people.map((p) => p.name)]),
    [
      ['Pat & Sam', ['Pat', 'Sam']],
      ['Lee', ['Lee']],
    ],
  );
  await assert.rejects(post('/api/hours/logs', { name: 'pat & sam' }), /already here/);
});

test('turnover tasks become hours after every past check-out', async () => {
  await post('/api/hours/tasks', { personId: pat, propertyId: null, task: 'Clean the house', hours: 1.5 });
  await post('/api/hours/tasks', { personId: pat, propertyId: 'p-cabin', task: 'Spa care', hours: 0.75 });
  const list = await entries();
  // s1 and s2 at the cabin (both tasks) and c1 at the cottage (cleaning only); not the
  // cancelled stay or the one still to come.
  assert.equal(list.total, 5);
  assert.equal(list.hours, 6);
  assert.ok(list.entries.every((e) => e.source === 'turnover' && e.entityId === entityId));
  assert.deepEqual([...new Set(list.entries.map((e) => e.day))].sort(), ['2026-03-10', '2026-05-01', '2026-06-01']);
});

test('a turnover a paid cleaner did is left out', async () => {
  const { payments } = await get('/api/hours/help');
  assert.equal(payments.length, 1, 'only the cleaning payment is asked about');
  const helper = payments[0];
  assert.equal(helper.looksLikeCleaning, true);
  assert.equal(helper.stays[0].id, 's2', 'the check-out just before the payment comes first');
  await post(`/api/hours/help/${helper.transactionId}`, { isHelp: true, stayId: 's2', hours: 4 });
  const list = await entries();
  assert.equal(list.total, 3);
  assert.ok(!list.entries.some((e) => e.day === '2026-05-01'));
  await post(`/api/hours/help/${helper.transactionId}/forget`);
  assert.equal((await entries()).total, 5, 'forgetting the answer brings them back');
  await post(`/api/hours/help/${helper.transactionId}`, { isHelp: true, stayId: 's2', hours: 4 });
});

test('changed and removed entries stay that way when hours are worked out again', async () => {
  const list = await entries();
  const cottage = list.entries.find((e) => e.day === '2026-06-01');
  const spa = list.entries.find((e) => e.task === 'Spa care');
  await post(`/api/hours/entries/${cottage.id}`, { personId: pat, propertyId: 'p-cottage', day: cottage.day, task: 'Clean the house', hours: 2 });
  await post(`/api/hours/entries/${spa.id}/delete`);
  // Changing the task works the hours out again.
  const { tasks } = await get('/api/hours');
  const clean = tasks.find((t) => t.task === 'Clean the house');
  await post(`/api/hours/tasks/${clean.id}`, { personId: pat, propertyId: null, task: 'Clean the house', hours: 1 });
  const after = await entries();
  assert.deepEqual(
    after.entries.map((e) => [e.day, e.task, e.hours, e.edited]),
    [
      ['2026-06-01', 'Clean the house', 2, true],
      ['2026-03-10', 'Clean the house', 1, false],
    ],
  );
  assert.equal((await entries('&removed=1')).total, 1, 'the removed one is kept aside');
  await post(`/api/hours/entries/${spa.id}/reset`);
  assert.equal((await entries()).total, 3, 'and can be put back');
});

test('weekly mowing between two dates', async () => {
  await post('/api/hours/recurring', { personId: pat, entityId, propertyId: 'p-cabin', task: 'Mow the lawn', hours: 3, everyDays: 7, start: '2026-04-02', end: '2026-09-07' });
  const mowing = await entries('&source=recurring');
  assert.equal(mowing.total, 23);
  assert.equal(mowing.hours, 69);
  assert.equal(mowing.entries.at(-1).day, '2026-04-02');
  assert.equal(mowing.entries[0].day, '2026-09-03');
  await assert.rejects(post('/api/hours/recurring', { personId: pat, entityId, task: 'Backwards', hours: 1, start: '2026-05-01', end: '2026-04-01' }), /before the start/);
});

test('business purchases are asked about, and an installed one adds hours', async () => {
  const open = await get('/api/hours/purchases');
  assert.deepEqual(
    open.purchases.map((p) => [p.amount, p.category]),
    [[-3143.66, 'Garden & Outdoor']],
    'small buys and other categories are not asked about',
  );
  const tx = open.purchases[0].transactionId;
  await assert.rejects(post(`/api/hours/purchases/${tx}`, { installed: true }), /who put it in/);
  await post(`/api/hours/purchases/${tx}`, { installed: true, personId: pat, hours: 3, task: 'Assembled the mower' });
  assert.equal((await get('/api/hours/purchases')).total, 0);
  const answered = await get('/api/hours/purchases?answered=1');
  assert.equal(answered.purchases[0].entry.task, 'Assembled the mower');
  const bought = await entries('&source=purchase');
  assert.deepEqual(
    bought.entries.map((e) => [e.day, e.hours, e.entityId]),
    [['2026-04-02', 3, entityId]],
  );
});

test('the yearly tests, each log on its own', async () => {
  await post('/api/hours/entries', { personId: sam, propertyId: 'p-cottage', day: '2026-07-01', task: 'Painted the deck', hours: 20 });
  await post('/api/hours/entries', { personId: sam, propertyId: 'p-cottage', day: '2026-07-02', task: 'Painted the deck', hours: 20 });
  const imported = await post('/api/hours/import', { logId: kidLogId, rows: [{ person: 'Lee', day: '2026-08-01', task: 'Guest messages', hours: 10, property: 'cabin' }] });
  assert.equal(imported.added, 1);
  await assert.rejects(post('/api/hours/import', { logId: kidLogId, rows: [{ person: 'Pat', day: '2026-08-01', task: 'x', hours: 1 }] }), /not in this log/);

  const { businesses } = await get('/api/hours/summary?year=2026');
  const cabins = businesses.find((b) => b.entityId === entityId);
  assert.deepEqual(cabins.help, [{ name: 'Example Helper', hours: 4, visits: 1 }]);
  const [couple, kid] = cabins.logs;
  // Pat: 3.75 turnover hours, 69 mowing, 3 installing; Sam: 40 painting.
  assert.equal(couple.hours, 115.75);
  assert.deepEqual(couple.mostByAnyoneElse, { name: 'Lee', hours: 10 });
  assert.equal(couple.over100AndMost, true);
  assert.equal(couple.over500, false);
  assert.equal(kid.hours, 10);
  assert.equal(kid.over100AndMost, false);
  assert.deepEqual(kid.mostByAnyoneElse, { name: 'Pat', hours: 75.75 });
});

test('hours are checked before they are saved', async () => {
  await assert.rejects(post('/api/hours/entries', { personId: pat, day: '2026-07-01', task: 'Too long', hours: 25 }), /24 hours/);
  await assert.rejects(post('/api/hours/entries', { personId: pat, day: '07/01/2026', task: 'Bad date', hours: 1 }), /YYYY-MM-DD/);
  await assert.rejects(post('/api/hours/tasks', { personId: 9999, propertyId: null, task: 'Nobody', hours: 1 }), /not in a log/);
});
