// PayPal statement PDFs: only money in and out of the PayPal balance comes in, checked
// against the statement's opening and closing balance. Made-up statements and data.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const PDFDocument = require('pdfkit');

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

// A statement laid out the way PayPal's are: the whole account first, then the PayPal
// Balance part, one line of text per line.
function statement({ period, beginning, ending, account, balance, breakAfter = Infinity }) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 30 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
    doc.fontSize(8);
    let y = 40;
    const line = (text) => {
      doc.text(text, 30, y, { lineBreak: false });
      y += 12;
    };
    const top = () => {
      line('ACCOUNT STATEMENTS');
      line('Sample, Pat');
      line('Statement Period PayPal Account ID');
      line(`${period} pat@example.com`);
    };
    const footer = (page) => {
      line('ACCOUNT STATEMENTS');
      line('Sample, Pat');
      line(`Page ${page}`);
    };
    top();
    line('PAYPAL ACCOUNT');
    line('ACCOUNT ACTIVITY');
    line('DATE DESCRIPTION CURRENCY AMOUNT FEES TOTAL*');
    account.forEach((row) => row.forEach(line));
    line('*For each transaction in your Account Activity, the Total equals the amount sent or received, plus or minus any Fees.');
    footer(1);
    doc.addPage();
    y = 40;
    top();
    line('PAYPAL BALANCE ACCOUNT');
    line('BALANCE SUMMARY');
    line('USD');
    line(`Available beginning ${beginning}`);
    line(`Available ending ${ending}`);
    line('ACCOUNT ACTIVITY');
    line('DATE DESCRIPTION CURRENCY AMOUNT FEES TOTAL**');
    let page = 2;
    balance.forEach((row) =>
      row.forEach((text, i) => {
        line(text);
        // A page break that falls inside a row.
        if (i === breakAfter) {
          footer(page++);
          doc.addPage();
          y = 40;
          top();
          line('PAYPAL BALANCE ACCOUNT');
        }
      })
    );
    line('*The difference between your Beginning and Ending Balances may not equal the sum of all of your Account Activity.');
    footer(page);
    doc.end();
  });
}

const june = () => {
  const rows = [
    ['06/21/2026 Mobile Payment: Sam Tenant', 'ID: 1AA00000000000001', 'USD 1,000.00 0.00 1,000.00'],
    ['06/22/202', '6 Mobile Payment: Sam Tenant', 'ID: 1AA00000000000002', 'USD 3,150.00 0.00 3,150.00'],
    ['06/24/202', '6 User Initiated Withdrawal', 'PayPal Balance -3,400.00 USD', 'ID: 1AA00000000000003', 'USD -3,400.00 0.00 -3,400.00'],
  ];
  return statement({
    period: 'Jun 1, 2026 - Jun 30, 2026',
    beginning: '0.00',
    ending: '750.00',
    // Paid with a card: in the whole-account list, never in the balance list.
    account: [
      ['06/14/2026 Express Checkout Payment: Parts Shop, Inc', 'ID: 1AA00000000000009', 'USD -8.80 0.00 -8.80'],
      ['06/14/2026 General Credit Card Deposit', 'ID: 1AA00000000000010', 'Ref ID: 1AA00000000000009', 'USD 8.80 0.00 8.80'],
      ...rows,
    ],
    balance: rows,
  });
};

const july = () =>
  statement({
    period: 'Jul 1, 2026 - Jul 31,',
    beginning: '750.00',
    ending: '612.75',
    account: [],
    breakAfter: 1,
    balance: [
      ['07/05/2026 Express Checkout Payment: Hardware', 'Store Inc.', 'PayPal Balance -75.25 USD', 'ID: 2BB00000000000001', 'USD -75.25 0.00 -75.25'],
      // Paid in Canadian dollars: the balance line is what it cost in dollars.
      ['07/09/202', '6 Mobile Payment: A Friend', 'PayPal Balance -62.00 CAD', 'ID: 2BB00000000000002', 'CAD -79.10 -3.95 -83.05'],
      // Held in pesos, not in the dollar balance.
      ['07/28/2026 General Payment: Someone', 'ID: 2BB00000000000003', 'MXN 0.01 0.00 0.01'],
    ],
  });

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eh-paypal-'));
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
  // The bank the withdrawal went to.
  await post('/api/bank/import', {
    content: 'Date,Description,Debit,Credit\n06/25/2026,PAYPAL TRANSFER,,3400.00\n06/26/2026,HARDWARE STORE,12.00,\n',
    fileName: 'checking.csv',
    newAccount: { name: 'Checking', kind: 'checking', owner: 'business' },
  });
});

