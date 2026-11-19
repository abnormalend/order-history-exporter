// Participation hours: one log per taxpayer (a married couple shares one), the
// turnover tasks and repeating work the hours are worked out from, questions about
// cleaners and purchases, and where each log stands against the yearly tests.
import { useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { CheckCircle2, CircleDashed, Clock, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { post, useApi } from '../api';
import { money, plural } from '../format';
import { Banner, Button, Card, Empty, Field, Input, Loading, PageHeader, Pager, Select, TD, TH, TR, cx } from '../ui';

type Source = 'turnover' | 'recurring' | 'purchase' | 'manual' | 'import';
interface Person {
  id: number;
  name: string;
}
interface Log {
  id: number;
  name: string;
  people: Person[];
}
interface Task {
  id: number;
  personId: number;
  logId: number;
  propertyId: string | null;
  property: string | null;
  task: string;
  hours: number;
  from: string | null;
  to: string | null;
}
interface Recurring {
  id: number;
  personId: number;
  logId: number;
  entityId: number;
  entity: string;
  propertyId: string | null;
  property: string | null;
  task: string;
  hours: number;
  everyDays: number;
  start: string;
  end: string | null;
}
interface Overview {
  logs: Log[];
  tasks: Task[];
  recurring: Recurring[];
  properties: { id: string; name: string; entityId: number | null }[];
  entities: { id: number; name: string; str: boolean }[];
  suggestedTasks: { task: string; minutes: number; spa?: boolean }[];
  questions: { help: number; purchases: number };
  years: string[];
}
interface Entry {
  id: number;
  personId: number;
  person: string;
  entityId: number | null;
  entity: string | null;
  propertyId: string | null;
  property: string | null;
  day: string;
  task: string;
  hours: number;
  source: Source;
  note: string | null;
  edited: boolean;
  removed: boolean;
}
interface SummaryLog {
  logId: number;
  log: string;
  hours: number;
  people: { personId: number; name: string; hours: number }[];
  mostByAnyoneElse: { name: string; hours: number } | null;
  over500: boolean;
  over100AndMost: boolean;
}
interface Business {
  entityId: number | null;
  entity: string;
  str: boolean;
  help: { name: string; hours: number; visits: number }[];
  logs: SummaryLog[];
}
interface HelpPayment {
  transactionId: number;
  posted: string;
  amount: number;
  description: string;
  entity: string | null;
  looksLikeCleaning: boolean;
  answered: boolean;
  isHelp: boolean | null;
  stayId: string | null;
  hours: number | null;
  stays: { id: string; day: string; property: string }[];
}
interface Purchase {
  transactionId: number;
  posted: string;
  amount: number;
  description: string;
  category: string;
  entity: string | null;
  items: string[];
  installed: boolean | null;
  entry: { id: number; personId: number; hours: number; task: string; day: string } | null;
}

const SOURCE_LABELS: Record<Source, string> = {
  turnover: 'Turnover',
  recurring: 'Repeating',
  purchase: 'Install',
  manual: 'By hand',
  import: 'Imported',
};
const hoursText = (h: number) => `${h.toLocaleString(undefined, { maximumFractionDigits: 2 })} h`;
const dayText = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const LOG_KEY = 'hub.hours.log';

export function Hours() {
  const data = useApi<Overview>('/api/hours');
  const [error, setError] = useState('');
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [logId, setLogId] = useState<number | null>(() => {
    try {
      return Number(localStorage.getItem(LOG_KEY)) || null;
    } catch {
      return null;
    }
  });
  const overview = data.data;
  const log = overview?.logs.find((l) => l.id === logId) ?? overview?.logs[0] ?? null;
  const pick = (id: number) => {
    setLogId(id);
    try {
      localStorage.setItem(LOG_KEY, String(id));
    } catch {
      /* not kept */
    }
  };
  // Saves, then shows the overview the server sends back.
  const act = async (path: string, body: unknown = {}) => {
    setError('');
    try {
      await post(path, body);
      await data.reload();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  };

  return (
    <>
      <PageHeader
        title="Participation hours"
        description="Hours worked on the rentals, kept for the material participation tests. Each log is one taxpayer: a married couple shares a log. Hours worked out from stays, repeating work and purchases are estimates; change any that are wrong."
        actions={
          overview && overview.logs.length > 0 ? (
            <Select aria-label="Year" value={year} onChange={(e) => setYear(e.target.value)} className="w-28">
              {[...new Set([String(new Date().getFullYear()), ...overview.years])]
                .sort()
                .reverse()
                .map((y) => (
                  <option key={y}>{y}</option>
                ))}
            </Select>
          ) : undefined
        }
      />
      {(error || data.error) && <Banner>{error || data.error?.message}</Banner>}
      {!overview && data.loading && <Loading />}
      {overview && overview.logs.length === 0 && <NewLog first onSave={(body) => act('/api/hours/logs', body)} />}
      {overview && log && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2" role="tablist" aria-label="Logs">
            {overview.logs.map((l) => (
              <button
                key={l.id}
                type="button"
                role="tab"
                aria-selected={l.id === log.id}
                onClick={() => pick(l.id)}
                className={cx(
                  'rounded-full border px-4 py-1.5 text-sm font-medium',
                  l.id === log.id
                    ? 'border-emerald-700 bg-emerald-700 text-white dark:border-emerald-600 dark:bg-emerald-600'
                    : 'border-slate-300 bg-white hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800',
                )}
              >
                {l.name}
              </button>
            ))}
            <AddLogButton onSave={(body) => act('/api/hours/logs', body)} />
          </div>
          {(overview.questions.help > 0 || overview.questions.purchases > 0) && (
            <Banner tone="info">
              Questions waiting:{' '}
              {[overview.questions.help && plural(overview.questions.help, 'cleaning payment'), overview.questions.purchases && plural(overview.questions.purchases, 'purchase')]
                .filter(Boolean)
                .join(' and ')}
              .{' '}
              <a href="#questions" className="font-medium underline">
                Answer them below
              </a>{' '}
              so the hours leave out turnovers a cleaner did and add work you installed.
            </Banner>
          )}
          <Summary year={year} log={log} reloadKey={data.data} />
          <People log={log} act={act} />
          <Tasks overview={overview} log={log} act={act} />
          <RecurringWork overview={overview} log={log} act={act} />
          <Entries overview={overview} log={log} year={year} act={act} />
          <div id="questions" className="scroll-mt-4">
            <HelpQuestions onChange={data.reload} />
            <PurchaseQuestions overview={overview} onChange={data.reload} />
          </div>
        </>
      )}
    </>
  );
}

function NewLog({ first, onSave, onCancel }: { first?: boolean; onSave: (body: { name: string; people: string[] }) => Promise<boolean>; onCancel?: () => void }) {
  const [name, setName] = useState('');
  const [people, setPeople] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const names = people
      .split(/[,&]| and /)
      .map((p) => p.trim())
      .filter(Boolean);
    if (await onSave({ name: name.trim(), people: names })) onCancel?.();
    setBusy(false);
  };
  return (
    <Card title={first ? 'Start a log' : 'New log'} className="mb-4">
      {first && (
        <p className="mb-3 text-sm text-slate-600 dark:text-slate-400">
          Make one log for you and your spouse, whose hours count together, and another for anyone who must meet the tests on their own.
        </p>
      )}
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[1fr_1.5fr_auto] sm:items-end">
        <Field label="Log name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Our hours" required maxLength={80} />
        </Field>
        <Field label="People in it" hint="Separate names with commas.">
          <Input value={people} onChange={(e) => setPeople(e.target.value)} placeholder="e.g. Alex, Jordan" required />
        </Field>
        <div className="flex gap-2">
          <Button type="submit" variant="primary" busy={busy}>
            Save
          </Button>
          {onCancel && <Button onClick={onCancel}>Cancel</Button>}
        </div>
      </form>
    </Card>
  );
}

function AddLogButton({ onSave }: { onSave: (body: { name: string; people: string[] }) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <Button variant="ghost" onClick={() => setOpen(true)}>
        <Plus className="size-4" aria-hidden /> New log
      </Button>
    );
  return (
    <div className="w-full">
      <NewLog onSave={onSave} onCancel={() => setOpen(false)} />
    </div>
  );
}

function Badge({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        ok ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-200' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
      )}
    >
      {ok ? <CheckCircle2 className="size-3.5" aria-hidden /> : <CircleDashed className="size-3.5" aria-hidden />}
      {children}
    </span>
  );
}

