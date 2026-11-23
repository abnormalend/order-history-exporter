// A private foundation's dashboard: how its investments have grown, what it has given
// away this year, and every movement of money on a five-year calendar.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../api';
import type { Entity } from '../business';
import { MONTHS, money, wholeMoney } from '../format';
import { Banner, Card, Empty, Loading, PageHeader, Stat, TD, TH, TR, cx } from '../ui';

type FlowType = 'gift' | 'grant' | 'toInvest' | 'fromInvest' | 'expense' | 'income';
interface Flow {
  id: number;
  date: string;
  amount: number;
  description: string;
  category: string | null;
  note: string | null;
  payee: string | null;
  checkNumber: string | null;
  memo: string | null;
  type: FlowType;
}
interface Summary {
  asOf: string;
  year: number;
  accounts: { id: number; name: string; institution: string | null; investment: boolean; balance: number | null; balanceDate: string | null }[];
  investments: {
    value: number;
    costBasis: number | null;
    gain: number | null;
    startOfYear: { day: string; value: number } | null;
    changeThisYear: number | null;
    history: { day: string; value: number }[];
    holdings: { accountId: number; symbol: string | null; description: string; value: number; costBasis: number | null }[];
  };
  cash: number;
  assets: number;
  payoutGuide: { rate: number; amount: number; givenThisYear: number };
  ytd: Record<FlowType, number>;
  allTime: Record<FlowType, number>;
  years: { year: number; totals: Record<FlowType, number> }[];
  transactions: Flow[];
  hasCash: boolean;
}

// One colour per kind of movement, used on the chips, the legend and the year totals.
const TYPES: Record<FlowType, { label: string; chip: string; dot: string }> = {
  gift: { label: 'Gifts received', chip: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/50 dark:text-emerald-100', dot: 'bg-emerald-500' },
  grant: { label: 'Grants given', chip: 'bg-violet-100 text-violet-900 dark:bg-violet-900/50 dark:text-violet-100', dot: 'bg-violet-500' },
  toInvest: { label: 'Moved to investments', chip: 'bg-sky-100 text-sky-900 dark:bg-sky-900/50 dark:text-sky-100', dot: 'bg-sky-500' },
  fromInvest: { label: 'Back from investments', chip: 'bg-indigo-100 text-indigo-900 dark:bg-indigo-900/50 dark:text-indigo-100', dot: 'bg-indigo-500' },
  expense: { label: 'Expenses and taxes', chip: 'bg-slate-200 text-slate-800 dark:bg-slate-700 dark:text-slate-100', dot: 'bg-slate-400' },
  income: { label: 'Dividends and other income', chip: 'bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-100', dot: 'bg-amber-500' },
};
const ORDER: FlowType[] = ['gift', 'grant', 'toInvest', 'fromInvest', 'expense', 'income'];

const dayText = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const signed = (n: number) => `${n >= 0 ? '+' : '−'}${wholeMoney(Math.abs(n))}`;
const short = (n: number) => (Math.abs(n) >= 1000 ? `$${(Math.abs(n) / 1000).toFixed(Math.abs(n) >= 10000 ? 0 : 1)}k` : wholeMoney(Math.abs(n)));
const whoOf = (t: Flow) => t.payee || (t.checkNumber ? `Check ${t.checkNumber}` : t.description);

export function FoundationDashboard({ entity }: { entity: Entity }) {
  const data = useApi<Summary>(`/api/foundation/${entity.id}`);
  const s = data.data;
  return (
    <>
      <PageHeader title={entity.name} description="How the foundation's investments are growing, what it has given away, and every movement of money over the last five years." />
      {data.error && <Banner>{data.error.message}</Banner>}
      {!s && data.loading && <Loading />}
      {s && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat
              label="Investments"
              value={wholeMoney(s.investments.value)}
              hint={s.investments.gain !== null ? `${signed(s.investments.gain)} over what was paid` : s.accounts.some((a) => a.investment) ? undefined : 'No investment account yet'}
            />
            <Stat label="Cash in the bank" value={wholeMoney(s.cash)} hint="Ready for grants" />
            <Stat label={`Grants given in ${s.year}`} value={wholeMoney(s.ytd.grant)} hint={`${wholeMoney(s.allTime.grant)} since the start`} />
            <Stat label={`Gifts received in ${s.year}`} value={wholeMoney(s.ytd.gift)} hint={`${wholeMoney(s.allTime.gift)} since the start`} />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <Card title="Investment growth" className="lg:col-span-2">
              <GrowthChart history={s.investments.history} costBasis={s.investments.costBasis} />
              <Holdings s={s} />
            </Card>
            <YearToDate s={s} />
          </div>

          <Calendar s={s} />
          <Movements s={s} />
        </>
      )}
    </>
  );
}

