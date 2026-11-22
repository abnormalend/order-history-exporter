// Guests: one row per guest across their stays, relay emails marked, "don't contact"
// kept out of the export, and one business's guests on their own. Made-up data only.
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
let cabins;

const call = (route, options = {}) => fetch(`${base}${route}`, { ...options, headers: { cookie, 'x-requested-with': 'expense-hub', ...(options.body ? { 'content-type': 'application/json' } : {}) } });
const get = async (route) => (await call(route)).json();

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-guests-'));
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
  cabins = Number(raw.prepare("INSERT INTO entities (name, kind, activity, created_at) VALUES ('Sample Cabins LLC', 'rental', 'str', ?)").run(at).lastInsertRowid);
  const other = Number(raw.prepare("INSERT INTO entities (name, kind, activity, created_at) VALUES ('Other Rentals LLC', 'rental', 'str', ?)").run(at).lastInsertRowid);
  raw.prepare("INSERT INTO stay_properties (id, name, synced_at, entity_id) VALUES ('p-cabin', 'Cabin', ?, ?), ('p-loft', 'Loft', ?, ?)").run(at, cabins, at, other);
  const stay = raw.prepare(
    `INSERT INTO stays (id, platform, property_id, status, arrival, departure, nights, guest_first, guest_last, guest_email, guest_phone, guest_location, guest_total, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // Pat came twice: once through Airbnb (relay email), once direct with a real one.
  stay.run('s1', 'airbnb', 'p-cabin', 'accepted', '2026-02-01', '2026-02-04', 3, 'Pat', 'Example', 'pat.x1@guest.airbnb.com', '+1 (555) 010-0001', 'Springfield, IL', 600, at);
  stay.run('s2', 'direct', 'p-cabin', 'accepted', '2026-06-10', '2026-06-12', 2, 'Pat', 'Example', 'pat@example.com', '555-010-0001', 'Springfield, IL', 400.5, at);
  stay.run('s3', 'homeaway', 'p-cabin', 'accepted', '2026-03-05', '2026-03-07', 2, 'Lee', 'Sample', 'lee@example.org', null, 'Riverton, WY', 300, at);
  stay.run('s4', 'airbnb', 'p-cabin', 'cancelled', '2026-04-01', '2026-04-03', 2, 'Sam', 'Gone', 'sam@example.net', null, null, 0, at);
  stay.run('s5', 'booking', 'p-loft', 'accepted', '2099-01-01', '2099-01-03', 2, 'Kim', 'Later', 'kim@example.com', null, 'Lakeview, OR', 250, at);
});

after(async () => {
  await app.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('one row per guest, newest details first', async () => {
  const { guests } = await get('/api/guests');
  assert.deepEqual(
    guests.map((g) => [g.name, g.stays, g.nights, g.spent, g.platforms.join('+'), g.upcoming]),
    [
      ['Kim Later', 1, 2, 250, 'booking', true],
      ['Pat Example', 2, 5, 1000.5, 'airbnb+direct', false],
      ['Lee Sample', 1, 2, 300, 'vrbo', false],
    ],
    'the cancelled stay is left out',
  );
  const pat = guests.find((g) => g.name === 'Pat Example');
  assert.equal(pat.email, 'pat@example.com', 'a real address wins over the Airbnb relay');
  assert.equal(pat.emailRelay, false);
  assert.equal(pat.location, 'Springfield, IL');
});

test("one business's guests, and don't-contact marks", async () => {
  const { guests } = await get(`/api/guests?entity=${cabins}`);
  assert.deepEqual(guests.map((g) => g.name).sort(), ['Lee Sample', 'Pat Example']);
  const lee = guests.find((g) => g.name === 'Lee Sample');
  const marked = await call('/api/guests/mark', { method: 'POST', body: JSON.stringify({ key: lee.key, noContact: true, note: 'Asked not to be emailed' }) });
  assert.equal(marked.status, 200);
  const csv = await (await call(`/api/guests.csv?entity=${cabins}`)).text();
  assert.match(csv, /^﻿?Name,Email,/);
  assert.match(csv, /Pat Example,pat@example\.com,,555-010-0001,"Springfield, IL",Airbnb, Direct|Pat Example,pat@example\.com,,555-010-0001,"Springfield, IL","Airbnb, Direct"/);
  assert.doesNotMatch(csv, /Lee Sample/, "don't-contact guests are left out");
  const everyone = await (await call(`/api/guests.csv?entity=${cabins}&all=1`)).text();
  assert.match(everyone, /Lee Sample.*yes,Asked not to be emailed/);
  const bad = await call('/api/guests/mark', { method: 'POST', body: JSON.stringify({ key: 'nope', noContact: true }) });
  assert.equal(bad.status, 400);
});