function Summary({ year, log, reloadKey }: { year: string; log: Log; reloadKey: unknown }) {
  const data = useApi<{ businesses: Business[] }>(`/api/hours/summary?year=${year}`);
  const { reload } = data;
  useEffect(() => {
    reload();
  }, [reloadKey, reload]);
  const rows = (data.data?.businesses ?? []).map((b) => ({ b, mine: b.logs.find((l) => l.logId === log.id)! })).filter((r) => r.mine && (r.b.str || r.mine.hours > 0));
  return (
    <section className="mb-5">
      <h2 className="mb-2 text-sm font-semibold text-slate-600 dark:text-slate-400">
        {log.name} in {year}
      </h2>
      {data.error && <Banner>{data.error.message}</Banner>}
      {!data.data && data.loading && <Loading />}
      {data.data && !rows.length && (
        <Card>
          <Empty>No rental businesses yet. Mark a business as a short-term rental in Settings.</Empty>
        </Card>
      )}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {rows.map(({ b, mine }) => (
          <Card key={b.entityId ?? 'none'}>
            <div className="text-sm font-semibold">{b.entity}</div>
            <div className="mt-1 text-3xl font-semibold tabular-nums">{hoursText(mine.hours)}</div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge ok={mine.over100AndMost}>100 h and the most</Badge>
              <Badge ok={mine.over500}>500 h</Badge>
            </div>
            <dl className="mt-3 space-y-1 text-sm">
              {mine.people.map((p) => (
                <div key={p.personId} className="flex justify-between gap-2">
                  <dt className="text-slate-600 dark:text-slate-400">{p.name}</dt>
                  <dd className="tabular-nums">{hoursText(p.hours)}</dd>
                </div>
              ))}
              <div className="flex justify-between gap-2 border-t border-slate-100 pt-1 dark:border-slate-800">
                <dt className="text-slate-600 dark:text-slate-400">Most by anyone else</dt>
                <dd className="tabular-nums">{mine.mostByAnyoneElse ? `${hoursText(mine.mostByAnyoneElse.hours)} (${mine.mostByAnyoneElse.name})` : 'none recorded'}</dd>
              </div>
            </dl>
          </Card>
        ))}
      </div>
      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
        A rental whose average stay is 7 days or less is judged by these tests. &ldquo;The most&rdquo; compares with each other person: people in other logs, and paid cleaners at the hours you gave
        them. Check how they apply with your CPA.
      </p>
    </section>
  );
}

