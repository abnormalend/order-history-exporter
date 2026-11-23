// A private foundation's picture: how its investments have grown, what it has given
// away, and every movement of money on a five-year calendar. Built from its accounts
// (bank and investment), their daily balances and holdings, and its transactions.
//
// Each transaction is one of:
//   gift      money given to the foundation (Owner Contribution)
//   grant     money it gave away (Charitable donations)
//   toInvest  moved from the bank into its investments (a transfer out)
//   fromInvest  brought back from its investments (a transfer in)
//   expense   anything else paid out: fees, taxes, reimbursements
//   income    anything else coming in: interest, refunds
import type { DatabaseSync } from 'node:sqlite';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export type FlowType = 'gift' | 'grant' | 'toInvest' | 'fromInvest' | 'expense' | 'income';
export const FLOW_TYPES: FlowType[] = ['gift', 'grant', 'toInvest', 'fromInvest', 'expense', 'income'];

// By what the category means, so 'Owner Contribution', 'Donations received' or
// 'Charitable donations' all work.
const GIFT_CATEGORY = /contribution|gift|donations? received/i;
const GRANT_CATEGORY = /donation|grant|charit/i;
// How many years the calendar shows: this one and the four before it.
export const CALENDAR_YEARS = 5;
// The usual minimum a private foundation gives out each year, as a share of its assets.
const PAYOUT_RATE = 0.05;

export function flowType(t: { amount: number; kind: string; category: string | null }): FlowType {
  if (t.category && GIFT_CATEGORY.test(t.category) && t.amount > 0) return 'gift';
  if (t.category && GRANT_CATEGORY.test(t.category) && t.amount < 0) return 'grant';
  if (t.kind === 'transfer') return t.amount < 0 ? 'toInvest' : 'fromInvest';
  return t.amount < 0 ? 'expense' : 'income';
}

const round = (n: number) => Math.round(n * 100) / 100;
const zero = () => Object.fromEntries(FLOW_TYPES.map((k) => [k, 0])) as Record<FlowType, number>;

