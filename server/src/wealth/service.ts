// Wealth: every account the household owns, investment and retirement accounts
// included, with net worth over time. Balances come from SimpleFIN, from files, or are
// typed in for accounts nothing can import (a pension, deferred compensation, an ESPP).
// The owner's household only: family members' accounts stay in their own My money.
import type { DatabaseSync } from 'node:sqlite';
import type { BankStore } from '../bank/store';
import { HttpError } from '../params';
import { ASSET_CLASSES, guessClass, guessHolder, guessInvestType, isFund, readPositions } from './positions';
import type { AssetClass, PositionsFile } from './positions';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

// How money in an account is taxed when it's spent, which the retirement model needs.
export const TREATMENTS = {
  cash: 'Cash',
  taxable: 'Taxable',
  pre_tax: 'Pre-tax',
  roth: 'Roth',
  hsa: 'Health savings',
  education: 'Education',
  owed: 'Owed',
} as const;
export type Treatment = keyof typeof TREATMENTS;

export const INVEST_TYPES: Record<string, { label: string; treatment: Treatment }> = {
  brokerage: { label: 'Brokerage', treatment: 'taxable' },
  '401k': { label: '401(k)', treatment: 'pre_tax' },
  roth_401k: { label: 'Roth 401(k)', treatment: 'roth' },
  '403b': { label: '403(b)', treatment: 'pre_tax' },
  '457b': { label: '457(b)', treatment: 'pre_tax' },
  ira: { label: 'Traditional IRA', treatment: 'pre_tax' },
  rollover_ira: { label: 'Rollover IRA', treatment: 'pre_tax' },
  sep_ira: { label: 'SEP IRA', treatment: 'pre_tax' },
  roth_ira: { label: 'Roth IRA', treatment: 'roth' },
  hsa: { label: 'HSA', treatment: 'hsa' },
  '529': { label: '529 plan', treatment: 'education' },
  pension: { label: 'Pension', treatment: 'pre_tax' },
  deferred_comp: { label: 'Deferred compensation', treatment: 'pre_tax' },
  espp: { label: 'ESPP or company stock', treatment: 'taxable' },
  annuity: { label: 'Annuity', treatment: 'pre_tax' },
  cash_value_life: { label: 'Cash value life insurance', treatment: 'taxable' },
  other: { label: 'Other investment', treatment: 'taxable' },
};
export const HOLDERS = ['me', 'spouse', 'joint'] as const;
export type Holder = (typeof HOLDERS)[number];

// A typed-in balance this old asks to be brought up to date; a feed this old has stopped.
const MANUAL_STALE_DAYS = 90;
const FEED_STALE_DAYS = 10;
const HISTORY_POINTS = 260;
// Positions this old ask for a fresh download. A holding this big a share of invested
// money, positions this far from the account's balance, or losses this size in a
// taxable account are pointed out.
const POSITIONS_STALE_DAYS = 45;
const CONCENTRATED = 0.1;
const DRIFT_SHARE = 0.03;
const DRIFT_DOLLARS = 1000;
const LOSS_WORTH_NOTING = 1000;
// Kinds of account worth a promised amount rather than holdings, so no positions are expected.
const NO_POSITIONS = new Set(['pension', 'annuity', 'cash_value_life']);
const BROKERAGE_NAMES: Record<PositionsFile['brokerage'], string> = { fidelity: 'Fidelity Investments', schwab: 'Charles Schwab', etrade: 'E*Trade' };

// A security's asset class chosen by hand is kept by its symbol, or by its name when it has none.
export const classKey = (symbol: string | null, description: string) => (symbol ? symbol.trim().toUpperCase() : `name:${description.trim().toUpperCase()}`);
// The last four digits an account's name ends with, as feeds write it: "Brokerage (1234)".
const nameDigits = (name: string) => (name.match(/\(\s*\.*(\d{3,4})\s*\)\s*$/) || [])[1] ?? null;
const bareName = (name: string) => name.replace(/\s*\(\s*\.*\d{3,4}\s*\)\s*$/, '').replace(/\s+/g, ' ').trim().toLowerCase();

