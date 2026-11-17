// Wealth: net worth across every household account, investment and retirement accounts
// included, and accounts typed in by hand that nothing can import.
import { useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import { Allocation, Checks, Holdings, ImportPositions, Suggestions } from './WealthHoldings';
import { post, useApi } from '../api';
import { BankBadge } from '../banks';
import { wholeMoney } from '../format';
import { Banner, Button, Card, Confirm, Field, Input, Loading, PageHeader, Select, cx } from '../ui';

type Holder = 'me' | 'spouse' | 'joint';
interface WealthAccount {
  id: number;
  name: string;
  institution: string | null;
  kind: string;
  investType: string | null;
  holder: Holder | null;
  treatment: string;
  business: boolean;
  entity: string | null;
  balance: number | null;
  balanceDate: string | null;
  source: 'simplefin' | 'manual' | 'file';
  stale: boolean;
  removable: boolean;
  positions: { count: number; total: number; asOf: string } | null;
  suggestedType: string | null;
  suggestedHolder: Holder | null;
}
interface WealthData {
  accounts: WealthAccount[];
  businessAccounts: number;
  totals: { netWorth: number; assets: number; owed: number; invested: number; cash: number };
  byTreatment: { key: string; label: string; amount: number }[];
  byHolder: { holder: Holder | null; amount: number }[];
  history: { day: string; netWorth: number; invested: number }[];
  types: { key: string; label: string; treatment: string }[];
  allocation: { key: string; label: string; amount: number; share: number }[];
  topHoldings: { symbol: string | null; description: string; value: number; share: number; assetClass: string; accounts: string[] }[];
  notBrokenDown: { id: number; name: string; balance: number; countedAs: string | null }[];
  checks: { key: string; title: string; detail: string; accountIds: number[] }[];
  investedTotal: number;
  classes: { key: string; label: string }[];
}

const HOLDER_LABELS: Record<Holder, string> = { me: 'You', spouse: 'Spouse', joint: 'Joint' };
// The order and colour of each tax treatment, the same everywhere on the page.
const TREATMENT: Record<string, { label: string; colour: string; hint: string }> = {
  cash: { label: 'Cash', colour: '#64748b', hint: 'Checking and savings' },
  taxable: { label: 'Taxable', colour: '#d97706', hint: 'Brokerage, company stock: gains taxed when sold' },
  pre_tax: { label: 'Pre-tax', colour: '#0d9488', hint: '401(k), IRA, pension: taxed as income when taken out' },
  roth: { label: 'Roth', colour: '#7c3aed', hint: 'Tax-free when taken out' },
  hsa: { label: 'Health savings', colour: '#0284c7', hint: 'Tax-free for health costs' },
  education: { label: 'Education', colour: '#db2777', hint: '529 plans' },
  owed: { label: 'Owed', colour: '#e11d48', hint: 'Cards and loans' },
};
const SOURCE_LABELS = { simplefin: 'SimpleFIN', manual: 'Typed in', file: 'From files' };
const dayLabel = (day: string | null) => (day ? new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'no balance');

export type { WealthAccount, WealthData, Holder };
export { HOLDER_LABELS };

export function Wealth() {
  const [business, setBusiness] = useState(false);
  const { data, error, reload } = useApi<WealthData>(`/api/wealth${business ? '?business=1' : ''}`);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);

  if (error) return <Banner>{error.message}</Banner>;
  if (!data) return <Loading />;
  const typeLabel = (key: string | null) => data.types.find((t) => t.key === key)?.label ?? 'Investment';
  const investments = data.accounts.filter((a) => a.kind === 'investment');
  const everyday = data.accounts.filter((a) => a.kind !== 'investment');

  return (
    <>
      <PageHeader
        title="Wealth"
        description="Everything the household owns and owes, with each account's tax treatment for retirement planning."
        actions={
          <>
            {data.businessAccounts > 0 && (
              <label className="inline-flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
                <input type="checkbox" className="size-4 accent-emerald-600" checked={business} onChange={(e) => setBusiness(e.target.checked)} />
                Include business accounts
              </label>
            )}
            <Button onClick={() => setImporting(true)}>
              <Upload className="size-4" aria-hidden />
              Import positions
            </Button>
            <Button variant="primary" onClick={() => setAdding(true)}>
              <Plus className="size-4" aria-hidden />
              Add an account
            </Button>
          </>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Net worth" value={data.totals.netWorth} hint={<Change history={data.history} />} strong />
        <Tile label="Invested" value={data.totals.invested} hint={`${investments.length} investment ${investments.length === 1 ? 'account' : 'accounts'}`} />
        <Tile label="Cash" value={data.totals.cash} hint="Checking and savings" />
        <Tile label="Owed" value={data.totals.owed} hint="Cards and loans" />
      </div>

      <div className="mb-5 grid gap-5 lg:grid-cols-[3fr_2fr]">
        <Card title="Net worth over time">
          <History points={data.history} />
        </Card>
        <Card title="By tax treatment">
          <Treatments rows={data.byTreatment} />
          {data.byHolder.length > 0 && (
            <div className="mt-4 border-t border-slate-100 pt-3 dark:border-slate-800">
              <h3 className="mb-2 text-xs font-medium tracking-wide text-slate-500 uppercase">Invested, by whose</h3>
              <ul className="space-y-1 text-sm">
                {data.byHolder.map((h) => (
                  <li key={h.holder ?? 'none'} className="flex justify-between gap-3">
                    <span className={cx(!h.holder && 'text-amber-700 dark:text-amber-400')}>{h.holder ? HOLDER_LABELS[h.holder] : 'Not chosen yet'}</span>
                    <span className="tabular-nums">{wholeMoney(h.amount)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      </div>

      <Suggestions accounts={data.accounts} typeLabel={typeLabel} onChange={reload} />
      {importing && <ImportPositions onClose={() => setImporting(false)} onSaved={reload} />}

      {data.allocation.length > 0 && (
        <div className="mb-5 grid gap-5 lg:grid-cols-[3fr_2fr]">
          <Card title="What the invested money is in">
            <Allocation data={data} />
          </Card>
          <Card title="Worth a look">
            <Checks checks={data.checks} />
          </Card>
        </div>
      )}

      {adding && <AddAccount types={data.types} onClose={() => setAdding(false)} onSaved={reload} />}

      <Card title="Investment and retirement accounts" className="mb-5" padded={false}>
        {!investments.length ? (
          <p className="p-4 text-sm text-slate-600 dark:text-slate-400">
            None yet. Brokerage and retirement accounts connected in SimpleFIN appear here on the next sync; choose a kind for any that land in{' '}
            <Link to="/accounts" className="underline">
              Accounts
            </Link>{' '}
            as Other. Add a pension, deferred compensation or any account nothing can import with <strong>Add an account</strong>.
          </p>
        ) : (
          <AccountList accounts={investments} types={data.types} typeLabel={typeLabel} onChange={reload} classes={data.classes} />
        )}
      </Card>

      <Card title="Everyday accounts" padded={false}>
        <AccountList accounts={everyday} types={data.types} typeLabel={typeLabel} onChange={reload} />
      </Card>
      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
        Family members' accounts stay in their own My money. History starts from the first balance recorded for each account; type in older balances to fill it in.
      </p>
    </>
  );
}

function Tile({ label, value, hint, strong }: { label: string; value: number; hint?: ReactNode; strong?: boolean }) {
  return (
    <div className="min-w-0 rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="text-xs font-medium text-slate-600 dark:text-slate-400">{label}</div>
      <div className={cx('mt-1 truncate font-semibold tabular-nums', strong ? 'text-2xl text-emerald-700 dark:text-emerald-400' : 'text-xl', value < 0 && 'text-rose-700 dark:text-rose-400')}>{wholeMoney(value)}</div>
      {hint && <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{hint}</div>}
    </div>
  );
}

// How net worth moved over the last 30 days of history.
function Change({ history }: { history: WealthData['history'] }) {
  if (history.length < 2) return <>Starting today</>;
  const last = history[history.length - 1];
  const cutoff = new Date(Date.parse(last.day) - 30 * 86400000).toISOString().slice(0, 10);
  const from = [...history].reverse().find((p) => p.day <= cutoff) ?? history[0];
  const diff = last.netWorth - from.netWorth;
  return (
    <span className={diff >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'}>
      {diff >= 0 ? '+' : '−'}
      {wholeMoney(Math.abs(diff))} since {dayLabel(from.day)}
    </span>
  );
}

function History({ points }: { points: WealthData['history'] }) {
  const W = 640;
  const H = 220;
  const L = 64;
  const R = 12;
  const T = 12;
  const B = 26;
  const chart = useMemo(() => {
    if (points.length < 2) return null;
    const t0 = Date.parse(points[0].day);
    const t1 = Date.parse(points[points.length - 1].day);
    const values = points.flatMap((p) => [p.netWorth, p.invested]);
    let lo = Math.min(0, ...values);
    let hi = Math.max(...values);
    if (hi === lo) hi = lo + 1;
    // Round the scale to tidy steps.
    const raw = (hi - lo) / 4;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
    lo = Math.floor(lo / step) * step;
    hi = Math.ceil(hi / step) * step;
    const x = (day: string) => L + ((Date.parse(day) - t0) / Math.max(1, t1 - t0)) * (W - L - R);
    const y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const line = (key: 'netWorth' | 'invested') => points.map((p, i) => `${i ? 'L' : 'M'}${x(p.day).toFixed(1)} ${y(p[key]).toFixed(1)}`).join(' ');
    const ticks: number[] = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(v);
    const days = [points[0].day, points[Math.floor(points.length / 2)].day, points[points.length - 1].day];
    return { x, y, line, ticks, days, lo };
  }, [points]);

  if (!chart) return <p className="py-10 text-center text-sm text-slate-500">The line starts once balances have been recorded on two different days.</p>;
  const last = points[points.length - 1];
  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`Net worth from ${dayLabel(points[0].day)} to ${dayLabel(last.day)}`}>
        {chart.ticks.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={chart.y(v)} y2={chart.y(v)} className="stroke-slate-200 dark:stroke-slate-800" />
            <text x={L - 8} y={chart.y(v) + 4} textAnchor="end" className="fill-slate-500 text-[11px]">
              {Math.abs(v) >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1e3)}K`}
            </text>
          </g>
        ))}
        {chart.days.map((d, i) => (
          <text key={`${d}-${i}`} x={chart.x(d)} y={H - 6} textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'} className="fill-slate-500 text-[11px]">
            {dayLabel(d)}
          </text>
        ))}
        <path d={`${chart.line('netWorth')} L${chart.x(last.day)} ${chart.y(chart.lo)} L${L} ${chart.y(chart.lo)} Z`} className="fill-emerald-500/10" />
        <path d={chart.line('invested')} fill="none" strokeWidth={1.5} strokeDasharray="4 3" className="stroke-teal-600 dark:stroke-teal-400" />
        <path d={chart.line('netWorth')} fill="none" strokeWidth={2.2} className="stroke-emerald-600 dark:stroke-emerald-400" />
        <circle cx={chart.x(last.day)} cy={chart.y(last.netWorth)} r={4} className="fill-emerald-600 dark:fill-emerald-400" />
      </svg>
      <div className="mt-1 flex gap-4 text-xs text-slate-500">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-4 bg-emerald-600" aria-hidden />
          Net worth
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0 w-4 border-t-2 border-dashed border-teal-600" aria-hidden />
          Invested
        </span>
      </div>
    </>
  );
}

function Treatments({ rows }: { rows: WealthData['byTreatment'] }) {
  const owned = rows.filter((r) => r.amount > 0);
  const total = owned.reduce((s, r) => s + r.amount, 0);
  if (!rows.length) return <p className="text-sm text-slate-500">No balances yet.</p>;
  return (
    <>
      {total > 0 && (
        <div className="mb-3 flex h-3 overflow-hidden rounded" aria-hidden>
          {owned.map((r) => (
            <span key={r.key} style={{ width: `${(r.amount / total) * 100}%`, background: TREATMENT[r.key]?.colour }} />
          ))}
        </div>
      )}
      <ul className="space-y-2 text-sm">
        {rows.map((r) => (
          <li key={r.key} className="flex items-start gap-2">
            <span className="mt-1.5 size-2.5 shrink-0 rounded-sm" style={{ background: TREATMENT[r.key]?.colour }} aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="font-medium">{TREATMENT[r.key]?.label ?? r.label}</span>
              <span className="block text-xs text-slate-500">{TREATMENT[r.key]?.hint}</span>
            </span>
            <span className="tabular-nums">
              {wholeMoney(r.amount)}
              {r.amount > 0 && total > 0 && <span className="ml-1.5 text-xs text-slate-500">{Math.round((r.amount / total) * 100)}%</span>}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

function AccountList({ accounts, types, typeLabel, onChange, classes }: { accounts: WealthAccount[]; types: WealthData['types']; typeLabel: (k: string | null) => string; onChange: () => void; classes?: WealthData['classes'] }) {
  const [editing, setEditing] = useState<number | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  if (!accounts.length) return <p className="p-4 text-sm text-slate-500">None.</p>;
  return (
    <ul className="divide-y divide-slate-100 dark:divide-slate-800">
      {accounts.map((a) => (
        <li key={a.id} className="px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <BankBadge institution={a.institution} accountName={a.name} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{a.name}</span>
              <span className="flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
                <span className="inline-flex items-center gap-1">
                  <span className="size-2 rounded-sm" style={{ background: TREATMENT[a.treatment]?.colour }} aria-hidden />
                  {a.kind === 'investment' ? typeLabel(a.investType) : TREATMENT[a.treatment]?.label}
                </span>
                {a.holder && <span>· {HOLDER_LABELS[a.holder]}</span>}
                {a.business && <span>· {a.entity ?? 'Business'}</span>}
                <span>
                  · {SOURCE_LABELS[a.source]}, {dayLabel(a.balanceDate)}
                </span>
                {a.positions && classes && (
                  <button type="button" className="text-emerald-700 underline dark:text-emerald-400" aria-expanded={open === a.id} onClick={() => setOpen(open === a.id ? null : a.id)}>
                    · {a.positions.count} {a.positions.count === 1 ? 'holding' : 'holdings'} as of {dayLabel(a.positions.asOf)}
                  </button>
                )}
                {a.stale && (
                  <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="size-3" aria-hidden />
                    {a.source === 'manual' ? 'update the balance' : 'not synced lately'}
                  </span>
                )}
              </span>
            </span>
            <span className={cx('font-semibold tabular-nums', (a.balance ?? 0) < 0 && 'text-rose-700 dark:text-rose-400')}>{a.balance === null ? '–' : wholeMoney(a.balance)}</span>
            <button
              type="button"
              onClick={() => setEditing(editing === a.id ? null : a.id)}
              className="rounded p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
              aria-label={`Change ${a.name}`}
              aria-expanded={editing === a.id}
            >
              <Pencil className="size-4" aria-hidden />
            </button>
          </div>
          {open === a.id && classes && <Holdings accountId={a.id} classes={classes} onChange={onChange} />}
          {editing === a.id && <EditAccount account={a} types={types} onDone={() => setEditing(null)} onChange={onChange} />}
        </li>
      ))}
    </ul>
  );
}

const today = () => new Date().toISOString().slice(0, 10);

function EditAccount({ account, types, onDone, onChange }: { account: WealthAccount; types: WealthData['types']; onDone: () => void; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [balance, setBalance] = useState('');
  const [day, setDay] = useState(today());
  const [removing, setRemoving] = useState(false);
  const owed = account.kind === 'credit' || account.kind === 'loan';

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setProblem('');
    try {
      await action();
      onChange();
      return true;
    } catch (e) {
      setProblem((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function saveBalance(event: FormEvent) {
    event.preventDefault();
    if (await run(() => post(`/api/wealth/accounts/${account.id}/balance`, { balance: Number(balance.replace(/[$,\s]/g, '')), day }))) setBalance('');
  }

  return (
    <div className="mt-3 grid gap-3 rounded-lg bg-slate-50 p-3 dark:bg-slate-800/60">
      {problem && <Banner>{problem}</Banner>}
      {!owed && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Kind of account" hint="Decides how it's taxed when spent">
            <Select value={account.kind === 'investment' ? account.investType ?? 'other' : ''} disabled={busy} onChange={(e) => run(() => post(`/api/wealth/accounts/${account.id}`, { investType: e.target.value || null }))}>
              <option value="">Not an investment (checking, savings)</option>
              {types.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Whose">
            <Select value={account.holder ?? ''} disabled={busy} onChange={(e) => run(() => post(`/api/wealth/accounts/${account.id}`, { holder: e.target.value || null }))}>
              <option value="">Not chosen</option>
              {(Object.keys(HOLDER_LABELS) as Holder[]).map((h) => (
                <option key={h} value={h}>
                  {HOLDER_LABELS[h]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}
      <form onSubmit={saveBalance} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Field label={account.source === 'manual' ? 'New balance' : 'Balance on a past day'} hint={account.source === 'manual' ? undefined : 'Fills in history; the feed keeps today’s'}>
          <Input inputMode="decimal" value={balance} onChange={(e) => setBalance(e.target.value)} placeholder="250,000" />
        </Field>
        <Field label="As of">
          <Input type="date" value={day} max={today()} onChange={(e) => setDay(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" busy={busy} disabled={!balance.trim() || !Number.isFinite(Number(balance.replace(/[$,\s]/g, '')))}>
          Save balance
        </Button>
      </form>
      <div className="flex flex-wrap justify-between gap-2">
        {account.removable ? (
          <Button variant="danger" onClick={() => setRemoving(true)}>
            <Trash2 className="size-4" aria-hidden />
            Remove account
          </Button>
        ) : (
          <span />
        )}
        <Button onClick={onDone}>Done</Button>
      </div>
      <Confirm
        open={removing}
        title={`Remove ${account.name}?`}
        confirmLabel="Remove"
        busy={busy}
        onCancel={() => setRemoving(false)}
        onConfirm={async () => {
          if (await run(() => post(`/api/wealth/accounts/${account.id}/delete`))) onDone();
          setRemoving(false);
        }}
      >
        Its balance history goes with it.
      </Confirm>
    </div>
  );
}

function AddAccount({ types, onClose, onSaved }: { types: WealthData['types']; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ name: '', institution: '', investType: 'pension', holder: 'me', balance: '', day: today() });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const amount = Number(form.balance.replace(/[$,\s]/g, ''));

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setProblem('');
    try {
      await post('/api/wealth/accounts', {
        name: form.name.trim(),
        institution: form.institution.trim() || null,
        investType: form.investType,
        holder: form.holder || null,
        balance: amount,
        day: form.day,
      });
      onSaved();
      onClose();
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Add an account nothing can import" className="mb-5">
      {problem && <Banner>{problem}</Banner>}
      <form onSubmit={save} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Name">
          <Input autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Such as Employer pension" maxLength={100} />
        </Field>
        <Field label="Held at" hint="Optional">
          <Input value={form.institution} onChange={(e) => setForm({ ...form, institution: e.target.value })} placeholder="Such as Fidelity" maxLength={100} />
        </Field>
        <Field label="Kind">
          <Select value={form.investType} onChange={(e) => setForm({ ...form, investType: e.target.value })}>
            {types.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Whose">
          <Select value={form.holder} onChange={(e) => setForm({ ...form, holder: e.target.value })}>
            {(Object.keys(HOLDER_LABELS) as Holder[]).map((h) => (
              <option key={h} value={h}>
                {HOLDER_LABELS[h]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Balance or value" hint={form.investType === 'pension' ? 'The lump-sum value, if the statement gives one. The monthly income comes in the retirement plan.' : undefined}>
          <Input inputMode="decimal" value={form.balance} onChange={(e) => setForm({ ...form, balance: e.target.value })} placeholder="0" />
        </Field>
        <Field label="As of">
          <Input type="date" value={form.day} max={today()} onChange={(e) => setForm({ ...form, day: e.target.value })} />
        </Field>
        <div className="flex gap-2 sm:col-span-2 lg:col-span-3">
          <Button type="submit" variant="primary" busy={busy} disabled={!form.name.trim() || !form.balance.trim() || !Number.isFinite(amount)}>
            Add
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}