after(async () => {
  await app.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('PayPal statements bring in only what moved the PayPal balance', async () => {
  const pdfs = [
    { fileName: 'statement-Jul-2026.pdf', data: await july() },
    { fileName: 'statement-Jun-2026.pdf', data: await june() },
  ];
  const seen = await post('/api/bank/import/inspect', { pdfs });
  assert.equal(seen.type, 'paypal');
  assert.deepEqual(
    seen.statements.map((s) => [s.periodStart, s.periodEnd, s.count, s.balanced]),
    [
      ['2026-06-01', '2026-06-30', 3, true],
      ['2026-07-01', '2026-07-31', 2, true],
    ]
  );
  assert.deepEqual(seen.statements[1].skipped.map((s) => s.reason), ['Held in MXN, not dollars']);
  // Paid with a card through PayPal: listed, not imported.
  assert.deepEqual(seen.statements[0].paidElsewhere, [{ posted: '2026-06-14', description: 'Express Checkout Payment: Parts Shop, Inc', amount: -8.8, from: 'card' }]);
  assert.equal(seen.balance, 612.75);
  assert.equal(seen.accountId, null);

  const done = await post('/api/bank/import', { pdfs, newAccount: { name: 'PayPal', kind: 'other', owner: 'mixed' } });
  assert.equal(done.added, 5);
  assert.equal(done.transfers, 1, 'the withdrawal pairs with the bank deposit');
  const rows = (await get('/api/bank/transactions?kind=all&preset=all&limit=200')).transactions.filter((t) => t.account === 'PayPal');
  assert.deepEqual(rows.map((t) => [t.posted, t.amount]).sort(), [
    ['2026-06-21', 1000],
    ['2026-06-22', 3150],
    ['2026-06-24', -3400],
    ['2026-07-05', -75.25],
    ['2026-07-09', -62],
  ]);
  assert.ok(rows.some((t) => t.description === 'Express Checkout Payment: Hardware Store Inc.'), 'a wrapped description is joined');
  assert.ok(!rows.some((t) => /Parts Shop|Credit Card Deposit/.test(t.description)), 'card-paid rows are left out');
  assert.equal(rows.find((t) => t.amount === -3400).kind, 'transfer');
  const paypal = (await get('/api/bank/accounts')).accounts.find((a) => a.name === 'PayPal');
  assert.equal(paypal.balance, 612.75);

  // The same statements again: recognised, nothing doubled.
  assert.equal((await post('/api/bank/import/inspect', { pdfs })).accountId, paypal.id);
  const again = await post('/api/bank/import', { pdfs, accountId: paypal.id });
  assert.deepEqual([again.added, again.skipped], [0, 5]);
});

test('a month when the PayPal balance was never used has nothing to import, and says why', async () => {
  const data = await statement({
    period: 'Mar 1, 2025 - Mar 31, 2025',
    beginning: '0.00',
    ending: '0.00',
    account: [
      // Paid from a bank account, in another currency.
      ['03/02/2025 Mobile Payment: A Friend', 'EXAMPLE BANK, NA -', 'Checking x-0000 9.98', 'USD', '9.98 USD X 1.3345 (Exchange Rate) 13.32', 'CAD', 'ID: 3CC00000000000001', 'CAD -12.00 -1.32 -13.32'],
      ['03/14/2025 Express Checkout Payment: Car Parts,', 'INC', 'ID: 3CC00000000000002', 'USD -4.80 0.00 -4.80'],
      ['03/14/2025 General Credit Card Deposit', 'ID: 3CC00000000000003', 'Ref ID: 3CC00000000000002', 'USD 4.80 0.00 4.80'],
    ],
    balance: [],
  });
  const seen = await post('/api/bank/import/inspect', { pdfs: [{ fileName: 'statement-Mar-2025.pdf', data }] });
  assert.equal(seen.count, 0);
  assert.equal(seen.statements[0].balanced, true);
  assert.deepEqual(seen.statements[0].paidElsewhere, [
    { posted: '2025-03-02', description: 'Mobile Payment: A Friend', amount: -9.98, from: 'bank' },
    { posted: '2025-03-14', description: 'Express Checkout Payment: Car Parts, INC', amount: -4.8, from: 'card' },
  ]);
});

test('a PDF that is not a PayPal statement is turned away', async () => {
  const other = await new Promise((resolve) => {
    const doc = new PDFDocument();
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
    doc.text('An invoice');
    doc.end();
  });
  await assert.rejects(post('/api/bank/import/inspect', { pdfs: [{ fileName: 'invoice.pdf', data: other }] }), /not a PayPal account statement/);
  await assert.rejects(post('/api/bank/import/inspect', { pdfs: [{ fileName: 'notes.pdf', data: Buffer.from('hello').toString('base64') }] }), /not a PDF/);
});