export interface Holding {
  id: number;
  accountId: number;
  asOf: string;
  symbol: string | null;
  description: string;
  quantity: number | null;
  price: number | null;
  value: number;
  costBasis: number | null;
  gain: number | null;
  assetClass: AssetClass;
  chosen: boolean;
}
export interface Check {
  key: string;
  title: string;
  detail: string;
  accountIds: number[];
}

const today = () => new Date().toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const round = (n: number) => Math.round(n * 100) / 100;
const wholeDollars = (n: number) => `${n < 0 ? '-' : ''}$${Math.round(Math.abs(n)).toLocaleString('en-US')}`;

function treatmentOf(kind: string, investType: string | null): Treatment {
  if (kind === 'credit' || kind === 'loan') return 'owed';
  if (kind === 'investment') return INVEST_TYPES[investType ?? 'other']?.treatment ?? 'taxable';
  return 'cash';
}
// What an account adds to net worth: money owed counts against it, whatever sign the
// bank reports it with.
const worth = (kind: string, balance: number) => (kind === 'credit' || kind === 'loan' ? -Math.abs(balance) : balance);

export function wealthService({ db, bank }: { db: DatabaseSync; bank: BankStore }) {
  // Keeps a balance in the history: one per account per day, the latest wins.
  const remember = db.prepare(
    `INSERT INTO account_balances (account_id, day, balance, source) VALUES (?, ?, ?, ?)
     ON CONFLICT (account_id, day) DO UPDATE SET balance = excluded.balance, source = excluded.source`
  );

  // Balances changed elsewhere (a sync, a loan payment) join the history when next seen.
  function catchUp() {
    db.prepare(
      `INSERT INTO account_balances (account_id, day, balance, source)
       SELECT a.id, COALESCE(a.balance_date, substr(a.created_at, 1, 10)), a.balance, 'feed' FROM bank_accounts a
       WHERE a.balance IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM account_balances b WHERE b.account_id = a.id AND b.day = COALESCE(a.balance_date, substr(a.created_at, 1, 10)))`
    ).run();
  }

  const rowOf = (id: number) => {
    const row = db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new HttpError(404, 'That account is not here.');
    if (row.person_id != null) throw new HttpError(400, "That account is a family member's.");
    return row;
  };

  // Every account's latest positions, each with its asset class.
  function holdingsByAccount(only?: number) {
    const chosen = new Map((db.prepare('SELECT key, asset_class FROM security_classes').all() as Row[]).map((r) => [String(r.key), String(r.asset_class) as AssetClass]));
    const rows = db.prepare(`SELECT * FROM holdings ${only ? 'WHERE account_id = ?' : ''} ORDER BY value DESC, id`).all(...(only ? [only] : [])) as Row[];
    const out = new Map<number, Holding[]>();
    for (const r of rows) {
      const key = classKey(r.symbol ?? null, String(r.description));
      const pick = chosen.get(key);
      const holding: Holding = {
        id: Number(r.id),
        accountId: Number(r.account_id),
        asOf: String(r.as_of),
        symbol: r.symbol ?? null,
        description: String(r.description),
        quantity: r.quantity ?? null,
        price: r.price ?? null,
        value: Number(r.value),
        costBasis: r.cost_basis ?? null,
        gain: r.cost_basis == null ? null : round(Number(r.value) - Number(r.cost_basis)),
        assetClass: pick ?? guessClass(r.symbol ?? null, String(r.description), r.hint ?? null),
        chosen: Boolean(pick),
      };
      if (!out.has(holding.accountId)) out.set(holding.accountId, []);
      out.get(holding.accountId)!.push(holding);
    }
    return out;
  }

  function summary({ business = false }: { business?: boolean } = {}) {
    catchUp();
    const held = holdingsByAccount();
    const rows = db
      .prepare(
        `SELECT a.*, e.name AS entity,
                (SELECT COUNT(*) FROM bank_transactions t WHERE t.account_id = a.id) AS n
         FROM bank_accounts a LEFT JOIN entities e ON e.id = a.entity_id
         WHERE a.person_id IS NULL ORDER BY a.name COLLATE NOCASE`
      )
      .all() as Row[];
    const now = today();
    const all = rows.map((a) => {
      const isBusiness = a.owner === 'business';
      const manual = !a.simplefin_id && Number(a.n) === 0;
      const age = a.balance_date ? daysBetween(a.balance_date, now) : null;
      const treatment = treatmentOf(a.kind, a.invest_type);
      const positions = held.get(Number(a.id));
      const owedKind = a.kind === 'credit' || a.kind === 'loan';
      // What kind of investment account it looks like, for one not yet chosen.
      const suggestedType = owedKind || a.invest_type ? null : guessInvestType(String(a.name), a.institution ?? null);
      return {
        id: Number(a.id),
        name: String(a.name),
        institution: a.institution ?? null,
        kind: String(a.kind),
        investType: a.invest_type ?? null,
        holder: (a.holder ?? null) as Holder | null,
        treatment,
        business: isBusiness,
        entity: a.entity ?? null,
        balance: a.balance == null ? null : round(worth(a.kind, Number(a.balance))),
        balanceDate: a.balance_date ?? null,
        source: a.simplefin_id ? 'simplefin' : manual ? 'manual' : 'file',
        stale: age !== null && age > (a.simplefin_id ? FEED_STALE_DAYS : MANUAL_STALE_DAYS),
        removable: manual,
        positions: positions?.length ? { count: positions.length, total: round(positions.reduce((s, h) => s + h.value, 0)), asOf: positions[0].asOf } : null,
        suggestedType,
        suggestedHolder: (suggestedType || a.kind === 'investment') && !a.holder ? guessHolder(String(a.name)) : null,
      };
    });
    const accounts = all.filter((a) => business || !a.business);
    const sum = (list: typeof accounts) => round(list.reduce((s, a) => s + (a.balance ?? 0), 0));
    const assets = accounts.filter((a) => (a.balance ?? 0) > 0);
    const owed = accounts.filter((a) => (a.balance ?? 0) < 0);
    const byTreatment = (Object.keys(TREATMENTS) as Treatment[])
      .map((key) => ({ key, label: TREATMENTS[key], amount: sum(accounts.filter((a) => a.treatment === key)) }))
      .filter((t) => t.amount !== 0);
    const byHolder = [...HOLDERS, null].map((holder) => ({ holder, amount: sum(accounts.filter((a) => a.holder === holder && a.kind === 'investment')) })).filter((h) => h.amount !== 0);

    return {
      accounts,
      businessAccounts: all.filter((a) => a.business).length,
      totals: {
        netWorth: sum(accounts),
        assets: sum(assets),
        owed: sum(owed),
        invested: sum(accounts.filter((a) => a.kind === 'investment')),
        cash: sum(accounts.filter((a) => a.treatment === 'cash')),
      },
      byTreatment,
      byHolder,
      ...portfolio(accounts, held),
      history: history(new Set(accounts.map((a) => a.id)), new Map(accounts.map((a) => [a.id, a.kind]))),
      types: Object.entries(INVEST_TYPES).map(([key, t]) => ({ key, label: t.label, treatment: t.treatment })),
    };
  }

  // What the invested money is in: the mix of asset classes, the biggest holdings across
  // accounts, and things worth a look. An account without positions counts at its
  // balance, as not broken down (company stock as US stocks).
  function portfolio(accounts: { id: number; name: string; kind: string; investType: string | null; holder: string | null; treatment: string; balance: number | null; source: string; positions: { total: number; asOf: string } | null }[], held: Map<number, Holding[]>) {
    const invested = accounts.filter((a) => a.kind === 'investment');
    const classes = new Map<string, number>();
    const add = (key: string, value: number) => classes.set(key, (classes.get(key) ?? 0) + value);
    const notBrokenDown: { id: number; name: string; balance: number; countedAs: AssetClass | null }[] = [];
    const bySecurity = new Map<string, { symbol: string | null; description: string; value: number; assetClass: AssetClass; accounts: Set<string> }>();
    for (const a of invested) {
      const positions = held.get(a.id);
      if (positions?.length) {
        for (const h of positions) {
          add(h.assetClass, h.value);
          const key = classKey(h.symbol, h.description);
          const entry = bySecurity.get(key) ?? { symbol: h.symbol, description: h.description, value: 0, assetClass: h.assetClass, accounts: new Set<string>() };
          entry.value += h.value;
          entry.accounts.add(a.name);
          bySecurity.set(key, entry);
        }
      } else if ((a.balance ?? 0) > 0) {
        const countedAs = a.investType === 'espp' ? 'us_stock' : null;
        add(countedAs ?? 'unknown', a.balance!);
        notBrokenDown.push({ id: a.id, name: a.name, balance: a.balance!, countedAs });
      }
    }
    const total = [...classes.values()].reduce((s, v) => s + v, 0);
    const allocation = [...(Object.keys(ASSET_CLASSES) as AssetClass[]), 'unknown']
      .map((key) => ({ key, label: key === 'unknown' ? 'Not broken down' : ASSET_CLASSES[key as AssetClass], amount: round(classes.get(key) ?? 0), share: total ? (classes.get(key) ?? 0) / total : 0 }))
      .filter((c) => c.amount !== 0);
    const topHoldings = [...bySecurity.values()]
      .sort((x, y) => y.value - x.value)
      .slice(0, 15)
      .map((s) => ({ symbol: s.symbol, description: s.description, value: round(s.value), share: total ? s.value / total : 0, assetClass: s.assetClass, accounts: [...s.accounts] }));

    // Facts worth a look, stated plainly; what to do about them is the household's call.
    const checks: Check[] = [];
    const pct = (n: number) => `${Math.round(n * 100)}%`;
    for (const s of bySecurity.values()) {
      if (!total || s.value / total < CONCENTRATED || s.assetClass === 'cash' || s.assetClass === 'bond' || s.assetClass === 'target_date' || isFund(s.symbol, s.description)) continue;
      checks.push({
        key: `concentrated:${s.symbol ?? s.description}`,
        title: `${s.symbol ?? s.description} is ${pct(s.value / total)} of invested money`,
        detail: `${wholeDollars(s.value)} in ${[...s.accounts].join(', ')}. A single company this large a share moves the whole portfolio with it.`,
        accountIds: invested.filter((a) => s.accounts.has(a.name)).map((a) => a.id),
      });
    }
    const company = invested.filter((a) => a.investType === 'espp' && (a.balance ?? 0) > 0);
    const companyTotal = company.reduce((s, a) => s + (a.balance ?? 0), 0);
    if (total && companyTotal / total >= CONCENTRATED)
      checks.push({ key: 'company-stock', title: `Company stock is ${pct(companyTotal / total)} of invested money`, detail: `${wholeDollars(companyTotal)} across ${company.map((a) => a.name).join(', ')}.`, accountIds: company.map((a) => a.id) });
    const now = today();
    const stale = invested.filter((a) => a.positions && daysBetween(a.positions.asOf, now) > POSITIONS_STALE_DAYS);
    if (stale.length)
      checks.push({ key: 'positions-stale', title: `Positions are over ${POSITIONS_STALE_DAYS} days old in ${stale.length === 1 ? stale[0].name : `${stale.length} accounts`}`, detail: 'Download a fresh positions file from the brokerage to keep the mix current.', accountIds: stale.map((a) => a.id) });
    const drift = invested.filter((a) => a.positions && a.balance !== null && a.source !== 'manual' && Math.abs(a.positions.total - a.balance) > Math.max(DRIFT_DOLLARS, Math.abs(a.balance) * DRIFT_SHARE));
    for (const a of drift)
      checks.push({ key: `drift:${a.id}`, title: `${a.name}: positions add up to ${wholeDollars(a.positions!.total)}, the balance is ${wholeDollars(a.balance!)}`, detail: `The positions are from ${a.positions!.asOf}. Money may have moved since; a fresh positions file would match.`, accountIds: [a.id] });
    const missing = notBrokenDown.filter((n) => !n.countedAs && !NO_POSITIONS.has(invested.find((a) => a.id === n.id)?.investType ?? ''));
    if (missing.length)
      checks.push({ key: 'no-positions', title: `${wholeDollars(missing.reduce((s, n) => s + n.balance, 0))} isn't broken down into holdings`, detail: `No positions file yet for ${missing.map((n) => n.name).join(', ')}.`, accountIds: missing.map((n) => n.id) });
    const nobody = invested.filter((a) => !a.holder && (a.balance ?? 0) !== 0);
    if (nobody.length)
      checks.push({ key: 'no-holder', title: `Whose is not chosen for ${nobody.length === 1 ? nobody[0].name : `${nobody.length} investment accounts`}`, detail: 'The retirement plan needs to know whose each account is, for required withdrawals and Social Security.', accountIds: nobody.map((a) => a.id) });
    const cash = classes.get('cash') ?? 0;
    if (total && cash / total >= CONCENTRATED) checks.push({ key: 'cash', title: `${pct(cash / total)} of invested money is in cash`, detail: `${wholeDollars(cash)} in money market and cash inside investment accounts.`, accountIds: [] });
    const losers = invested
      .filter((a) => a.treatment === 'taxable')
      .flatMap((a) => (held.get(a.id) ?? []).filter((h) => h.gain !== null && h.gain <= -LOSS_WORTH_NOTING).map((h) => ({ a, h })));
    if (losers.length) {
      const sum = losers.reduce((s, x) => s + x.h.gain!, 0);
      checks.push({
        key: 'taxable-losses',
        title: `${wholeDollars(-sum)} of losses in taxable accounts`,
        detail: `${losers.map((x) => `${x.h.symbol ?? x.h.description} in ${x.a.name}`).join('; ')}. Losses realised in a taxable account can offset gains; ask the CPA before selling.`,
        accountIds: [...new Set(losers.map((x) => x.a.id))],
      });
    }
    return { allocation, topHoldings, notBrokenDown, checks, investedTotal: round(total), classes: Object.entries(ASSET_CLASSES).map(([key, label]) => ({ key, label })) };
  }

  // Net worth and the invested part on each day a balance was recorded, carrying each
  // account's last known balance forward. Thinned to a few hundred points.
  function history(ids: Set<number>, kinds: Map<number, string>) {
    const rows = (db.prepare('SELECT account_id, day, balance FROM account_balances ORDER BY day').all() as Row[]).filter((r) => ids.has(Number(r.account_id)));
    const latest = new Map<number, number>();
    const points: { day: string; netWorth: number; invested: number }[] = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      latest.set(Number(r.account_id), worth(kinds.get(Number(r.account_id)) ?? 'other', Number(r.balance)));
      if (rows[i + 1]?.day === r.day) continue;
      let netWorth = 0;
      let invested = 0;
      for (const [id, value] of latest) {
        netWorth += value;
        if (kinds.get(id) === 'investment') invested += value;
      }
      points.push({ day: String(r.day), netWorth: round(netWorth), invested: round(invested) });
    }
    if (points.length <= HISTORY_POINTS) return points;
    const step = points.length / HISTORY_POINTS;
    const thinned = Array.from({ length: HISTORY_POINTS - 1 }, (_, k) => points[Math.floor(k * step)]);
    return [...thinned, points[points.length - 1]];
  }

  // An account nothing can import, with its balance typed in.
  function addAccount(input: { name: string; institution?: string | null; investType: string; holder: Holder | null; balance: number; day?: string | null }) {
    if (!INVEST_TYPES[input.investType]) throw new HttpError(400, 'What kind of account is it?');
    const day = input.day || today();
    if (day > today()) throw new HttpError(400, "A balance can't be from the future.");
    const id = bank.createAccount({ name: input.name, institution: input.institution ?? null, kind: 'investment', owner: 'personal' });
    db.prepare('UPDATE bank_accounts SET invest_type = ?, holder = ?, balance = ?, balance_date = ? WHERE id = ?').run(input.investType, input.holder, input.balance, day, id);
    remember.run(id, day, input.balance, 'manual');
    return id;
  }

  // What kind of investment an account is, and whose. Choosing a kind makes it an
  // investment account; clearing it makes it a plain account again.
  function updateAccount(id: number, change: { investType?: string | null; holder?: Holder | null; name?: string }) {
    const row = rowOf(id);
    if (change.investType !== undefined) {
      if (change.investType !== null && !INVEST_TYPES[change.investType]) throw new HttpError(400, 'What kind of account is it?');
      if (change.investType !== null && (row.kind === 'credit' || row.kind === 'loan')) throw new HttpError(400, "A card or loan can't be an investment account.");
      const kind = change.investType === null ? (row.kind === 'investment' ? 'other' : row.kind) : 'investment';
      if (kind !== row.kind) bank.updateAccount(id, { kind });
      db.prepare('UPDATE bank_accounts SET invest_type = ? WHERE id = ?').run(change.investType, id);
    }
    if (change.holder !== undefined) db.prepare('UPDATE bank_accounts SET holder = ? WHERE id = ?').run(change.holder, id);
    if (change.name !== undefined) db.prepare('UPDATE bank_accounts SET name = ? WHERE id = ?').run(change.name, id);
  }

  // A balance typed in: today's, or one from the past to fill in history.
  function setBalance(id: number, balance: number, day?: string | null) {
    const row = rowOf(id);
    const when = day || today();
    if (when > today()) throw new HttpError(400, "A balance can't be from the future.");
    remember.run(id, when, balance, 'manual');
    if (!row.balance_date || when >= row.balance_date) db.prepare('UPDATE bank_accounts SET balance = ?, balance_date = ? WHERE id = ?').run(balance, when, id);
  }

  function balances(id: number) {
    rowOf(id);
    return (db.prepare('SELECT day, balance, source FROM account_balances WHERE account_id = ? ORDER BY day DESC LIMIT 400').all(id) as Row[]).map((r) => ({
      day: String(r.day),
      balance: Number(r.balance),
      source: String(r.source),
    }));
  }

  // Only an account that was typed in can go: one with transactions or a feed stays.
  function removeAccount(id: number) {
    const row = rowOf(id);
    const used = (db.prepare('SELECT COUNT(*) AS n FROM bank_transactions WHERE account_id = ?').get(id) as Row).n;
    if (row.simplefin_id || Number(used) > 0) throw new HttpError(400, 'Only an account you added here can be removed. This one has transactions.');
    bank.deleteAccount(id);
  }

  /* ---------- Holdings ---------- */

  function holdings(id: number) {
    rowOf(id);
    const list = holdingsByAccount(id).get(id) ?? [];
    return { asOf: list[0]?.asOf ?? null, holdings: list };
  }

  // Accounts positions can go to: the household's own, other than cards and loans.
  const targets = () =>
    (db.prepare("SELECT id, name, institution, kind, invest_type, balance, last4 FROM bank_accounts WHERE person_id IS NULL AND kind NOT IN ('credit', 'loan') ORDER BY name COLLATE NOCASE").all() as Row[]).map((r) => ({
      id: Number(r.id),
      name: String(r.name),
      institution: r.institution ?? null,
      kind: String(r.kind),
      investType: r.invest_type ?? null,
      balance: r.balance ?? null,
      last4: (r.last4 as string | null) || nameDigits(String(r.name)),
    }));

  function read(text: string) {
    try {
      return readPositions(text);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  }

  // Reads a positions file and says which account each part of it looks like, before anything is saved.
  function inspectPositions(text: string) {
    const file = read(text);
    const options = targets();
    const taken = new Set<number>();
    const accounts = file.accounts.map((acc, index) => {
      const label = bareName(acc.label);
      const match =
        options.find((o) => !taken.has(o.id) && acc.last4 && o.last4 && o.last4.padStart(4, '0') === acc.last4.padStart(4, '0')) ??
        options.find((o) => !taken.has(o.id) && bareName(o.name) === label) ??
        null;
      if (match) taken.add(match.id);
      return {
        key: String(index),
        label: acc.label,
        last4: acc.last4,
        count: acc.positions.length,
        total: acc.total,
        match: match?.id ?? null,
        top: acc.positions
          .slice()
          .sort((x, y) => y.value - x.value)
          .slice(0, 4)
          .map((p) => ({ symbol: p.symbol, description: p.description, value: p.value })),
      };
    });
    return { brokerage: file.brokerage, institution: BROKERAGE_NAMES[file.brokerage], asOf: file.asOf, skipped: file.skipped, accounts, options };
  }

  // Saves the positions for each part of the file given an account ('new' adds one);
  // an account's earlier positions are replaced. An account fed by SimpleFIN keeps its
  // balance from the feed; any other takes the positions' total as its balance that day.
  function savePositions(text: string, assign: Record<string, number | 'new' | null>) {
    const file = read(text);
    const asOf = file.asOf && file.asOf <= today() ? file.asOf : today();
    const used = new Set<number>();
    for (const target of Object.values(assign)) {
      if (typeof target !== 'number') continue;
      if (used.has(target)) throw new HttpError(400, 'Two parts of the file are going to the same account.');
      used.add(target);
    }
    const insert = db.prepare(
      'INSERT INTO holdings (account_id, as_of, symbol, description, quantity, price, value, cost_basis, hint, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    let saved = 0;
    let positions = 0;
    db.exec('BEGIN');
    try {
      file.accounts.forEach((acc, index) => {
        const target = assign[String(index)];
        if (target === null || target === undefined) return;
        let id: number;
        if (target === 'new') {
          const investType = guessInvestType(acc.label, BROKERAGE_NAMES[file.brokerage]) ?? 'brokerage';
          id = addAccount({ name: acc.last4 ? `${acc.label} (${acc.last4})` : acc.label, institution: BROKERAGE_NAMES[file.brokerage], investType, holder: guessHolder(acc.label), balance: acc.total, day: asOf });
        } else {
          const row = rowOf(target);
          if (row.kind === 'credit' || row.kind === 'loan') throw new HttpError(400, "Positions can't go on a card or loan.");
          id = target;
          // Holding positions makes it an investment account.
          if (row.kind !== 'investment') updateAccount(id, { investType: guessInvestType(String(row.name), row.institution ?? null) ?? 'brokerage' });
          if (!row.simplefin_id) setBalance(id, acc.total, asOf);
        }
        db.prepare('DELETE FROM holdings WHERE account_id = ?').run(id);
        const stamp = new Date().toISOString();
        for (const p of acc.positions) insert.run(id, asOf, p.symbol, p.description.slice(0, 200), p.quantity, p.price, p.value, p.costBasis, p.hint, 'file', stamp);
        saved++;
        positions += acc.positions.length;
      });
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return { accounts: saved, positions, asOf };
  }

  // The asset class for a security wherever it's held; null goes back to the guess.
  function setClass(key: string, assetClass: AssetClass | null) {
    if (assetClass === null) db.prepare('DELETE FROM security_classes WHERE key = ?').run(key);
    else db.prepare('INSERT INTO security_classes (key, asset_class) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET asset_class = excluded.asset_class').run(key, assetClass);
  }

  // Takes the suggested kind (and joint holder) for each account named.
  function applySuggestions(ids: number[]) {
    let changed = 0;
    for (const id of ids) {
      const row = rowOf(id);
      if (row.kind === 'credit' || row.kind === 'loan') continue;
      const investType = row.invest_type ?? guessInvestType(String(row.name), row.institution ?? null);
      if (!investType) continue;
      if (!row.invest_type || row.kind !== 'investment') updateAccount(id, { investType });
      const holder = guessHolder(String(row.name));
      if (holder && !row.holder) updateAccount(id, { holder });
      changed++;
    }
    return changed;
  }

  return { summary, addAccount, updateAccount, setBalance, balances, removeAccount, holdings, inspectPositions, savePositions, setClass, applySuggestions };
}

export type WealthService = ReturnType<typeof wealthService>;