function People({ log, act }: { log: Log; act: (path: string, body?: unknown) => Promise<boolean> }) {
  const [name, setName] = useState('');
  return (
    <Card title="People in this log" className="mb-5">
      <div className="flex flex-wrap items-center gap-2">
        {log.people.map((p) => (
          <span key={p.id} className="inline-flex items-center gap-1 rounded-full bg-slate-100 py-1 pr-1 pl-3 text-sm dark:bg-slate-800">
            {p.name}
            <button
              type="button"
              className="rounded-full p-1 text-slate-500 hover:bg-slate-200 hover:text-red-700 dark:hover:bg-slate-700"
              aria-label={`Remove ${p.name} and their hours`}
              onClick={() => window.confirm(`Remove ${p.name}? Their hours in this log are deleted too.`) && act(`/api/hours/people/${p.id}/delete`)}
            >
              <Trash2 className="size-3.5" aria-hidden />
            </button>
          </span>
        ))}
        <form
          className="flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await act(`/api/hours/logs/${log.id}/people`, { name: name.trim() })) setName('');
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Add a person" aria-label="Add a person" className="w-40" required maxLength={80} />
          <Button type="submit">Add</Button>
        </form>
      </div>
    </Card>
  );
}

function PersonSelect({ people, value, onChange }: { people: Person[]; value: number | ''; onChange: (id: number) => void }) {
  return (
    <Select value={value} onChange={(e) => onChange(Number(e.target.value))} required>
      <option value="">Who</option>
      {people.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </Select>
  );
}

function Tasks({ overview, log, act }: { overview: Overview; log: Log; act: (path: string, body?: unknown) => Promise<boolean> }) {
  const tasks = overview.tasks.filter((t) => t.logId === log.id);
  const [personId, setPersonId] = useState<number | ''>('');
  const [propertyId, setPropertyId] = useState('');
  const [task, setTask] = useState('');
  const [hours, setHours] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const who = (id: number) => log.people.find((p) => p.id === id)?.name ?? '?';

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    if (await act('/api/hours/tasks', { personId, propertyId: propertyId || null, task: task.trim(), hours: Number(hours), from: from || null, to: to || null })) {
      setTask('');
      setHours('');
    }
    setBusy(false);
  };
  // The usual list, for the person and property chosen (spa care only at one property).
  const addUsual = async () => {
    if (!personId) return;
    setBusy(true);
    for (const s of overview.suggestedTasks.filter((s) => !s.spa || propertyId)) {
      if (!(await act('/api/hours/tasks', { personId, propertyId: propertyId || null, task: s.task, hours: s.minutes / 60, from: from || null, to: to || null }))) break;
    }
    setBusy(false);
  };

  return (
    <Card title="After every check-out" className="mb-5">
      <p className="mb-3 text-sm text-slate-600 dark:text-slate-400">
        Each task here is added for its person after every past check-out, at one property or all of them, except turnovers a paid cleaner did. Give the time one person spends.
      </p>
      {tasks.length > 0 ? (
        <div className="-mx-4 mb-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className={TH}>Who</th>
                <th className={TH}>Where</th>
                <th className={TH}>Task</th>
                <th className={cx(TH, 'text-right')}>Hours</th>
                <th className={TH}>Dates</th>
                <th className={TH} />
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => (
                <tr key={t.id} className={TR}>
                  <td className={TD}>{who(t.personId)}</td>
                  <td className={TD}>{t.property ?? 'Every property'}</td>
                  <td className={TD}>{t.task}</td>
                  <td className={cx(TD, 'text-right tabular-nums')}>
                    <HoursEdit value={t.hours} label={`Hours for ${t.task}`} onSave={(h) => act(`/api/hours/tasks/${t.id}`, { ...t, hours: h })} />
                  </td>
                  <td className={cx(TD, 'text-xs text-slate-500')}>{t.from || t.to ? `${t.from ? dayText(t.from) : 'start'} to ${t.to ? dayText(t.to) : 'now'}` : 'Always'}</td>
                  <td className={TD}>
                    <Button variant="ghost" aria-label={`Remove ${t.task}`} onClick={() => act(`/api/hours/tasks/${t.id}/delete`)}>
                      <Trash2 className="size-4" aria-hidden />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>No turnover tasks yet. Pick a person and add the usual list, then change the times.</Empty>
      )}
      <form onSubmit={add} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[8rem_10rem_1fr_5rem_9rem_9rem_auto] lg:items-end">
        <Field label="Who">
          <PersonSelect people={log.people} value={personId} onChange={setPersonId} />
        </Field>
        <Field label="Where">
          <Select value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
            <option value="">Every property</option>
            {overview.properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Task">
          <Input value={task} onChange={(e) => setTask(e.target.value)} placeholder="e.g. Clean the kitchen" maxLength={200} />
        </Field>
        <Field label="Hours">
          <Input type="number" min="0.05" max="24" step="0.05" value={hours} onChange={(e) => setHours(e.target.value)} />
        </Field>
        <Field label="From (optional)">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To (optional)">
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" busy={busy} disabled={!personId || !task.trim() || !Number(hours)}>
            Add
          </Button>
          <Button onClick={addUsual} disabled={!personId || busy} title="Kitchen, bathrooms, cleaning, linens, laundry, restocking; spa care too when one property is chosen">
            Add the usual list
          </Button>
        </div>
      </form>
    </Card>
  );
}

function HoursEdit({ value, label, onSave }: { value: number; label: string; onSave: (hours: number) => Promise<boolean> }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const save = () => {
    const h = Number(text);
    if (h > 0 && h <= 24 && h !== value) onSave(h);
    else setText(String(value));
  };
  return (
    <input
      type="number"
      min="0.05"
      max="24"
      step="0.05"
      aria-label={label}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      className="w-20 rounded border border-transparent bg-transparent px-1 py-0.5 text-right tabular-nums hover:border-slate-300 focus:border-slate-400 dark:hover:border-slate-700"
    />
  );
}

function RecurringWork({ overview, log, act }: { overview: Overview; log: Log; act: (path: string, body?: unknown) => Promise<boolean> }) {
  const rules = overview.recurring.filter((r) => r.logId === log.id);
  const businesses = overview.entities.filter((e) => e.str);
  const [form, setForm] = useState({ personId: '' as number | '', entityId: '' as number | '', propertyId: '', task: '', hours: '', everyDays: '7', start: '', end: '' });
  const set = (change: Partial<typeof form>) => setForm((f) => ({ ...f, ...change }));
  const who = (id: number) => log.people.find((p) => p.id === id)?.name ?? '?';
  const add = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await act('/api/hours/recurring', {
      personId: form.personId,
      entityId: form.entityId,
      propertyId: form.propertyId || null,
      task: form.task.trim(),
      hours: Number(form.hours),
      everyDays: Number(form.everyDays),
      start: form.start,
      end: form.end || null,
    });
    if (ok) set({ task: '', hours: '' });
  };
  return (
    <Card title="Repeating work" className="mb-5">
      <p className="mb-3 text-sm text-slate-600 dark:text-slate-400">Work done on a schedule between two dates, such as mowing every week until a lawn company took over.</p>
      {rules.length > 0 ? (
        <div className="-mx-4 mb-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className={TH}>Who</th>
                <th className={TH}>Task</th>
                <th className={TH}>Where</th>
                <th className={cx(TH, 'text-right')}>Hours</th>
                <th className={TH}>Every</th>
                <th className={TH}>Dates</th>
                <th className={TH} />
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} className={TR}>
                  <td className={TD}>{who(r.personId)}</td>
                  <td className={TD}>{r.task}</td>
                  <td className={TD}>{r.property ?? r.entity}</td>
                  <td className={cx(TD, 'text-right')}>
                    <HoursEdit value={r.hours} label={`Hours for ${r.task}`} onSave={(h) => act(`/api/hours/recurring/${r.id}`, { ...r, hours: h })} />
                  </td>
                  <td className={TD}>{r.everyDays === 7 ? 'week' : plural(r.everyDays, 'day')}</td>
                  <td className={cx(TD, 'text-xs')}>
                    {dayText(r.start)} to {r.end ? dayText(r.end) : 'now'}
                  </td>
                  <td className={TD}>
                    <Button variant="ghost" aria-label={`Remove ${r.task}`} onClick={() => act(`/api/hours/recurring/${r.id}/delete`)}>
                      <Trash2 className="size-4" aria-hidden />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>No repeating work yet.</Empty>
      )}
      <form onSubmit={add} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 lg:items-end">
        <Field label="Who">
          <PersonSelect people={log.people} value={form.personId} onChange={(personId) => set({ personId })} />
        </Field>
        <Field label="Business">
          <Select value={form.entityId} onChange={(e) => set({ entityId: Number(e.target.value), propertyId: '' })} required>
            <option value="">Which</option>
            {businesses.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Property (optional)">
          <Select value={form.propertyId} onChange={(e) => set({ propertyId: e.target.value })}>
            <option value="">Any</option>
            {overview.properties
              .filter((p) => !form.entityId || p.entityId === form.entityId)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="Task">
          <Input value={form.task} onChange={(e) => set({ task: e.target.value })} placeholder="e.g. Mow the lawn" required maxLength={200} />
        </Field>
        <Field label="Hours each time">
          <Input type="number" min="0.05" max="24" step="0.05" value={form.hours} onChange={(e) => set({ hours: e.target.value })} required />
        </Field>
        <Field label="Every (days)">
          <Input type="number" min="1" max="366" value={form.everyDays} onChange={(e) => set({ everyDays: e.target.value })} required />
        </Field>
        <Field label="First day">
          <Input type="date" value={form.start} onChange={(e) => set({ start: e.target.value })} required />
        </Field>
        <Field label="Last day (blank: still going)">
          <Input type="date" value={form.end} onChange={(e) => set({ end: e.target.value })} />
        </Field>
        <div>
          <Button type="submit" variant="primary">
            Add
          </Button>
        </div>
      </form>
    </Card>
  );
}

function Entries({ overview, log, year, act }: { overview: Overview; log: Log; year: string; act: (path: string, body?: unknown) => Promise<boolean> }) {
  const [source, setSource] = useState('');
  const [removed, setRemoved] = useState(false);
  const [offset, setOffset] = useState(0);
  const [adding, setAdding] = useState(false);
  useEffect(() => setOffset(0), [log.id, year, source, removed]);
  const path = `/api/hours/entries?log=${log.id}&year=${year}&limit=50&offset=${offset}${source ? `&source=${source}` : ''}${removed ? '&removed=1' : ''}`;
  const data = useApi<{ total: number; hours: number; entries: Entry[] }>(path);
  const { reload } = data;
  useEffect(() => {
    reload();
  }, [overview, reload]);
  const change = async (p: string, body?: unknown) => {
    if (await act(p, body)) reload();
  };
  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <Clock className="size-4" aria-hidden /> Hours in {year}
          {data.data && <span className="font-normal text-slate-500">{`${data.data.total.toLocaleString()} ${data.data.total === 1 ? 'entry' : 'entries'}, ${hoursText(data.data.hours)}`}</span>}
        </span>
      }
      actions={
        <>
          <Select aria-label="Where the hours came from" value={source} onChange={(e) => setSource(e.target.value)} className="w-36">
            <option value="">All sources</option>
            {Object.entries(SOURCE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
          <Button variant={removed ? 'primary' : 'secondary'} onClick={() => setRemoved(!removed)}>
            {removed ? 'Showing removed' : 'Removed'}
          </Button>
          <Button variant="primary" onClick={() => setAdding(!adding)}>
            <Plus className="size-4" aria-hidden /> Add hours
          </Button>
        </>
      }
      padded={false}
      className="mb-5"
    >
      {adding && (
        <div className="border-b border-slate-100 p-4 dark:border-slate-800">
          <EntryForm overview={overview} log={log} onCancel={() => setAdding(false)} onSave={async (body) => (await act('/api/hours/entries', body)) && (reload(), setAdding(false), true)} />
        </div>
      )}
      {data.error && <Banner>{data.error.message}</Banner>}
      {!data.data && data.loading && <Loading />}
      {data.data && !data.data.entries.length && <Empty>No hours here yet.</Empty>}
      {data.data && data.data.entries.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className={TH}>Day</th>
                <th className={TH}>Who</th>
                <th className={TH}>Task</th>
                <th className={TH}>Where</th>
                <th className={cx(TH, 'text-right')}>Hours</th>
                <th className={TH}>From</th>
                <th className={TH} />
              </tr>
            </thead>
            <tbody>
              {data.data.entries.map((e) => (
                <tr key={e.id} className={TR}>
                  <td className={cx(TD, 'whitespace-nowrap')}>{dayText(e.day)}</td>
                  <td className={TD}>{e.person}</td>
                  <td className={TD}>
                    {e.task}
                    {e.note && <div className="text-xs text-slate-500">{e.note}</div>}
                  </td>
                  <td className={TD}>{e.property ?? e.entity ?? '–'}</td>
                  <td className={cx(TD, 'text-right')}>
                    {e.removed ? (
                      hoursText(e.hours)
                    ) : (
                      <HoursEdit value={e.hours} label={`Hours on ${e.day}`} onSave={(h) => act(`/api/hours/entries/${e.id}`, { ...e, hours: h }).then((ok) => (reload(), ok))} />
                    )}
                  </td>
                  <td className={cx(TD, 'text-xs whitespace-nowrap text-slate-500')}>
                    {SOURCE_LABELS[e.source]}
                    {e.edited && !e.removed && ' · changed'}
                  </td>
                  <td className={cx(TD, 'whitespace-nowrap')}>
                    {(e.source === 'turnover' || e.source === 'recurring') && e.edited && (
                      <Button variant="ghost" aria-label="Put back as worked out" title="Put back as worked out" onClick={() => change(`/api/hours/entries/${e.id}/reset`)}>
                        <RotateCcw className="size-4" aria-hidden />
                      </Button>
                    )}
                    {!e.removed && (
                      <Button variant="ghost" aria-label="Remove these hours" onClick={() => change(`/api/hours/entries/${e.id}/delete`)}>
                        <Trash2 className="size-4" aria-hidden />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="px-4 py-3">
            <Pager offset={offset} pageSize={50} total={data.data.total} onChange={setOffset} />
          </div>
        </div>
      )}
    </Card>
  );
}

function EntryForm({ overview, log, onSave, onCancel }: { overview: Overview; log: Log; onSave: (body: unknown) => Promise<boolean>; onCancel: () => void }) {
  const [form, setForm] = useState({ personId: '' as number | '', propertyId: '', entityId: '' as number | '', day: new Date().toISOString().slice(0, 10), task: '', hours: '', note: '' });
  const set = (change: Partial<typeof form>) => setForm((f) => ({ ...f, ...change }));
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    await onSave({
      personId: form.personId,
      propertyId: form.propertyId || null,
      entityId: form.propertyId ? null : form.entityId || null,
      day: form.day,
      task: form.task.trim(),
      hours: Number(form.hours),
      note: form.note.trim() || null,
    });
    setBusy(false);
  };
  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 lg:items-end">
      <Field label="Who">
        <PersonSelect people={log.people} value={form.personId} onChange={(personId) => set({ personId })} />
      </Field>
      <Field label="Day">
        <Input type="date" value={form.day} onChange={(e) => set({ day: e.target.value })} required />
      </Field>
      <Field label="Property">
        <Select value={form.propertyId} onChange={(e) => set({ propertyId: e.target.value })}>
          <option value="">None in particular</option>
          {overview.properties.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </Field>
      {!form.propertyId && (
        <Field label="Business">
          <Select value={form.entityId} onChange={(e) => set({ entityId: Number(e.target.value) || '' })} required>
            <option value="">Which</option>
            {overview.entities.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label="What was done" className="lg:col-span-2">
        <Input value={form.task} onChange={(e) => set({ task: e.target.value })} required maxLength={200} />
      </Field>
      <Field label="Hours">
        <Input type="number" min="0.05" max="24" step="0.05" value={form.hours} onChange={(e) => set({ hours: e.target.value })} required />
      </Field>
      <Field label="Note (optional)">
        <Input value={form.note} onChange={(e) => set({ note: e.target.value })} maxLength={500} />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" busy={busy}>
          Save
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

function HelpQuestions({ onChange }: { onChange: () => void }) {
  const data = useApi<{ payments: HelpPayment[] }>('/api/hours/help');
  const [error, setError] = useState('');
  const [showAnswered, setShowAnswered] = useState(false);
  const payments = (data.data?.payments ?? []).filter((p) => showAnswered || !p.answered);
  const answer = async (p: HelpPayment, body: unknown, forget = false) => {
    setError('');
    try {
      await post(`/api/hours/help/${p.transactionId}${forget ? '/forget' : ''}`, body);
      await data.reload();
      onChange();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Card
      title="Cleaners and other paid help"
      actions={
        <Button variant="ghost" onClick={() => setShowAnswered(!showAnswered)}>
          {showAnswered ? 'Hide answered' : 'Show answered'}
        </Button>
      }
      className="mb-5"
    >
      <p className="mb-3 text-sm text-slate-600 dark:text-slate-400">
        Cleaning payments from the bank. Say which turnover each cleaner did, so your hours for it are left out, and roughly how long they worked: their hours count in the &ldquo;more than anyone
        else&rdquo; test.
      </p>
      {error && <Banner>{error}</Banner>}
      {!data.data && data.loading && <Loading />}
      {data.data && !payments.length && <Empty>{showAnswered ? 'No cleaning payments found.' : 'Nothing to answer.'}</Empty>}
      <div className="space-y-3">
        {payments.map((p) => (
          <HelpRow key={p.transactionId} payment={p} onAnswer={answer} />
        ))}
      </div>
    </Card>
  );
}

function HelpRow({ payment: p, onAnswer }: { payment: HelpPayment; onAnswer: (p: HelpPayment, body: unknown, forget?: boolean) => Promise<void> }) {
  const [stayId, setStayId] = useState(p.stayId ?? p.stays[0]?.id ?? '');
  const [hours, setHours] = useState(String(p.hours ?? 3));
  return (
    <div className="rounded-md border border-slate-200 p-3 dark:border-slate-800">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="font-medium">{p.description}</div>
        <div className="text-sm tabular-nums">
          {money(Math.abs(p.amount))} · {dayText(p.posted)}
        </div>
      </div>
      <div className="text-xs text-slate-500">{p.entity ?? 'No business'}</div>
      {p.answered ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          {p.isHelp ? (
            <span>
              Did the turnover after {p.stays.find((s) => s.id === p.stayId)?.property ?? 'a stay'}
              {p.stayId ? '' : ' (no turnover chosen)'}, {hoursText(p.hours ?? 0)}.
            </span>
          ) : (
            <span>Not paid help with turnovers.</span>
          )}
          <Button variant="ghost" onClick={() => onAnswer(p, {}, true)}>
            Change
          </Button>
        </div>
      ) : (
        <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_6rem_auto_auto] sm:items-end">
          <Field label="Turnover they did">
            <Select value={stayId} onChange={(e) => setStayId(e.target.value)}>
              {p.stays.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.property}, check-out {dayText(s.day)}
                </option>
              ))}
              <option value="">Not a turnover (other cleaning)</option>
            </Select>
          </Field>
          <Field label="Their hours">
            <Input type="number" min="0" max="200" step="0.5" value={hours} onChange={(e) => setHours(e.target.value)} />
          </Field>
          <Button variant="primary" onClick={() => onAnswer(p, { isHelp: true, stayId: stayId || null, hours: Number(hours) || null })}>
            A cleaner did it
          </Button>
          <Button onClick={() => onAnswer(p, { isHelp: false })}>Not cleaning</Button>
        </div>
      )}
    </div>
  );
}

function PurchaseQuestions({ overview, onChange }: { overview: Overview; onChange: () => void }) {
  const [answered, setAnswered] = useState(false);
  const [offset, setOffset] = useState(0);
  const data = useApi<{ total: number; purchases: Purchase[] }>(`/api/hours/purchases?offset=${offset}${answered ? '&answered=1' : ''}`);
  const [error, setError] = useState('');
  const people = useMemo(() => overview.logs.flatMap((l) => l.people.map((p) => ({ ...p, name: overview.logs.length > 1 ? `${p.name} (${l.name})` : p.name }))), [overview.logs]);
  const answer = async (p: Purchase, body: unknown, forget = false) => {
    setError('');
    try {
      await post(`/api/hours/purchases/${p.transactionId}${forget ? '/forget' : ''}`, body);
      await data.reload();
      onChange();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Card
      title="Equipment and materials you bought"
      actions={
        <Button
          variant="ghost"
          onClick={() => {
            setAnswered(!answered);
            setOffset(0);
          }}
        >
          {answered ? 'Show unanswered' : 'Show answered'}
        </Button>
      }
      className="mb-5"
    >
      <p className="mb-3 text-sm text-slate-600 dark:text-slate-400">
        Rental business purchases of {money(50)} or more in equipment, tools, materials, furniture, garden and electronics. If you put it in, fixed something with it or assembled it yourself, say who
        and how long it took.
      </p>
      {error && <Banner>{error}</Banner>}
      {!data.data && data.loading && <Loading />}
      {data.data && !data.data.purchases.length && <Empty>{answered ? 'Nothing answered yet.' : 'Nothing to answer.'}</Empty>}
      <div className="space-y-3">
        {data.data?.purchases.map((p) => (
          <PurchaseRow key={p.transactionId} purchase={p} people={people} properties={overview.properties} onAnswer={answer} />
        ))}
      </div>
      {data.data && data.data.total > 50 && (
        <div className="mt-3">
          <Pager offset={offset} pageSize={50} total={data.data.total} onChange={setOffset} />
        </div>
      )}
    </Card>
  );
}

function PurchaseRow({
  purchase: p,
  people,
  properties,
  onAnswer,
}: {
  purchase: Purchase;
  people: Person[];
  properties: Overview['properties'];
  onAnswer: (p: Purchase, body: unknown, forget?: boolean) => Promise<void>;
}) {
  const [personId, setPersonId] = useState<number | ''>(p.entry?.personId ?? '');
  const [hours, setHours] = useState(p.entry ? String(p.entry.hours) : '');
  const [task, setTask] = useState(p.entry?.task ?? '');
  const [propertyId, setPropertyId] = useState('');
  return (
    <div className="rounded-md border border-slate-200 p-3 dark:border-slate-800">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="font-medium">{p.description}</div>
        <div className="text-sm tabular-nums">
          {money(Math.abs(p.amount))} · {dayText(p.posted)}
        </div>
      </div>
      <div className="text-xs text-slate-500">
        {p.category} · {p.entity ?? 'No business'}
      </div>
      {p.items.length > 0 && (
        <ul className="mt-1 list-inside list-disc text-sm text-slate-600 dark:text-slate-300">
          {p.items.map((i, n) => (
            <li key={n}>{i}</li>
          ))}
        </ul>
      )}
      {p.installed !== null ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <span>{p.installed ? (p.entry ? `${p.entry.task}: ${hoursText(p.entry.hours)} on ${dayText(p.entry.day)}.` : 'Installed (hours removed).') : 'Not installed by you.'}</span>
          <Button variant="ghost" onClick={() => onAnswer(p, {}, true)}>
            Change
          </Button>
        </div>
      ) : (
        <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-[9rem_10rem_1fr_5rem_auto_auto] lg:items-end">
          <Field label="Who">
            <PersonSelect people={people} value={personId} onChange={setPersonId} />
          </Field>
          <Field label="Property">
            <Select value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
              <option value="">Not one property</option>
              {properties.map((pr) => (
                <option key={pr.id} value={pr.id}>
                  {pr.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="What you did">
            <Input value={task} onChange={(e) => setTask(e.target.value)} placeholder={`Installed: ${p.description}`} maxLength={200} />
          </Field>
          <Field label="Hours">
            <Input type="number" min="0.25" max="24" step="0.25" value={hours} onChange={(e) => setHours(e.target.value)} />
          </Field>
          <Button
            variant="primary"
            disabled={!personId || !Number(hours)}
            onClick={() => onAnswer(p, { installed: true, personId, hours: Number(hours), task: task.trim() || null, propertyId: propertyId || null })}
          >
            I put it in
          </Button>
          <Button onClick={() => onAnswer(p, { installed: false })}>Didn&rsquo;t</Button>
        </div>
      )}
    </div>
  );
}
