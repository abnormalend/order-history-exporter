// The Wealth page's holdings: what the invested money is in, positions files from the
// brokerages, things worth a look, and the kinds of account the names suggest.
import { useState } from 'react';
import type { ChangeEvent } from 'react';
import { Info, Sparkles } from 'lucide-react';
import { post, useApi } from '../api';
import { wholeMoney } from '../format';
import { Banner, Button, Card, Loading, Select, cx } from '../ui';
import { HOLDER_LABELS } from './Wealth';
import type { WealthAccount, WealthData } from './Wealth';

// The colour of each asset class, the same everywhere.
const CLASS_COLOURS: Record<string, string> = {
  us_stock: '#059669',
  intl_stock: '#0284c7',
  bond: '#7c3aed',
  target_date: '#0d9488',
  real_estate: '#b45309',
  cash: '#64748b',
  other: '#a16207',
  unknown: '#cbd5e1',
};
const pct = (share: number) => `${share >= 0.095 ? Math.round(share * 100) : (share * 100).toFixed(1)}%`;
const dayLabel = (day: string | null) => (day ? new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '');

export function Allocation({ data }: { data: WealthData }) {
  const label = (key: string) => data.allocation.find((c) => c.key === key)?.label ?? data.classes.find((c) => c.key === key)?.label ?? key;
  return (
    <>
      <div className="mb-3 flex h-3 overflow-hidden rounded" aria-hidden>
        {data.allocation.map((c) => (
          <span key={c.key} style={{ width: `${c.share * 100}%`, background: CLASS_COLOURS[c.key] }} />
        ))}
      </div>
      <ul className="mb-4 grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
        {data.allocation.map((c) => (
          <li key={c.key} className="flex items-center gap-2">
            <span className="size-2.5 shrink-0 rounded-sm" style={{ background: CLASS_COLOURS[c.key] }} aria-hidden />
            <span className="min-w-0 flex-1 truncate">{c.label}</span>
            <span className="tabular-nums">{wholeMoney(c.amount)}</span>
            <span className="w-11 text-right text-xs text-slate-500 tabular-nums">{pct(c.share)}</span>
          </li>
        ))}
      </ul>
      {data.notBrokenDown.length > 0 && (
        <p className="mb-4 text-xs text-slate-500 dark:text-slate-400">
          Counted at their balance, without positions:{' '}
          {data.notBrokenDown.map((n, i) => (
            <span key={n.id}>
              {i > 0 && ', '}
              {n.name}
              {n.countedAs && ' (company stock, as US stocks)'}
            </span>
          ))}
          .
        </p>
      )}
      {data.topHoldings.length > 0 && (
        <>
          <h3 className="mb-2 text-xs font-medium tracking-wide text-slate-500 uppercase">Largest holdings, across accounts</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {data.topHoldings.map((h) => (
                  <tr key={`${h.symbol}-${h.description}`}>
                    <td className="py-1.5 pr-3">
                      <span className="font-medium">{h.symbol ?? h.description}</span>
                      {h.symbol && <span className="block max-w-56 truncate text-xs text-slate-500">{h.description}</span>}
                    </td>
                    <td className="py-1.5 pr-3 text-xs text-slate-500">
                      <span className="inline-flex items-center gap-1">
                        <span className="size-2 rounded-sm" style={{ background: CLASS_COLOURS[h.assetClass] }} aria-hidden />
                        {label(h.assetClass)}
                      </span>
                      <span className="block truncate">{h.accounts.join(', ')}</span>
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {wholeMoney(h.value)}
                      <span className="block text-xs text-slate-500">{pct(h.share)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

export function Checks({ checks }: { checks: WealthData['checks'] }) {
  if (!checks.length) return <p className="text-sm text-slate-500">Nothing stands out.</p>;
  return (
    <ul className="space-y-3 text-sm">
      {checks.map((c) => (
        <li key={c.key} className="flex gap-2">
          <Info className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
          <span className="min-w-0">
            <span className="block font-medium">{c.title}</span>
            <span className="block text-xs text-slate-600 dark:text-slate-400">{c.detail}</span>
          </span>
        </li>
      ))}
      <li className="text-xs text-slate-500">These are facts from the numbers here, not advice; decisions are yours and your advisers'.</li>
    </ul>
  );
}

// Accounts whose names say what kind of investment account they are, to take in one go.
export function Suggestions({ accounts, typeLabel, onChange }: { accounts: WealthAccount[]; typeLabel: (k: string | null) => string; onChange: () => void }) {
  const list = accounts.filter((a) => a.suggestedType && !a.business);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  if (!list.length) return null;
  return (
    <Card title={<span className="inline-flex items-center gap-2"><Sparkles className="size-4 text-emerald-600" aria-hidden />{list.length === 1 ? 'An account looks like an investment account' : `${list.length} accounts look like investment accounts`}</span>} className="mb-5">
      {problem && <Banner>{problem}</Banner>}
      <ul className="mb-3 divide-y divide-slate-100 text-sm dark:divide-slate-800">
        {list.map((a) => (
          <li key={a.id} className="flex flex-wrap justify-between gap-x-3 py-1.5">
            <span className="min-w-0 truncate">
              {a.name}
              <span className="ml-2 text-xs text-slate-500">{a.kind === 'investment' ? 'kind not chosen' : `now ${a.kind}`}</span>
            </span>
            <span className="font-medium">
              {typeLabel(a.suggestedType)}
              {a.suggestedHolder && <span className="font-normal text-slate-500"> · {HOLDER_LABELS[a.suggestedHolder]}</span>}
            </span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          busy={busy}
          onClick={async () => {
            setBusy(true);
            setProblem('');
            try {
              await post('/api/wealth/suggestions', { ids: list.map((a) => a.id) });
              onChange();
            } catch (e) {
              setProblem((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Use these
        </Button>
        <span className="text-xs text-slate-500">Any can be changed afterwards with its pencil. Their transactions leave Review: money moving inside an investment account isn't spending.</span>
      </div>
    </Card>
  );
}

interface Inspected {
  brokerage: string;
  institution: string;
  asOf: string | null;
  skipped: string[];
  accounts: { key: string; label: string; last4: string | null; count: number; total: number; match: number | null; top: { symbol: string | null; description: string; value: number }[] }[];
  options: { id: number; name: string; kind: string; balance: number | null }[];
}

// A positions file from Fidelity, Schwab or E*Trade: read, matched to accounts, then saved.
export function ImportPositions({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [seen, setSeen] = useState<Inspected | null>(null);
  const [assign, setAssign] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [done, setDone] = useState('');

  async function choose(event: ChangeEvent<HTMLInputElement>) {
    const chosen = event.target.files?.[0];
    event.target.value = '';
    if (!chosen) return;
    setProblem('');
    setDone('');
    setBusy(true);
    try {
      const text = await chosen.text();
      const result = await post<Inspected>('/api/wealth/positions/inspect', { fileName: chosen.name, text });
      setFile({ name: chosen.name, text });
      setSeen(result);
      setAssign(Object.fromEntries(result.accounts.map((a) => [a.key, a.match ? String(a.match) : ''])));
    } catch (e) {
      setSeen(null);
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!file || !seen) return;
    setBusy(true);
    setProblem('');
    try {
      const body = Object.fromEntries(Object.entries(assign).map(([k, v]) => [k, v === '' ? null : v === 'new' ? 'new' : Number(v)]));
      const result = await post<{ accounts: number; positions: number }>('/api/wealth/positions', { fileName: file.name, text: file.text, assign: body });
      setDone(`Saved ${result.positions} holdings in ${result.accounts} ${result.accounts === 1 ? 'account' : 'accounts'}. Choose another file for the next brokerage.`);
      setSeen(null);
      setFile(null);
      onSaved();
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const chosenTwice = seen && new Set(Object.values(assign).filter((v) => v && v !== 'new')).size !== Object.values(assign).filter((v) => v && v !== 'new').length;
  return (
    <Card title="Import positions" className="mb-5">
      <p className="mb-3 text-sm text-slate-600 dark:text-slate-400">
        The positions download from Fidelity (all accounts in one file), Schwab or E*Trade, as CSV. Each account's holdings replace the ones saved before; the file itself isn't kept.
      </p>
      {problem && <Banner>{problem}</Banner>}
      {done && <Banner tone="info">{done}</Banner>}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className={cx('inline-flex cursor-pointer items-center gap-2 rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800', busy && 'pointer-events-none opacity-60')}>
          <input type="file" accept=".csv,text/csv" className="sr-only" onChange={choose} />
          {file ? 'Choose a different file' : 'Choose a file'}
        </label>
        {file && <span className="truncate text-sm text-slate-500">{file.name}</span>}
        <span className="flex-1" />
        <Button onClick={onClose}>Close</Button>
      </div>
      {busy && !seen && <Loading />}
      {seen && (
        <>
          <p className="mb-2 text-sm">
            {seen.institution}, positions as of <strong>{dayLabel(seen.asOf) || 'today'}</strong>.
          </p>
          <ul className="mb-3 divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
            {seen.accounts.map((a) => {
              const target = seen.options.find((o) => String(o.id) === assign[a.key]);
              const gap = target?.balance != null ? a.total - target.balance : null;
              return (
                <li key={a.key} className="grid gap-2 p-3 sm:grid-cols-[1fr_16rem] sm:items-center">
                  <div className="min-w-0">
                    <div className="font-medium">
                      {a.label}
                      {a.last4 && <span className="ml-1 text-slate-500">…{a.last4}</span>}
                    </div>
                    <div className="text-xs text-slate-500">
                      {a.count} {a.count === 1 ? 'holding' : 'holdings'}, {wholeMoney(a.total)}
                      {a.top.length > 0 && ` · ${a.top.map((t) => t.symbol ?? t.description).join(', ')}${a.count > a.top.length ? '…' : ''}`}
                    </div>
                    {gap !== null && Math.abs(gap) > Math.max(1000, Math.abs(target!.balance!) * 0.03) && (
                      <div className="text-xs text-amber-700 dark:text-amber-400">The account's balance is {wholeMoney(target!.balance!)}; check this is the right one.</div>
                    )}
                  </div>
                  <Select aria-label={`Account for ${a.label}`} value={assign[a.key] ?? ''} onChange={(e) => setAssign({ ...assign, [a.key]: e.target.value })}>
                    <option value="">Skip</option>
                    <option value="new">Add as a new account</option>
                    {seen.options.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </Select>
                </li>
              );
            })}
          </ul>
          {seen.skipped.map((s) => (
            <p key={s} className="mb-1 text-xs text-slate-500">
              Left out: {s}.
            </p>
          ))}
          {chosenTwice && <Banner tone="warning">Two parts of the file are going to the same account.</Banner>}
          <div className="mt-3 flex gap-2">
            <Button variant="primary" busy={busy} disabled={Boolean(chosenTwice) || !Object.values(assign).some(Boolean)} onClick={save}>
              Save holdings
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

interface HoldingRow {
  id: number;
  symbol: string | null;
  description: string;
  quantity: number | null;
  price: number | null;
  value: number;
  costBasis: number | null;
  gain: number | null;
  assetClass: string;
  chosen: boolean;
}

// One account's holdings, with each one's asset class (a change applies wherever it's held).
export function Holdings({ accountId, classes, onChange }: { accountId: number; classes: WealthData['classes']; onChange: () => void }) {
  const { data, error, reload } = useApi<{ asOf: string | null; holdings: HoldingRow[] }>(`/api/wealth/accounts/${accountId}/holdings`);
  const [problem, setProblem] = useState('');
  if (error) return <Banner>{error.message}</Banner>;
  if (!data) return <Loading />;
  const key = (h: HoldingRow) => (h.symbol ? h.symbol.toUpperCase() : `name:${h.description.toUpperCase()}`);
  return (
    <div className="mt-3 overflow-x-auto rounded-lg bg-slate-50 p-3 dark:bg-slate-800/60">
      {problem && <Banner>{problem}</Banner>}
      <table className="w-full min-w-[34rem] text-sm">
        <thead className="text-left text-xs text-slate-500">
          <tr>
            <th className="pb-1 font-medium">Holding</th>
            <th className="pb-1 text-right font-medium">Shares</th>
            <th className="pb-1 text-right font-medium">Value</th>
            <th className="pb-1 text-right font-medium">Gain</th>
            <th className="pb-1 pl-3 font-medium">Class</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200/70 dark:divide-slate-700/60">
          {data.holdings.map((h) => (
            <tr key={h.id}>
              <td className="py-1.5 pr-2">
                <span className="font-medium">{h.symbol ?? h.description}</span>
                {h.symbol && h.description !== h.symbol && <span className="block max-w-60 truncate text-xs text-slate-500">{h.description}</span>}
              </td>
              <td className="py-1.5 pr-2 text-right tabular-nums">{h.quantity === null ? '' : h.quantity.toLocaleString(undefined, { maximumFractionDigits: 3 })}</td>
              <td className="py-1.5 pr-2 text-right tabular-nums">{wholeMoney(h.value)}</td>
              <td className={cx('py-1.5 pr-2 text-right tabular-nums', h.gain !== null && h.gain < 0 ? 'text-rose-700 dark:text-rose-400' : 'text-slate-600 dark:text-slate-400')}>{h.gain === null ? '' : wholeMoney(h.gain)}</td>
              <td className="py-1 pl-3">
                <Select
                  aria-label={`Asset class of ${h.symbol ?? h.description}`}
                  value={h.assetClass}
                  className={cx(!h.chosen && 'italic')}
                  onChange={async (e) => {
                    setProblem('');
                    try {
                      await post('/api/wealth/classes', { key: key(h), assetClass: e.target.value });
                      reload();
                      onChange();
                    } catch (err) {
                      setProblem((err as Error).message);
                    }
                  }}
                >
                  {classes.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                      {!h.chosen && c.key === h.assetClass ? ' (guess)' : ''}
                    </option>
                  ))}
                </Select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