// The investments' value by day, with what was paid for them as a dashed line.
function GrowthChart({ history, costBasis }: { history: Summary['investments']['history']; costBasis: number | null }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!history.length) return <Empty>No investment balances yet. They're recorded each day once an investment account is connected.</Empty>;
  const W = 640;
  const H = 200;
  const pad = { l: 8, r: 8, t: 12, b: 4 };
  const times = history.map((p) => Date.parse(`${p.day}T12:00:00`));
  const t0 = times[0];
  const t1 = Math.max(times[times.length - 1], t0 + 86400000);
  const values = [...history.map((p) => p.value), ...(costBasis !== null ? [costBasis] : [])];
  const lo = Math.min(...values) * 0.97;
  const hi = Math.max(...values) * 1.02;
  const x = (t: number) => pad.l + ((t - t0) / (t1 - t0)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * (H - pad.t - pad.b);
  const path = history.map((p, i) => `${i ? 'L' : 'M'}${x(times[i]).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const area = `${path} L${x(times[times.length - 1]).toFixed(1)},${H - pad.b} L${x(t0).toFixed(1)},${H - pad.b} Z`;
  const shown = hover ?? history.length - 1;
  const point = history[shown];
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <div>
          <span className="text-2xl font-semibold tabular-nums">{wholeMoney(point.value)}</span>
          <span className="ml-2 text-slate-500 dark:text-slate-400">{dayText(point.day)}</span>
        </div>
        <div className="flex gap-3 text-xs text-slate-500 dark:text-slate-400">
          <span className="inline-flex items-center gap-1">
            <span className="h-0.5 w-4 bg-emerald-600" aria-hidden /> Value
          </span>
          {costBasis !== null && (
            <span className="inline-flex items-center gap-1">
              <span className="h-0 w-4 border-t-2 border-dashed border-slate-400" aria-hidden /> Paid in
            </span>
          )}
        </div>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-48 w-full text-emerald-600 dark:text-emerald-400"
        role="img"
        aria-label={`Investment value from ${dayText(history[0].day)} to ${dayText(history[history.length - 1].day)}, now ${wholeMoney(history[history.length - 1].value)}`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          const t = t0 + ((e.clientX - box.left) / box.width) * (t1 - t0);
          let best = 0;
          times.forEach((v, i) => Math.abs(v - t) < Math.abs(times[best] - t) && (best = i));
          setHover(best);
        }}
      >
        <path d={area} fill="currentColor" opacity="0.08" />
        {costBasis !== null && <line x1={pad.l} x2={W - pad.r} y1={y(costBasis)} y2={y(costBasis)} stroke="#94a3b8" strokeWidth="1.5" strokeDasharray="5 4" />}
        <path d={path} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />
        {history.map((p, i) => (
          <circle key={p.day} cx={x(times[i])} cy={y(p.value)} r={i === shown ? 4.5 : history.length < 20 ? 3 : 0} fill="currentColor" />
        ))}
      </svg>
      <div className="flex justify-between text-xs text-slate-500 dark:text-slate-400">
        <span>{dayText(history[0].day)}</span>
        <span>{dayText(history[history.length - 1].day)}</span>
      </div>
      {history.length < 10 && <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">The line fills in day by day as the investment balance is synced.</p>}
    </div>
  );
}

function Holdings({ s }: { s: Summary }) {
  if (!s.investments.holdings.length) return null;
  return (
    <ul className="mt-4 divide-y divide-slate-100 border-t border-slate-100 text-sm dark:divide-slate-800 dark:border-slate-800">
      {s.investments.holdings.map((h, i) => (
        <li key={i} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
          <span>
            <span className="font-medium">{h.symbol || h.description}</span>
            {h.symbol && <span className="ml-2 text-slate-500 dark:text-slate-400">{h.description}</span>}
          </span>
          <span className="tabular-nums">
            {wholeMoney(h.value)}
            {h.costBasis !== null && (
              <span className={cx('ml-2 text-xs', h.value >= h.costBasis ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400')}>{signed(h.value - h.costBasis)}</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

function YearToDate({ s }: { s: Summary }) {
  const guide = s.payoutGuide;
  const share = guide.amount > 0 ? Math.min(guide.givenThisYear / guide.amount, 1) : 0;
  return (
    <Card title={`${s.year} so far`}>
      <dl className="space-y-2 text-sm">
        {s.investments.changeThisYear !== null && s.investments.startOfYear && (
          <div className="flex justify-between gap-2">
            <dt className="text-slate-600 dark:text-slate-300">Investments since {dayText(s.investments.startOfYear.day)}</dt>
            <dd className={cx('font-medium tabular-nums', s.investments.changeThisYear >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400')}>
              {signed(s.investments.changeThisYear)}
            </dd>
          </div>
        )}
        {ORDER.map((k) => (
          <div key={k} className="flex justify-between gap-2">
            <dt className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
              <span className={cx('size-2 rounded-full', TYPES[k].dot)} aria-hidden />
              {TYPES[k].label}
            </dt>
            <dd className="tabular-nums">{s.ytd[k] ? money(s.ytd[k]) : '–'}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-5 border-t border-slate-100 pt-4 dark:border-slate-800">
        <div className="flex justify-between text-sm">
          <span className="font-medium">5% payout guide</span>
          <span className="tabular-nums">
            {wholeMoney(guide.givenThisYear)} of {wholeMoney(guide.amount)}
          </span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800" aria-hidden>
          <div className="h-full rounded-full bg-violet-500" style={{ width: `${share * 100}%` }} />
        </div>
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          About 5% of today&rsquo;s assets ({wholeMoney(s.assets)}). The required amount uses the year&rsquo;s average assets and can be paid by the end of the next year; confirm it with your CPA.
        </p>
      </div>
    </Card>
  );
}

// Five years by month: each movement of money as a coloured chip, with the year's totals.
function Calendar({ s }: { s: Summary }) {
  const byMonth = useMemo(() => {
    const map = new Map<string, Flow[]>();
    for (const t of s.transactions) {
      const month = t.date.slice(0, 7);
      const flows = map.get(month) || [];
      // A month's dividends and other small income show as one chip.
      const same = t.type === 'income' ? flows.find((f) => f.type === 'income') : undefined;
      if (same)
        map.set(
          month,
          flows.map((f) => (f === same ? { ...f, amount: f.amount + t.amount, description: `${f.description}, ${t.description}`, payee: null, checkNumber: null } : f)),
        );
      else map.set(month, [...flows, t]);
    }
    return map;
  }, [s.transactions]);
  const nowMonth = s.asOf.slice(0, 7);
  return (
    <Card title="Five-year calendar" className="mt-4" padded={false}>
      <div className="flex flex-wrap gap-x-4 gap-y-1 px-4 pt-3 text-xs text-slate-600 dark:text-slate-300">
        {ORDER.map((k) => (
          <span key={k} className="inline-flex items-center gap-1.5">
            <span className={cx('size-2 rounded-full', TYPES[k].dot)} aria-hidden />
            {TYPES[k].label}
          </span>
        ))}
      </div>
      <div className="overflow-x-auto p-4">
        <table className="w-full min-w-[50rem] table-fixed border-separate border-spacing-1 text-xs">
          <thead>
            <tr>
              <th className="w-14" />
              {MONTHS.map((m) => (
                <th key={m} className="font-medium text-slate-500 dark:text-slate-400">
                  {m}
                </th>
              ))}
              <th className="w-24 text-right font-medium text-slate-500 dark:text-slate-400">Year</th>
            </tr>
          </thead>
          <tbody>
            {[...s.years].reverse().map((y) => (
              <tr key={y.year}>
                <th className={cx('text-left align-top text-sm font-semibold', y.year === s.year && 'text-emerald-700 dark:text-emerald-400')}>{y.year}</th>
                {MONTHS.map((_, i) => {
                  const key = `${y.year}-${String(i + 1).padStart(2, '0')}`;
                  const flows = byMonth.get(key) || [];
                  const future = key > nowMonth;
                  return (
                    <td
                      key={key}
                      className={cx(
                        'h-14 rounded-md p-1 align-top',
                        future ? 'border border-dashed border-slate-200 dark:border-slate-800' : 'bg-slate-50 dark:bg-slate-800/40',
                        key === nowMonth && 'ring-2 ring-emerald-500/50',
                      )}
                    >
                      <div className="flex flex-col gap-0.5">
                        {flows.map((t) => (
                          <span
                            key={t.id}
                            className={cx('truncate rounded px-1 py-0.5 font-medium tabular-nums', TYPES[t.type].chip)}
                            title={`${dayText(t.date)} · ${TYPES[t.type].label} · ${money(Math.abs(t.amount))}\n${whoOf(t)}${t.memo ? ` (${t.memo})` : ''}${t.note ? `\n${t.note}` : ''}`}
                          >
                            {short(t.amount)}
                          </span>
                        ))}
                      </div>
                    </td>
                  );
                })}
                <td className="align-top">
                  <ul className="space-y-0.5 text-slate-600 dark:text-slate-300">
                    {ORDER.filter((k) => y.totals[k]).map((k) => (
                      <li key={k} className="flex items-center justify-between gap-1">
                        <span className={cx('size-2 shrink-0 rounded-full', TYPES[k].dot)} aria-label={TYPES[k].label} />
                        <span className="tabular-nums">{wholeMoney(y.totals[k])}</span>
                      </li>
                    ))}
                    {!ORDER.some((k) => y.totals[k]) && <li className="text-slate-400">–</li>}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// Every movement, newest first, with who it went to or came from.
function Movements({ s }: { s: Summary }) {
  const rows = s.transactions.slice().reverse();
  return (
    <Card
      title="All movements"
      className="mt-4"
      padded={false}
      actions={
        <Link to="/transactions" className="text-sm text-emerald-700 hover:underline dark:text-emerald-400">
          Open transactions
        </Link>
      }
    >
      {!rows.length ? (
        <Empty>No transactions yet.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className={TH}>Date</th>
                <th className={TH}>Kind</th>
                <th className={TH}>To or from</th>
                <th className={cx(TH, 'text-right')}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} className={TR}>
                  <td className={cx(TD, 'whitespace-nowrap')}>{dayText(t.date)}</td>
                  <td className={cx(TD, 'whitespace-nowrap')}>
                    <span className={cx('rounded px-1.5 py-0.5 text-xs font-medium', TYPES[t.type].chip)}>{TYPES[t.type].label}</span>
                  </td>
                  <td className={TD}>
                    {whoOf(t)}
                    {(t.memo || t.note) && <div className="text-xs text-slate-500 dark:text-slate-400">{t.memo || t.note}</div>}
                  </td>
                  <td className={cx(TD, 'text-right tabular-nums whitespace-nowrap', t.amount >= 0 ? 'text-emerald-700 dark:text-emerald-400' : '')}>{money(t.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
