// Wealth: every account the household owns, investment and retirement accounts
// included, with net worth over time. Balances come from SimpleFIN, from files, or are
// typed in for accounts nothing can import (a pension, deferred compensation, an ESPP).
// The owner's household only: family members' accounts stay in their own My money.
import type { DatabaseSync } from 'node:sqlite';
import type { BankStore } from '../bank/store';
import { HttpError } from '../params';

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

const today = () => new Date().toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const round = (n: number) => Math.round(n * 100) / 100;

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

  function summary({ business = false }: { business?: boolean } = {}) {
    catchUp();
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
      history: history(new Set(accounts.map((a) => a.id)), new Map(accounts.map((a) => [a.id, a.kind]))),
      types: Object.entries(INVEST_TYPES).map(([key, t]) => ({ key, label: t.label, treatment: t.treatment })),
    };
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

  return { summary, addAccount, updateAccount, setBalance, balances, removeAccount };
}

export type WealthService = ReturnType<typeof wealthService>;
