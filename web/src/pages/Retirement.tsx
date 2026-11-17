// The retirement plan: who, when, what comes in and goes out, and the markets, with a
// year-by-year projection in today's dollars that updates as the plan changes.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Trash2 } from 'lucide-react';
import { post, useApi } from '../api';
import { wholeMoney } from '../format';
import { Banner, Button, Card, Field, Input, Loading, PageHeader, Select, cx } from '../ui';

type Bucket = 'cash' | 'taxable' | 'pre_tax' | 'pre_tax_spouse' | 'deferred' | 'hsa' | 'roth';
type Balances = Record<Bucket, number>;
interface Person {
  name: string;
  birthYear: number;
  retireAge: number;
  planToAge: number;
  takeHome: number;
  contributions: { pre_tax: number; roth: number; hsa: number; deferred?: number };
  ssAtFullAge: number;
  ssClaimAge: number;
}
interface Stream {
  name: string;
  owner: 'me' | 'spouse';
  startAge: number;
  endAge: number | null;
  yearly: number;
  inflationAdjusted: boolean;
  taxable?: boolean;
}
interface LifeEvent {
  name: string;
  year: number;
  years: number;
  amount: number;
}
interface Markets {
  stocks: number;
  bonds: number;
  cash: number;
  inflation: number;
}
interface Plan {
  me: Person;
  spouse: Person | null;
  spending: number;
  spendingChangeAt80: number;
  markets: Markets;
  streams: Stream[];
  events: LifeEvent[];
  taxes?: TaxPlan;
}
interface TaxPlan {
  enabled: boolean;
  state: string;
  stateRate?: number;
  stateDeduction?: number;
  rothConversionsTo: number | null;
  withdrawalOrder: 'standard' | 'pretax_first';
  deferredYears: number;
}
interface StateOption {
  key: string;
  label: string;
  rate: number;
  deduction: number;
}
interface Row {
  year: number;
  ages: [number | null, number | null];
  pay: number;
  socialSecurity: number;
  other: number;
  events: number;
  spending: number;
  contributions: number;
  growth: number;
  rmd: number;
  deferredPaid: number;
  conversion: number;
  gains: number;
  tax: { federal: number; state: number };
  taxableOrdinary: number;
  withdrawn: Balances;
  saved: number;
  shortfall: number;
  end: Balances;
  total: number;
}
interface Projection {
  rows: Row[];
  returns: { invested: number; cash: number };
  socialSecurity: { me: number; spouse: number | null };
  runsOut: { year: number; ages: [number | null, number | null] } | null;
  atRetirement: { year: number; total: number } | null;
  atEnd: number;
  lifetimeTax: number;
  rmdStarts: { me: number; spouse: number | null };
}
interface Data {
  plan: Plan | null;
  start: {
    balances: Balances;
    left: { name: string; balance: number; why: string }[];
    mix: { stocks: number; bonds: number; cash: number };
    spending: { amount: number; from: string; to: string; firstMonth: string | null };
  };
  defaults: { markets: Markets; taxes: TaxPlan };
  states: StateOption[];
  taxYear: number;
  projection: Projection | null;
  startYear: number;
}

const BUCKETS: { key: Bucket; label: string; colour: string }[] = [
  { key: 'cash', label: 'Cash', colour: '#64748b' },
  { key: 'taxable', label: 'Taxable', colour: '#d97706' },
  { key: 'pre_tax', label: 'Pre-tax', colour: '#0d9488' },
  { key: 'pre_tax_spouse', label: 'Pre-tax, spouse', colour: '#14b8a6' },
  { key: 'deferred', label: 'Deferred comp', colour: '#65a30d' },
  { key: 'hsa', label: 'Health savings', colour: '#0284c7' },
  { key: 'roth', label: 'Roth', colour: '#7c3aed' },
];
const newPerson = (name: string, birthYear: number): Person => ({ name, birthYear, retireAge: 65, planToAge: 95, takeHome: 0, contributions: { pre_tax: 0, roth: 0, hsa: 0, deferred: 0 }, ssAtFullAge: 0, ssClaimAge: 67 });
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const short = (n: number) => (Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : `$${Math.round(n / 1e3)}K`);
const ageText = (ages: [number | null, number | null]) => ages.filter((a) => a !== null).join(' / ');

