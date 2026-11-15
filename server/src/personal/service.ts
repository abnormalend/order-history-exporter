// The owner's personal money, month by month: what came in, where it went, what was
// only moved between their own pots, budgets for each kind of spending, and a look
// ahead built from regular paychecks and bills, budgets and typical months.
//
// Personal transactions are the ones marked personal (every transaction in a personal
// account, and those picked out as personal in a shared one). Transfers and ignored
// rows are left out, as everywhere else.
import type { DatabaseSync } from 'node:sqlite';
import { INCOME_GROUPS, MOVE_GROUPS, SPENDING_GROUPS, businessPattern, classify, seriesKey } from './groups';
import type { Flow, Group, SpendingGroup } from './groups';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

interface Tx {
  id: number;
  posted: string;
  month: string;
  day: number;
  amount: number;
  description: string;
  payee: string | null;
  category: string | null;
  accountId: number;
  account: string;
  flow: Flow;
  group: Group;
  guessed: boolean;
  series: string;
}

const cents = (n: number) => Math.round(n * 100) / 100;
const monthOf = (date: string) => date.slice(0, 7);
export function addMonths(month: string, n: number) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}
const daysIn = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
const median = (values: number[]) => {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const range = (from: string, to: string) => {
  const out: string[] = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m);
  return out;
};
// A readable payee: the bank's cleaned-up name, or the description's first words.
// Bank reference tails ("PPD ID: 123", "Conf# 9") are dropped, and a payment to or from
// a person is named after them rather than the app that carried it.
const titleCase = (text: string) => text.replace(/\b[a-z]/g, (c) => c.toUpperCase());
const nameOf = (t: { payee: string | null; description: string }) => {
  const person = seriesKey(t.description, t.payee);
  if (person.startsWith('person ')) return titleCase(person.slice(7));
  const raw = t.payee && t.payee.length > 2 ? t.payee : t.description.split(/\s+/).slice(0, 4).join(' ');
  return raw.replace(/\s+\b(des|id|indn|ppd|ccd|web|entry|descr|conf|ref|confirmation)\b[:#]?.*$/i, '').trim() || raw;
};

export function personalService({ db, today = () => new Date().toISOString().slice(0, 10) }: { db: DatabaseSync; today?: () => string }) {
  function load(accountIds: number[] | null): Tx[] {
    // Transfers to the owner's business accounts are money moved, not spent.
    const business = businessPattern(
      (db.prepare("SELECT last4 FROM bank_accounts WHERE last4 IS NOT NULL AND (owner != 'personal' OR entity_id IS NOT NULL)").all() as Row[]).map((r) => String(r.last4))
    );
    const where = accountIds?.length ? `AND t.account_id IN (${accountIds.map(Number).join(',')})` : '';
    const rows = db
      .prepare(
        `SELECT t.id, t.posted, t.amount, t.description, t.payee, t.category, t.account_id, a.name AS account
         FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id
         WHERE t.status = 'personal' AND t.kind = 'normal' AND t.amount != 0 ${where}
         ORDER BY t.posted, t.id`
      )
      .all() as Row[];
    return rows.map((r) => {
      const c = classify({ amount: r.amount, description: r.description, payee: r.payee, category: r.category }, business);
      return {
        id: r.id,
        posted: r.posted,
        month: monthOf(r.posted),
        day: Number(String(r.posted).slice(8, 10)),
        amount: r.amount,
        description: r.description,
        payee: r.payee ?? null,
        category: r.category ?? null,
        accountId: r.account_id,
        account: r.account,
        flow: c.flow,
        group: c.group,
        guessed: c.guessed,
        series: `${c.flow}:${seriesKey(r.description, r.payee)}`,
      };
    });
  }

  const budgets = (): Record<string, number> =>
    Object.fromEntries((db.prepare('SELECT group_key, monthly FROM personal_budgets').all() as Row[]).map((r) => [r.group_key, r.monthly]));

  function setBudget(group: string, monthly: number | null) {
    if (!(SPENDING_GROUPS as readonly string[]).includes(group)) throw new Error('That is not a kind of spending.');
    if (monthly === null || monthly <= 0) db.prepare('DELETE FROM personal_budgets WHERE group_key = ?').run(group);
    else
      db.prepare('INSERT INTO personal_budgets (group_key, monthly, updated_at) VALUES (?, ?, ?) ON CONFLICT (group_key) DO UPDATE SET monthly = excluded.monthly, updated_at = excluded.updated_at').run(
        group,
        cents(monthly),
        new Date().toISOString()
      );
    return budgets();
  }

  // Accounts with personal money in them, for the picker.
  function accounts() {
    return (
      db
        .prepare(
          `SELECT a.id, a.name, a.institution, a.kind, a.owner, a.balance, a.balance_date,
                  (SELECT COUNT(*) FROM bank_transactions t WHERE t.account_id = a.id AND t.status = 'personal') AS personal
           FROM bank_accounts a ORDER BY a.name COLLATE NOCASE`
        )
        .all() as Row[]
    )
      .filter((a) => a.owner === 'personal' || a.personal > 0)
      .map((a) => ({ id: a.id, name: a.name, institution: a.institution ?? null, kind: a.kind, balance: a.balance ?? null, balanceDate: a.balance_date ?? null, transactions: a.personal }));
  }

  function summary(selected: string | null, accountIds: number[] | null) {
    const todayDate = today();
    const thisMonth = monthOf(todayDate);
    const month = selected && /^\d{4}-\d{2}$/.test(selected) ? selected : thisMonth;
    const all = load(accountIds);
    const plan = budgets();

    // Totals for each month and group.
    const byMonth = new Map<string, Map<string, number>>();
    const add = (m: string, g: string, n: number) => {
      let groups = byMonth.get(m);
      if (!groups) byMonth.set(m, (groups = new Map()));
      groups.set(g, (groups.get(g) || 0) + n);
    };
    for (const t of all) add(t.month, t.group, t.amount);
    const groupTotal = (m: string, g: string) => byMonth.get(m)?.get(g) || 0;
    const spentIn = (m: string) => -SPENDING_GROUPS.reduce((s, g) => s + groupTotal(m, g), 0);
    const earnedIn = (m: string) => INCOME_GROUPS.reduce((s, g) => s + groupTotal(m, g), 0);

    // Typical months: the median of the last six complete ones, so one tuition bill
    // or holiday doesn't set the pace.
    const recent = range(addMonths(thisMonth, -6), addMonths(thisMonth, -1));
    const typical = Object.fromEntries(SPENDING_GROUPS.map((g) => [g, cents(Math.max(0, -median(recent.map((m) => groupTotal(m, g)))))])) as Record<SpendingGroup, number>;
    const expected = (g: SpendingGroup) => plan[g] ?? typical[g];

    // Regular payments: the same payee in most of the last six months.
    const seriesMonths = new Map<string, { months: Map<string, number>; days: number[]; group: Group; flow: Flow; name: string }>();
    // A payee paid twice a month (a paycheck on the 15th and the 30th) is two regular
    // payments, one for each time in the month, not one of twice the size.
    const slots = new Map<string, number>();
    for (const t of all) {
      if (!recent.includes(t.month) && t.month !== thisMonth) continue;
      const slot = (slots.get(`${t.series}|${t.month}`) || 0) + 1;
      slots.set(`${t.series}|${t.month}`, slot);
      const key = `${t.series}#${slot}`;
      let s = seriesMonths.get(key);
      if (!s) seriesMonths.set(key, (s ={ months: new Map(), days: [], group: t.group, flow: t.flow, name: nameOf(t) }));
      s.months.set(t.month, (s.months.get(t.month) || 0) + t.amount);
      s.days.push(t.day);
    }
    const recurring = [...seriesMonths.entries()]
      .map(([key, s]) => {
        const seen = recent.filter((m) => s.months.has(m));
        const lastFour = recent.slice(-4).filter((m) => s.months.has(m)).length;
        if (s.flow === 'move' || !(seen.length >= 4 || lastFour >= 3)) return null;
        return {
          key,
          name: s.name,
          flow: s.flow,
          group: s.group,
          amount: cents(median(seen.map((m) => s.months.get(m) as number))),
          day: Math.round(median(s.days)),
          months: seen.length,
          paidThisMonth: s.months.has(thisMonth),
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null && Math.abs(r.amount) >= 1)
      .sort((a, b) => a.day - b.day);
    const recurringIncome = recurring.filter((r) => r.flow === 'in');

    // The months shown: a year back and six months ahead, or around the month picked.
    const longAgo = month < addMonths(thisMonth, -12);
    const first = longAgo ? addMonths(month, -6) : addMonths(thisMonth, -12);
    const last = longAgo ? addMonths(month, 6) : addMonths(thisMonth, 6);
    const firstData = all[0]?.month ?? thisMonth;
    const projectedEarned = (m: string) =>
      m === thisMonth ? earnedIn(m) + recurringIncome.filter((r) => !r.paidThisMonth).reduce((s, r) => s + r.amount, 0) : recurringIncome.reduce((s, r) => s + r.amount, 0);
    const projectedSpent = (m: string) => SPENDING_GROUPS.reduce((s, g) => s + (m === thisMonth ? Math.max(-groupTotal(m, g), expected(g)) : expected(g)), 0);
    const months = range(first, last).map((m) => {
      const future = m > thisMonth;
      const before = m < firstData;
      const earned = future ? 0 : earnedIn(m);
      const spent = future ? 0 : spentIn(m);
      return {
        month: m,
        earned: cents(earned),
        spent: cents(spent),
        kept: cents(earned - spent),
        invested: cents(-(groupTotal(m, 'invested') + groupTotal(m, 'from_savings'))),
        business: cents(-groupTotal(m, 'business')),
        future,
        current: m === thisMonth,
        noData: before,
        projectedEarned: future || m === thisMonth ? cents(projectedEarned(m)) : null,
        projectedSpent: future || m === thisMonth ? cents(projectedSpent(m)) : null,
      };
    });
    // Running savings: what's been kept so far over the months shown, carried on by the forecast.
    let running = 0;
    for (const m of months) {
      running += m.future ? (m.projectedEarned ?? 0) - (m.projectedSpent ?? 0) : m.kept;
      (m as Row).cumulative = cents(running);
    }

    // The month picked, in detail.
    const future = month > thisMonth;
    const inMonth = all.filter((t) => t.month === month);
    const groupRows = SPENDING_GROUPS.map((g) => {
      const list = inMonth.filter((t) => t.group === g);
      const merchants = new Map<string, { name: string; amount: number; count: number }>();
      for (const t of list) {
        const name = nameOf(t);
        const key = name.toLowerCase();
        const found = merchants.get(key) || { name, amount: 0, count: 0 };
        found.amount += -t.amount;
        found.count++;
        merchants.set(key, found);
      }
      const spent = future ? expected(g) : -list.reduce((s, t) => s + t.amount, 0);
      // How much of this usually goes out by this day of the month: rent on the 1st is
      // on pace on the 2nd, though a straight line through the month says otherwise.
      const byDay = month === thisMonth ? Number(todayDate.slice(8, 10)) : null;
      const typicalSoFar =
        byDay === null ? null : cents(Math.max(0, -median(recent.map((m) => all.filter((t) => t.month === m && t.group === g && t.day <= byDay).reduce((s, t) => s + t.amount, 0)))));
      return {
        key: g,
        amount: cents(spent),
        budget: plan[g] ?? null,
        typical: typical[g],
        typicalSoFar,
        count: list.length,
        merchants: [...merchants.values()].sort((a, b) => b.amount - a.amount).slice(0, 6).map((x) => ({ ...x, amount: cents(x.amount) })),
        transactions: list
          .sort((a, b) => a.amount - b.amount)
          .slice(0, 60)
          .map((t) => ({ id: t.id, posted: t.posted, amount: t.amount, name: nameOf(t), description: t.description, account: t.account, guessed: t.guessed, category: t.category })),
      };
    });
    const sourceRows = INCOME_GROUPS.map((g) => {
      const list = future ? [] : inMonth.filter((t) => t.group === g);
      const payers = new Map<string, { name: string; amount: number; count: number }>();
      for (const t of list) {
        const name = nameOf(t);
        const found = payers.get(name.toLowerCase()) || { name, amount: 0, count: 0 };
        found.amount += t.amount;
        found.count++;
        payers.set(name.toLowerCase(), found);
      }
      const amount = future ? recurringIncome.filter((r) => r.group === g).reduce((s, r) => s + r.amount, 0) : list.reduce((s, t) => s + t.amount, 0);
      return { key: g, amount: cents(amount), count: list.length, payers: [...payers.values()].sort((a, b) => b.amount - a.amount).slice(0, 5).map((x) => ({ ...x, amount: cents(x.amount) })) };
    }).filter((s) => s.amount !== 0);
    const moveRows = MOVE_GROUPS.map((g) => ({ key: g, amount: cents(future ? 0 : inMonth.filter((t) => t.group === g).reduce((s, t) => s + t.amount, 0)) })).filter((m) => m.amount !== 0);

    // How the month's spending built up, day by day, beside a typical month.
    const days = daysIn(month);
    const cumulative = (m: string, upTo: number) => {
      const daily = Array(days).fill(0);
      for (const t of all) if (t.month === m && t.flow === 'out') daily[Math.min(days, t.day) - 1] += -t.amount;
      let run = 0;
      return daily.slice(0, upTo).map((d) => cents((run += d)));
    };
    const shownDays = month === thisMonth ? Number(todayDate.slice(8, 10)) : future ? 0 : days;
    const typicalCurves = recent.map((m) => cumulative(m, days));
    const pace = {
      days,
      actual: shownDays ? cumulative(month, shownDays) : [],
      typical: Array.from({ length: days }, (_, i) => cents(median(typicalCurves.map((c) => c[i] ?? c[c.length - 1] ?? 0)))),
      budget: Object.keys(plan).length ? cents(SPENDING_GROUPS.reduce((s, g) => s + expected(g), 0)) : null,
    };

    const earned = future ? projectedEarned(month) : earnedIn(month);
    const spent = future ? projectedSpent(month) : spentIn(month);
    const upcoming = (() => {
      // Regular payments still to come in the next five weeks.
      const out: { name: string; flow: Flow; group: Group; amount: number; on: string }[] = [];
      const start = todayDate;
      const end = new Date(Date.parse(`${todayDate}T00:00:00Z`) + 35 * 86400000).toISOString().slice(0, 10);
      for (const m of [thisMonth, addMonths(thisMonth, 1)]) {
        for (const r of recurring) {
          if (m === thisMonth && r.paidThisMonth) continue;
          const on = `${m}-${String(Math.min(r.day, daysIn(m))).padStart(2, '0')}`;
          if (on >= start && on <= end) out.push({ name: r.name, flow: r.flow, group: r.group, amount: r.amount, on });
        }
      }
      return out.sort((a, b) => a.on.localeCompare(b.on));
    })();

    // The last twelve complete months together.
    const year = range(addMonths(thisMonth, -12), addMonths(thisMonth, -1));
    const yearSpent = SPENDING_GROUPS.map((g) => ({ key: g, amount: cents(-year.reduce((s, m) => s + groupTotal(m, g), 0)) })).filter((g) => g.amount > 0);
    const yearEarned = INCOME_GROUPS.map((g) => ({ key: g, amount: cents(year.reduce((s, m) => s + groupTotal(m, g), 0)) })).filter((g) => g.amount > 0);

    return {
      today: todayDate,
      thisMonth,
      month,
      future,
      firstMonth: firstData,
      accounts: accounts(),
      selectedAccounts: accountIds ?? [],
      budgets: plan,
      typical,
      months,
      detail: {
        month,
        earned: cents(earned),
        spent: cents(spent),
        kept: cents(earned - spent),
        rate: earned > 0 ? Math.round(((earned - spent) / earned) * 1000) / 10 : null,
        groups: groupRows,
        sources: sourceRows,
        moves: moveRows,
        pace,
        biggest: future
          ? []
          : inMonth
              .filter((t) => t.flow === 'out')
              .sort((a, b) => a.amount - b.amount)
              .slice(0, 6)
              .map((t) => ({ id: t.id, posted: t.posted, amount: t.amount, name: nameOf(t), group: t.group, account: t.account })),
        unsorted: inMonth.filter((t) => t.guessed && (t.group === 'other' || t.group === 'other_in')).length,
      },
      recurring,
      upcoming,
      year: { from: year[0], to: year[year.length - 1], spent: yearSpent, earned: yearEarned },
    };
  }

  return { summary, budgets, setBudget, accounts };
}

export type PersonalService = ReturnType<typeof personalService>;