export function foundationService({ db, today = () => new Date().toISOString().slice(0, 10) }: { db: DatabaseSync; today?: () => string }) {
  function summary(entityId: number) {
    const now = today();
    const year = Number(now.slice(0, 4));
    const accounts = (
      db.prepare(`SELECT id, name, institution, kind, balance, balance_date FROM bank_accounts WHERE entity_id = ? ORDER BY kind = 'investment' DESC, name`).all(entityId) as Row[]
    ).map((a) => ({
      id: Number(a.id),
      name: String(a.name),
      institution: (a.institution as string | null) ?? null,
      investment: a.kind === 'investment',
      balance: a.balance === null ? null : Number(a.balance),
      balanceDate: (a.balance_date as string | null) ?? null,
    }));
    const investIds = accounts.filter((a) => a.investment).map((a) => a.id);
    const cashIds = accounts.filter((a) => !a.investment).map((a) => a.id);

    // The latest holdings of each investment account: value and what was paid for it.
    let costBasis: number | null = null;
    let holdingsValue = 0;
    const holdings: { accountId: number; symbol: string | null; description: string; value: number; costBasis: number | null }[] = [];
    for (const id of investIds) {
      const latest = db.prepare('SELECT MAX(as_of) AS d FROM holdings WHERE account_id = ?').get(id) as Row;
      if (!latest?.d) continue;
      for (const h of db.prepare('SELECT symbol, description, value, cost_basis FROM holdings WHERE account_id = ? AND as_of = ? ORDER BY value DESC').all(id, latest.d) as Row[]) {
        holdings.push({ accountId: id, symbol: h.symbol ?? null, description: String(h.description), value: Number(h.value), costBasis: h.cost_basis === null ? null : Number(h.cost_basis) });
        holdingsValue += Number(h.value);
        if (h.cost_basis !== null) costBasis = (costBasis ?? 0) + Number(h.cost_basis);
      }
    }

    // Investment value by day: each account's last known balance, added together.
    const investHistory: { day: string; value: number }[] = [];
    if (investIds.length) {
      const rows = db.prepare(`SELECT account_id, day, balance FROM account_balances WHERE account_id IN (${investIds.map(() => '?').join(',')}) ORDER BY day`).all(...investIds) as Row[];
      const last = new Map<number, number>();
      for (const r of rows) {
        last.set(Number(r.account_id), Number(r.balance));
        const value = round([...last.values()].reduce((s, v) => s + v, 0));
        if (investHistory.length && investHistory[investHistory.length - 1].day === r.day) investHistory[investHistory.length - 1].value = value;
        else investHistory.push({ day: String(r.day), value });
      }
    }
    const investNow = accounts.filter((a) => a.investment).reduce((s, a) => s + (a.balance ?? 0), 0);
    const cashNow = accounts.filter((a) => !a.investment).reduce((s, a) => s + (a.balance ?? 0), 0);
    if (investIds.length && (!investHistory.length || investHistory[investHistory.length - 1].day < now)) investHistory.push({ day: now, value: round(investNow) });
    // The value nearest the start of the year: within two weeks of Jan 1 if known,
    // otherwise the last one before it, otherwise the first one this year.
    const yearStart = `${year}-01-01`;
    const gap = (p: { day: string }) => Math.abs(Date.parse(p.day) - Date.parse(yearStart));
    const near = investHistory.filter((p) => gap(p) <= 14 * 86400000).sort((a, b) => gap(a) - gap(b))[0];
    const startPoint = near ?? [...investHistory].reverse().find((p) => p.day <= yearStart) ?? investHistory.find((p) => p.day >= yearStart) ?? null;

    // Every transaction of the foundation's, with who a check was written to.
    const transactions = (
      db
        .prepare(
          `SELECT t.id, t.account_id, t.posted, t.amount, t.description, t.kind, t.category, t.note,
                  (SELECT r.vendor FROM receipts r WHERE r.transaction_id = t.id ORDER BY r.id LIMIT 1) AS payee,
                  (SELECT r.check_number FROM receipts r WHERE r.transaction_id = t.id AND r.check_number IS NOT NULL ORDER BY r.id LIMIT 1) AS check_number,
                  (SELECT r.check_memo FROM receipts r WHERE r.transaction_id = t.id AND r.check_memo IS NOT NULL ORDER BY r.id LIMIT 1) AS check_memo
           FROM bank_transactions t
           WHERE t.entity_id = ? AND t.kind != 'ignored'
           ORDER BY t.posted, t.id`,
        )
        .all(entityId) as Row[]
    ).map((t) => {
      const amount = Number(t.amount);
      return {
        id: Number(t.id),
        accountId: Number(t.account_id),
        date: String(t.posted),
        amount,
        description: String(t.description),
        category: (t.category as string | null) ?? null,
        note: (t.note as string | null) ?? null,
        payee: (t.payee as string | null) ?? null,
        checkNumber: (t.check_number as string | null) ?? null,
        memo: (t.check_memo as string | null) ?? null,
        type: flowType({ amount, kind: String(t.kind), category: (t.category as string | null) ?? null }),
      };
    });
    // A move between two of the foundation's own accounts shows once, from the bank's side.
    const shown = transactions.filter((t) => !(investIds.includes(t.accountId) && (t.type === 'toInvest' || t.type === 'fromInvest')));

    const firstYear = year - CALENDAR_YEARS + 1;
    const years = Array.from({ length: CALENDAR_YEARS }, (_, i) => ({ year: firstYear + i, totals: zero() }));
    const ytd = zero();
    const allTime = zero();
    for (const t of shown) {
      const y = Number(t.date.slice(0, 4));
      const size = Math.abs(t.amount);
      allTime[t.type] += size;
      if (y === year) ytd[t.type] += size;
      const slot = years.find((s) => s.year === y);
      if (slot) slot.totals[t.type] += size;
    }
    const tidy = (r: Record<FlowType, number>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, round(v)])) as Record<FlowType, number>;

    // A rough yearly payout guide: 5% of what the foundation holds. The real figure uses
    // the average over the year and some adjustments, so it's only a guide.
    const assets = round(investNow + cashNow);
    return {
      asOf: now,
      year,
      accounts,
      investments: {
        value: round(investNow),
        costBasis: costBasis === null ? null : round(costBasis),
        gain: costBasis === null ? null : round(holdingsValue - costBasis),
        startOfYear: startPoint ? { day: startPoint.day, value: startPoint.value } : null,
        changeThisYear: startPoint ? round(investNow - startPoint.value) : null,
        history: investHistory,
        holdings,
      },
      cash: round(cashNow),
      assets,
      payoutGuide: { rate: PAYOUT_RATE, amount: round(assets * PAYOUT_RATE), givenThisYear: round(ytd.grant) },
      ytd: tidy(ytd),
      allTime: tidy(allTime),
      years: years.map((y) => ({ year: y.year, totals: tidy(y.totals) })),
      transactions: shown,
      hasCash: cashIds.length > 0,
    };
  }

  return { summary };
}

export type FoundationService = ReturnType<typeof foundationService>;
