// A foundation's dashboard: gifts, grants and moves to and from investments sorted
// apart, this year's totals, the five-year calendar and investment growth. Made-up data.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase } = require('../server/db');
const { foundationService } = require('../server/dist/foundation/service');

test('a foundation: growth, grants, gifts and the five-year calendar', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-foundation-'));
  const db = openDatabase(path.join(dir, 'orders.db'));
  try {
    const raw = db.raw;
    const at = '2026-01-01T00:00:00Z';
    const fund = Number(raw.prepare("INSERT INTO entities (name, kind, activity, created_at) VALUES ('Sample Family Foundation', 'other', 'foundation', ?)").run(at).lastInsertRowid);
    const bank = Number(
      raw.prepare("INSERT INTO bank_accounts (name, kind, owner, balance, balance_date, entity_id, created_at) VALUES ('Checking', 'checking', 'business', 3000, '2026-11-20', ?, ?)").run(fund, at)
        .lastInsertRowid,
    );
    const broker = Number(
      raw.prepare("INSERT INTO bank_accounts (name, kind, owner, balance, balance_date, entity_id, created_at) VALUES ('Brokerage', 'investment', 'business', 52000, '2026-11-20', ?, ?)").run(fund, at)
        .lastInsertRowid,
    );
    raw
      .prepare("INSERT INTO account_balances (account_id, day, balance, source) VALUES (?, '2025-12-15', 45000, 'feed'), (?, '2026-06-01', 50000, 'feed'), (?, '2026-11-20', 52000, 'feed')")
      .run(broker, broker, broker);
    raw
      .prepare("INSERT INTO holdings (account_id, as_of, symbol, description, value, cost_basis, source, created_at) VALUES (?, '2026-11-20', 'IDX', 'Sample index fund', 52000, 40000, 'feed', ?)")
      .run(broker, at);
    const tx = raw.prepare(`INSERT INTO bank_transactions (account_id, posted, amount, description, kind, category, entity_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    tx.run(bank, '2020-05-01', 1000, 'Deposit', 'transfer', 'Owner Contribution', fund, at, at); // older than the calendar
    tx.run(bank, '2024-01-10', 40000, 'Deposit', 'transfer', 'Owner Contribution', fund, at, at);
    tx.run(bank, '2024-03-11', -2500, 'Check', 'normal', 'Charitable donations', fund, at, at);
    tx.run(bank, '2024-11-06', -35000, 'Check', 'transfer', null, fund, at, at);
    tx.run(bank, '2026-02-03', 6000, 'Deposit', 'transfer', null, fund, at, at);
    tx.run(bank, '2026-03-01', -1500, 'Check', 'normal', 'Charitable donations', fund, at, at);
    tx.run(bank, '2026-04-14', -149, 'IRS', 'normal', 'Taxes & Licenses', fund, at, at);
    tx.run(bank, '2026-05-01', -10, 'Fee', 'ignored', 'Bank & Card Fees', fund, at, at);

    const s = foundationService({ db: raw, today: () => '2026-11-22' }).summary(fund);
    assert.equal(s.investments.value, 52000);
    assert.equal(s.investments.gain, 12000);
    assert.deepEqual(s.investments.startOfYear, { day: '2025-12-15', value: 45000 });
    assert.equal(s.investments.changeThisYear, 7000);
    assert.equal(s.cash, 3000);
    assert.deepEqual(s.ytd, { gift: 0, grant: 1500, toInvest: 0, fromInvest: 6000, expense: 149, income: 0 });
    assert.equal(s.allTime.gift, 41000);
    assert.deepEqual(
      s.years.map((y) => y.year),
      [2022, 2023, 2024, 2025, 2026],
    );
    assert.deepEqual(s.years[2].totals, { gift: 40000, grant: 2500, toInvest: 35000, fromInvest: 0, expense: 0, income: 0 });
    assert.equal(s.transactions.length, 7, 'the ignored fee is left out');
    assert.equal(s.payoutGuide.amount, 2750);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