// A number field that keeps what's typed until it's a number. Percent fields show 7 for 0.07.
function Num({ value, onChange, percent, step, ...rest }: { value: number; onChange: (n: number) => void; percent?: boolean; step?: string; 'aria-label'?: string; className?: string }) {
  const shown = percent ? +(value * 100).toFixed(2) : value;
  const [text, setText] = useState(String(shown));
  const last = useRef(shown);
  if (last.current !== shown && Number(text.replace(/[$,%\s]/g, '')) !== shown) {
    last.current = shown;
    setText(String(shown));
  }
  return (
    <Input
      {...rest}
      inputMode="decimal"
      value={text}
      step={step}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value.replace(/[$,%\s]/g, ''));
        if (e.target.value.trim() !== '' && Number.isFinite(n)) {
          last.current = n;
          onChange(percent ? n / 100 : n);
        }
      }}
    />
  );
}

export function Retirement() {
  const { data, error } = useApi<Data>('/api/retirement');
  if (error) return <Banner>{error.message}</Banner>;
  if (!data) return <Loading />;
  return <Planner data={data} />;
}

function Planner({ data }: { data: Data }) {
  const [plan, setPlan] = useState<Plan>(
    () =>
      (data.plan && { ...data.plan, taxes: { ...data.defaults.taxes, ...data.plan.taxes } }) || {
        me: newPerson('You', data.startYear - 55),
        spouse: newPerson('Spouse', data.startYear - 53),
        spending: Math.round(data.start.spending.amount / 1000) * 1000,
        spendingChangeAt80: -0.1,
        markets: data.defaults.markets,
        streams: [],
        events: [],
        taxes: data.defaults.taxes,
      }
  );
  const taxes = { ...data.defaults.taxes, ...plan.taxes };
  const setTaxes = (change: Partial<TaxPlan>) => setPlan((p) => ({ ...p, taxes: { ...data.defaults.taxes, ...p.taxes, ...change } }));
  const [projection, setProjection] = useState<Projection | null>(data.projection);
  const [problem, setProblem] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedPlan, setSavedPlan] = useState(JSON.stringify(data.plan));
  const changed = JSON.stringify(plan) !== savedPlan;

  // Works the plan out again shortly after each change, without saving it.
  useEffect(() => {
    const timer = setTimeout(async () => {
      try {
        setProjection(await post<Projection>('/api/retirement/preview', plan));
        setProblem('');
      } catch (e) {
        setProblem((e as Error).message);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [plan]);

  async function save() {
    setSaving(true);
    try {
      await post('/api/retirement/plan', plan);
      setSavedPlan(JSON.stringify(plan));
      setProblem('');
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const people: { key: 'me' | 'spouse'; person: Person }[] = [{ key: 'me', person: plan.me }, ...(plan.spouse ? [{ key: 'spouse' as const, person: plan.spouse }] : [])];
  const setPerson = (key: 'me' | 'spouse', change: Partial<Person>) => setPlan((p) => ({ ...p, [key]: { ...(p[key] as Person), ...change } }));
  const total = Object.values(data.start.balances).reduce((s, n) => s + n, 0);

  return (
    <>
      <PageHeader
        title="Retirement plan"
        description={`A year-by-year plan on steady returns, in today's dollars, after federal and state tax on ${data.taxYear} rules, with required withdrawals.`}
        actions={
          <Button variant="primary" busy={saving} disabled={!changed} onClick={save}>
            {changed ? 'Save plan' : 'Saved'}
          </Button>
        }
      />
      {problem && <Banner>{problem}</Banner>}
      {projection && <Results projection={projection} plan={plan} />}

      <div className="mb-5 grid gap-5 lg:grid-cols-2">
        <Card title="Starting point">
          <ul className="mb-3 space-y-1 text-sm">
            {BUCKETS.map((b) => (
              <li key={b.key} className="flex items-center gap-2">
                <span className="size-2.5 rounded-sm" style={{ background: b.colour }} aria-hidden />
                <span className="flex-1">{b.label}</span>
                <span className="tabular-nums">{wholeMoney(data.start.balances[b.key])}</span>
              </li>
            ))}
            <li className="flex justify-between border-t border-slate-100 pt-1 font-medium dark:border-slate-800">
              <span>Total</span>
              <span className="tabular-nums">{wholeMoney(total)}</span>
            </li>
          </ul>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            From <Link to="/wealth" className="underline">Wealth</Link>, household accounts only (not a business's or the foundation's).
            {data.start.left.length > 0 && ` Left out: ${data.start.left.map((l) => `${l.name} (${l.why === 'owed' ? 'owed' : 'education'})`).join(', ')}.`} Invested money is {pct(data.start.mix.stocks)} stocks, {pct(data.start.mix.bonds)} bonds and {pct(data.start.mix.cash)} cash
            (target-date funds as 60/40), so it earns {projection ? pct(projection.returns.invested) : '…'} a year after inflation; bank cash earns {projection ? pct(projection.returns.cash) : '…'}.
          </p>
        </Card>
        <Card title="Spending and markets">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Yearly spending, today's dollars" hint={`My money, last 12 months: ${wholeMoney(data.start.spending.amount)}`}>
              <Num value={plan.spending} onChange={(spending) => setPlan({ ...plan, spending })} />
            </Field>
            <Field label="Change once the older is 80" hint="−10 spends 10% less">
              <Num percent value={plan.spendingChangeAt80} onChange={(spendingChangeAt80) => setPlan({ ...plan, spendingChangeAt80 })} />
            </Field>
            {(['stocks', 'bonds', 'cash', 'inflation'] as const).map((k) => (
              <Field key={k} label={k === 'inflation' ? 'Inflation, % a year' : `${k[0].toUpperCase()}${k.slice(1)} return, % a year`} hint={k === 'inflation' ? undefined : 'Before inflation'}>
                <Num percent value={plan.markets[k]} onChange={(n) => setPlan({ ...plan, markets: { ...plan.markets, [k]: n } })} />
              </Field>
            ))}
          </div>
          {data.start.spending.firstMonth && data.start.spending.firstMonth > data.start.spending.from && (
            <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">My money only has data from {data.start.spending.firstMonth}, so its last-12-months figure is short.</p>
          )}
        </Card>
      </div>

      <Card
        title="People"
        className="mb-5"
        actions={
          <label className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-emerald-600" checked={Boolean(plan.spouse)} onChange={(e) => setPlan({ ...plan, spouse: e.target.checked ? newPerson('Spouse', plan.me.birthYear + 2) : null })} />
            Plan for two
          </label>
        }
      >
        <div className="grid gap-5 lg:grid-cols-2">
          {people.map(({ key, person }) => (
            <fieldset key={key} className="grid gap-3 sm:grid-cols-2">
              <legend className="mb-2 text-sm font-semibold">{key === 'me' ? 'You' : 'Spouse'}</legend>
              <Field label="Name">
                <Input value={person.name} maxLength={40} onChange={(e) => setPerson(key, { name: e.target.value })} />
              </Field>
              <Field label="Born in">
                <Num value={person.birthYear} onChange={(birthYear) => setPerson(key, { birthYear })} />
              </Field>
              <Field label="Retire at age">
                <Num value={person.retireAge} onChange={(retireAge) => setPerson(key, { retireAge })} />
              </Field>
              <Field label="Plan to age">
                <Num value={person.planToAge} onChange={(planToAge) => setPerson(key, { planToAge })} />
              </Field>
              <Field label="Take-home pay a year" hint="After tax and contributions, until retiring">
                <Num value={person.takeHome} onChange={(takeHome) => setPerson(key, { takeHome })} />
              </Field>
              <Field label="Into 401(k) and pre-tax a year" hint="Match included">
                <Num value={person.contributions.pre_tax} onChange={(n) => setPerson(key, { contributions: { ...person.contributions, pre_tax: n } })} />
              </Field>
              <Field label="Into Roth a year">
                <Num value={person.contributions.roth} onChange={(n) => setPerson(key, { contributions: { ...person.contributions, roth: n } })} />
              </Field>
              <Field label="Into deferred comp a year" hint="An excess or nonqualified plan, match included">
                <Num value={person.contributions.deferred ?? 0} onChange={(n) => setPerson(key, { contributions: { ...person.contributions, deferred: n } })} />
              </Field>
              <Field label="Into HSA a year">
                <Num value={person.contributions.hsa} onChange={(n) => setPerson(key, { contributions: { ...person.contributions, hsa: n } })} />
              </Field>
              <Field label="Social Security at full age, a month" hint="From your ssa.gov statement">
                <Num value={person.ssAtFullAge} onChange={(ssAtFullAge) => setPerson(key, { ssAtFullAge })} />
              </Field>
              <Field label="Claim at age" hint="62 to 70">
                <Num value={person.ssClaimAge} onChange={(ssClaimAge) => setPerson(key, { ssClaimAge })} />
              </Field>
            </fieldset>
          ))}
        </div>
        <p className="mt-3 text-xs text-slate-500">Left-over take-home pay, after spending, is saved in the taxable account each year.</p>
      </Card>

      <Card
        title="Taxes"
        className="mb-5"
        actions={
          <label className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-emerald-600" checked={taxes.enabled} onChange={(e) => setTaxes({ enabled: e.target.checked })} />
            Work out taxes
          </label>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="State in retirement">
            <Select value={taxes.state} disabled={!taxes.enabled} onChange={(e) => setTaxes({ state: e.target.value })}>
              {data.states.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </Select>
          </Field>
          {taxes.state === 'custom' && (
            <>
              <Field label="State rate, %" hint="A flat rate on income">
                <Num percent value={taxes.stateRate ?? 0.05} onChange={(stateRate) => setTaxes({ stateRate })} />
              </Field>
              <Field label="State deduction, a couple">
                <Num value={taxes.stateDeduction ?? 0} onChange={(stateDeduction) => setTaxes({ stateDeduction })} />
              </Field>
            </>
          )}
          <Field label="Roth conversions" hint="From retiring until RMDs start">
            <Select value={taxes.rothConversionsTo ?? ''} disabled={!taxes.enabled} onChange={(e) => setTaxes({ rothConversionsTo: e.target.value ? Number(e.target.value) : null })}>
              <option value="">None</option>
              {[0.12, 0.22, 0.24, 0.32].map((r) => (
                <option key={r} value={r}>
                  Fill the {Math.round(r * 100)}% bracket
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Take money from">
            <Select value={taxes.withdrawalOrder} onChange={(e) => setTaxes({ withdrawalOrder: e.target.value as TaxPlan['withdrawalOrder'] })}>
              <option value="standard">Taxable first, then pre-tax, then Roth</option>
              <option value="pretax_first">Pre-tax first, then taxable, then Roth</option>
            </Select>
          </Field>
          <Field label="Deferred comp paid over, years" hint="Starting the year after you retire">
            <Num value={taxes.deferredYears} onChange={(deferredYears) => setTaxes({ deferredYears })} />
          </Field>
        </div>
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
          Married filing jointly while both are alive, single after. Pay while working is take-home, so it isn't taxed again here. Selling taxable holdings is taxed at long-term gains rates on the
          gain over what was paid. RMDs start in {projection?.rmdStarts.me ?? '…'}
          {plan.spouse && projection?.rmdStarts.spouse ? ` (${plan.spouse.name}: ${projection.rmdStarts.spouse})` : ''}. Brackets rise with inflation, so {data.taxYear} rules apply to every year.
        </p>
      </Card>

      <div className="mb-5 grid gap-5 lg:grid-cols-2">
        <Card
          title="Pensions and other income"
          actions={
            <Button onClick={() => setPlan({ ...plan, streams: [...plan.streams, { name: 'Pension', owner: 'me', startAge: 65, endAge: null, yearly: 0, inflationAdjusted: false }] })}>
              <Plus className="size-4" aria-hidden />
              Add
            </Button>
          }
        >
          {!plan.streams.length && <p className="text-sm text-slate-500">A pension, annuity or rent that comes in each year from an age.</p>}
          <ul className="space-y-3">
            {plan.streams.map((s, i) => {
              const set = (change: Partial<Stream>) => setPlan({ ...plan, streams: plan.streams.map((x, j) => (j === i ? { ...x, ...change } : x)) });
              return (
                <li key={i} className="grid gap-2 rounded-lg bg-slate-50 p-3 sm:grid-cols-3 dark:bg-slate-800/60">
                  <Field label="Name">
                    <Input value={s.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} />
                  </Field>
                  <Field label="Whose">
                    <Select value={s.owner} onChange={(e) => set({ owner: e.target.value as 'me' | 'spouse' })}>
                      <option value="me">{plan.me.name}</option>
                      {plan.spouse && <option value="spouse">{plan.spouse.name}</option>}
                    </Select>
                  </Field>
                  <Field label="A year">
                    <Num value={s.yearly} onChange={(yearly) => set({ yearly })} />
                  </Field>
                  <Field label="From age">
                    <Num value={s.startAge} onChange={(startAge) => set({ startAge })} />
                  </Field>
                  <Field label="Until age" hint="Blank for life">
                    <Input inputMode="numeric" value={s.endAge ?? ''} onChange={(e) => set({ endAge: e.target.value.trim() && Number.isFinite(Number(e.target.value)) ? Number(e.target.value) : null })} />
                  </Field>
                  <div className="flex items-end justify-between gap-2">
                    <label className="inline-flex items-center gap-2 pb-2 text-xs">
                      <input type="checkbox" className="size-4 accent-emerald-600" checked={s.inflationAdjusted} onChange={(e) => set({ inflationAdjusted: e.target.checked })} />
                      Rises with inflation
                    </label>
                    <label className="inline-flex items-center gap-2 pb-2 text-xs">
                      <input type="checkbox" className="size-4 accent-emerald-600" checked={s.taxable !== false} onChange={(e) => set({ taxable: e.target.checked })} />
                      Taxed
                    </label>
                    <IconRemove label={`Remove ${s.name}`} onClick={() => setPlan({ ...plan, streams: plan.streams.filter((_, j) => j !== i) })} />
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
        <Card
          title="Life events"
          actions={
            <Button onClick={() => setPlan({ ...plan, events: [...plan.events, { name: 'Event', year: data.startYear + 1, years: 1, amount: -10000 }] })}>
              <Plus className="size-4" aria-hidden />
              Add
            </Button>
          }
        >
          {!plan.events.length && <p className="text-sm text-slate-500">One-off or repeating money in (+) or out (−): college, a car, selling a property, a wedding.</p>}
          <ul className="space-y-3">
            {plan.events.map((ev, i) => {
              const set = (change: Partial<LifeEvent>) => setPlan({ ...plan, events: plan.events.map((x, j) => (j === i ? { ...x, ...change } : x)) });
              return (
                <li key={i} className="grid gap-2 rounded-lg bg-slate-50 p-3 sm:grid-cols-[2fr_1fr_1fr_1.4fr_auto] sm:items-end dark:bg-slate-800/60">
                  <Field label="Name">
                    <Input value={ev.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} />
                  </Field>
                  <Field label="Year">
                    <Num value={ev.year} onChange={(year) => set({ year })} />
                  </Field>
                  <Field label="Years">
                    <Num value={ev.years} onChange={(years) => set({ years })} />
                  </Field>
                  <Field label="Each year, ±">
                    <Num value={ev.amount} onChange={(amount) => set({ amount })} />
                  </Field>
                  <IconRemove label={`Remove ${ev.name}`} onClick={() => setPlan({ ...plan, events: plan.events.filter((_, j) => j !== i) })} />
                </li>
              );
            })}
          </ul>
        </Card>
      </div>

      {projection && <YearByYear projection={projection} />}
      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
        A planning tool, not tax or investment advice. Growth is on each year's opening balance, and RMDs use that balance. Money is taken out to cover spending and the tax it causes. After a death the survivor keeps the larger Social Security benefit and the other's pre-tax accounts. Taxable dividends aren't taxed each year, and Medicare premium surcharges aren't included.
      </p>
    </>
  );
}

function IconRemove({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} className="rounded p-2 text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-700">
      <Trash2 className="size-4" aria-hidden />
    </button>
  );
}

function Tile({ label, children, hint, tone }: { label: string; children: ReactNode; hint?: ReactNode; tone?: 'good' | 'bad' }) {
  return (
    <div className="min-w-0 rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="text-xs font-medium text-slate-600 dark:text-slate-400">{label}</div>
      <div className={cx('mt-1 truncate text-xl font-semibold tabular-nums', tone === 'good' && 'text-emerald-700 dark:text-emerald-400', tone === 'bad' && 'text-rose-700 dark:text-rose-400')}>{children}</div>
      {hint && <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{hint}</div>}
    </div>
  );
}

function Results({ projection, plan }: { projection: Projection; plan: Plan }) {
  const last = projection.rows[projection.rows.length - 1];
  return (
    <>
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Tile label="Does the money last?" tone={projection.runsOut ? 'bad' : 'good'} hint={projection.runsOut ? `Short from ${projection.runsOut.year}, at ${ageText(projection.runsOut.ages)}` : last ? `Through ${last.year}, at ${ageText(last.ages)}` : undefined}>
          {projection.runsOut ? 'Runs short' : 'Yes'}
        </Tile>
        <Tile label="At retirement" hint={projection.atRetirement ? `In ${projection.atRetirement.year}, when both have retired` : 'Already retired'}>
          {projection.atRetirement ? short(projection.atRetirement.total) : '–'}
        </Tile>
        <Tile label="Left at the end" hint={last && last.end.pre_tax + last.end.pre_tax_spouse + last.end.deferred > 0.5 ? `${short(last.end.pre_tax + last.end.pre_tax_spouse + last.end.deferred)} of it pre-tax, still to be taxed` : "Today's dollars, all after tax"}>
          {short(projection.atEnd)}
        </Tile>
        <Tile label="Social Security a year" hint={plan.spouse ? `${plan.me.name} · ${plan.spouse.name}, once claimed` : 'Once claimed'}>
          {wholeMoney(projection.socialSecurity.me)}
          {projection.socialSecurity.spouse !== null && <span className="text-base text-slate-500"> · {wholeMoney(projection.socialSecurity.spouse)}</span>}
        </Tile>
        <Tile label="Lifetime tax" hint="Federal and state, from now on">
          {short(projection.lifetimeTax)}
        </Tile>
      </div>
      <Card title="Balances over time, today's dollars" className="mb-5">
        <Chart rows={projection.rows} />
      </Card>
    </>
  );
}

// The balance in each kind of account, stacked, year by year.
function Chart({ rows }: { rows: Row[] }) {
  const W = 720;
  const H = 240;
  const L = 56;
  const B = 24;
  const T = 10;
  const R = 10;
  const shape = useMemo(() => {
    if (rows.length < 2) return null;
    const max = Math.max(1, ...rows.map((r) => BUCKETS.reduce((s, b) => s + Math.max(0, r.end[b.key]), 0)));
    const raw = max / 4;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
    const top = Math.ceil(max / step) * step;
    const x = (i: number) => L + (i / (rows.length - 1)) * (W - L - R);
    const y = (v: number) => T + (1 - v / top) * (H - T - B);
    const layers: { key: Bucket; colour: string; d: string }[] = [];
    const base = rows.map(() => 0);
    for (const b of BUCKETS) {
      const upper = rows.map((r, i) => base[i] + Math.max(0, r.end[b.key]));
      const d = `${upper.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ')} ${base
        .map((v, i) => [i, v] as const)
        .reverse()
        .map(([i, v]) => `L${x(i).toFixed(1)} ${y(v).toFixed(1)}`)
        .join(' ')} Z`;
      layers.push({ key: b.key, colour: b.colour, d });
      upper.forEach((v, i) => (base[i] = v));
    }
    const ticks: number[] = [];
    for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
    const labels = [0, Math.floor((rows.length - 1) / 2), rows.length - 1];
    return { layers, ticks, y, x, labels };
  }, [rows]);
  if (!shape) return <p className="text-sm text-slate-500">The chart needs at least two years.</p>;
  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Balances by kind of account, each year of the plan">
        {shape.ticks.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={shape.y(v)} y2={shape.y(v)} className="stroke-slate-200 dark:stroke-slate-800" />
            <text x={L - 8} y={shape.y(v) + 4} textAnchor="end" className="fill-slate-500 text-[11px]">
              {short(v)}
            </text>
          </g>
        ))}
        {shape.layers.map((l) => (
          <path key={l.key} d={l.d} style={{ fill: l.colour }} fillOpacity={0.75} />
        ))}
        {shape.labels.map((i, k) => (
          <text key={i} x={shape.x(i)} y={H - 6} textAnchor={k === 0 ? 'start' : k === 2 ? 'end' : 'middle'} className="fill-slate-500 text-[11px]">
            {rows[i].year} · {ageText(rows[i].ages)}
          </text>
        ))}
      </svg>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
        {BUCKETS.map((b) => (
          <span key={b.key} className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ background: b.colour }} aria-hidden />
            {b.label}
          </span>
        ))}
      </div>
    </>
  );
}

function YearByYear({ projection }: { projection: Projection }) {
  const cell = 'px-2 py-1.5 text-right tabular-nums';
  const blank = (n: number) => (Math.abs(n) < 0.5 ? '' : wholeMoney(n));
  return (
    <Card title="Year by year, today's dollars" padded={false}>
      <div className="max-h-[32rem] overflow-auto">
        <table className="w-full min-w-[68rem] text-sm">
          <thead className="sticky top-0 bg-white text-xs text-slate-500 dark:bg-slate-900">
            <tr>
              <th className="px-2 py-2 text-left font-medium">Year</th>
              <th className="px-2 py-2 text-left font-medium">Ages</th>
              <th className="px-2 py-2 text-right font-medium">Pay</th>
              <th className="px-2 py-2 text-right font-medium">Social Security</th>
              <th className="px-2 py-2 text-right font-medium">Pensions, other</th>
              <th className="px-2 py-2 text-right font-medium">RMD</th>
              <th className="px-2 py-2 text-right font-medium">Events</th>
              <th className="px-2 py-2 text-right font-medium">Spending</th>
              <th className="px-2 py-2 text-right font-medium">Saved</th>
              <th className="px-2 py-2 text-right font-medium">Taken out</th>
              <th className="px-2 py-2 text-right font-medium">Tax</th>
              <th className="px-2 py-2 text-right font-medium">To Roth</th>
              <th className="px-2 py-2 text-right font-medium">Growth</th>
              <th className="px-2 py-2 text-right font-medium">End balance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {projection.rows.map((r) => {
              const taken = Object.values(r.withdrawn).reduce((s, n) => s + n, 0);
              const from = BUCKETS.filter((b) => r.withdrawn[b.key] > 0.5).map((b) => b.label.toLowerCase());
              return (
                <tr key={r.year} className={cx(r.shortfall > 0 && 'bg-rose-50 dark:bg-rose-950/40')}>
                  <td className="px-2 py-1.5">{r.year}</td>
                  <td className="px-2 py-1.5">{ageText(r.ages)}</td>
                  <td className={cell}>{blank(r.pay)}</td>
                  <td className={cell}>{blank(r.socialSecurity)}</td>
                  <td className={cell} title={r.deferredPaid ? `${wholeMoney(r.deferredPaid)} deferred comp` : undefined}>
                    {blank(r.other + r.deferredPaid)}
                  </td>
                  <td className={cell}>{blank(r.rmd)}</td>
                  <td className={cell}>{blank(r.events)}</td>
                  <td className={cell}>{blank(r.spending)}</td>
                  <td className={cell}>{blank(r.saved + r.contributions)}</td>
                  <td className={cell} title={from.length ? `From ${from.join(', ')}` : undefined}>
                    {blank(taken)}
                    {r.shortfall > 0 && <span className="block text-xs text-rose-700 dark:text-rose-400">{wholeMoney(r.shortfall)} short</span>}
                  </td>
                  <td className={cell} title={r.tax.state ? `${wholeMoney(r.tax.federal)} federal, ${wholeMoney(r.tax.state)} state` : undefined}>
                    {blank(r.tax.federal + r.tax.state)}
                  </td>
                  <td className={cell}>{blank(r.conversion)}</td>
                  <td className={cell}>{blank(r.growth)}</td>
                  <td className={cx(cell, 'font-medium')}>{wholeMoney(r.total)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
