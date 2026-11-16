import { useState } from 'react';
import { Download, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { download, post, useApi } from '../api';
import { FilterBar, useFilters } from '../filters';
import type { Meta } from '../filters';
import { money, plural } from '../format';
import { Banner, Button, Card, Confirm, Empty, Field, Loading, PageHeader, Pager, Select, SortHeader, TD, TR } from '../ui';

const PAGE = 50;
const STATUS_LABELS: Record<string, string> = { unreviewed: 'Not reviewed', business: 'Business', personal: 'Personal' };
const SOURCE_NOTES: Record<string, string> = { rule: 'Guessed from the name', learned: 'Learned from your changes', store: 'Guessed from the store', ai: 'Sorted by Claude' };

export function Items({ meta, onMetaChange }: { meta: Meta | null; onMetaChange: () => void }) {
  const filters = useFilters();
  const sort = filters.value('sort') || 'date';
  const dir = filters.value('dir') || 'desc';
  const offset = Number(filters.value('page')) || 0;
  const status = filters.value('status');
  const path = `/api/items?${filters.query({ sort, dir, limit: PAGE, offset, status })}`;
  const { data, error, loading, reload } = useApi<any>(path);
  const [actionError, setActionError] = useState('');
  const [note, setNote] = useState('');
  const [bulk, setBulk] = useState<null | 'business' | 'personal'>(null);
  const [busy, setBusy] = useState(false);

  const onSort = (column: string) =>
    filters.set({ sort: column, dir: sort === column ? (dir === 'asc' ? 'desc' : 'asc') : column === 'date' || column === 'amount' ? 'desc' : 'asc' });

  async function act(fn: () => Promise<unknown>) {
    setActionError('');
    try {
      await fn();
      await reload();
    } catch (e) {
      setActionError((e as Error).message);
      reload();
    }
  }

  const setCategory = (item: any, category: string) => act(() => post('/api/items/category', { name: item.name, category }));
  const setStatus = (item: any, value: string) => act(() => post('/api/items/status', { status: value, items: [{ store: item.store, orderId: item.orderId, name: item.name }] }));

  async function markAll() {
    if (!bulk) return;
    setBusy(true);
    await act(async () => {
      // Each key keeps all its values, since a filter can have several.
      const chosen = new URLSearchParams(filters.query({ status }));
      const filterObject = Object.fromEntries([...new Set(chosen.keys())].map((key) => [key, chosen.getAll(key)]));
      const { changed } = await post<{ changed: number }>('/api/items/status', { status: bulk, filters: filterObject });
      setNote(`${plural(changed, 'item')} marked ${bulk}.`);
      onMetaChange();
    });
    setBusy(false);
    setBulk(null);
  }

  const categorySelect = (item: any) => (
    <Select aria-label={`Category for ${item.name}`} value={item.category} onChange={(e) => setCategory(item, e.target.value)} className="min-w-40">
      {[...new Set([...(meta?.categories.map((c) => c.name) || []), item.category])].map((name) => (
        <option key={name} value={name}>
          {name}
        </option>
      ))}
    </Select>
  );

  const statusSelect = (item: any) => (
    <Select aria-label={`Business or personal for ${item.name}`} value={item.status} onChange={(e) => setStatus(item, e.target.value)} className="min-w-32">
      {Object.entries(STATUS_LABELS).map(([value, label]) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </Select>
  );

  const amount = (item: any) => (typeof item.amount === 'number' ? `${item.estimated ? '≈ ' : ''}${money(item.amount)}` : '–');

  return (
    <>
      <PageHeader
        title="Items"
        description="Every purchased item. Change a category once and it applies to every item with that name, and teaches similar ones. Amounts include each item's share of tax and shipping."
        actions={
          <Button
            onClick={() => download(`/api/items.csv?${filters.query({ status, sort, dir })}`, `items_${filters.periodLabel()}.csv`).catch((e) => setActionError(e.message))}
            disabled={!data?.total}
          >
            <Download className="size-4" aria-hidden />
            Download CSV
          </Button>
        }
      />
      <FilterBar meta={meta} />
      <AutoSort onDone={reload} />
      {(error || actionError) && <Banner>{error?.message || actionError}</Banner>}
      {note && <Banner tone="info">{note}</Banner>}

      <Card
        title={data ? `${plural(data.total, 'item')} · ${money(data.amount)}` : 'Items'}
        padded={false}
        actions={
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Status" className="w-36">
              <Select value={status} onChange={(e) => filters.set({ status: e.target.value })}>
                <option value="">Any</option>
                <option value="unreviewed">Not reviewed</option>
                <option value="business">Business</option>
                <option value="personal">Personal</option>
              </Select>
            </Field>
            <Button onClick={() => setBulk('business')} disabled={!data?.total}>
              Mark all as business
            </Button>
            <Button onClick={() => setBulk('personal')} disabled={!data?.total}>
              Mark all as personal
            </Button>
          </div>
        }
      >
        {!data && loading && <Loading />}
        {data && !data.items.length && <Empty>No items match these filters.</Empty>}
        {data && data.items.length > 0 && (
          <>
            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <SortHeader label="Date" column="date" sort={sort} dir={dir} onSort={onSort} />
                    <SortHeader label="Store" column="store" sort={sort} dir={dir} onSort={onSort} />
                    <SortHeader label="Item" column="item" sort={sort} dir={dir} onSort={onSort} />
                    <SortHeader label="Category" column="category" sort={sort} dir={dir} onSort={onSort} />
                    <SortHeader label="ZIP" column="zip" sort={sort} dir={dir} onSort={onSort} />
                    <SortHeader label="Payment" column="payment" sort={sort} dir={dir} onSort={onSort} />
                    <SortHeader label="Amount" column="amount" sort={sort} dir={dir} onSort={onSort} align="right" />
                    <SortHeader label="Business or personal" column="status" sort={sort} dir={dir} onSort={onSort} />
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((item: any, index: number) => (
                    <tr key={`${item.store}-${item.orderId}-${index}`} className={TR}>
                      <td className={`${TD} whitespace-nowrap`}>{item.date}</td>
                      <td className={`${TD} whitespace-nowrap`}>{item.storeName}</td>
                      <td className={TD}>{item.name}</td>
                      <td className={TD}>
                        {categorySelect(item)}
                        {SOURCE_NOTES[item.categorySource] && <div className="mt-1 text-xs text-slate-500">{SOURCE_NOTES[item.categorySource]}</div>}
                      </td>
                      <td className={`${TD} whitespace-nowrap`}>{item.deliveryZip}</td>
                      <td className={`${TD} whitespace-nowrap`}>{item.payment}</td>
                      <td className={`${TD} text-right whitespace-nowrap tabular-nums`} title={item.estimated ? 'Estimated: this order has no item prices yet.' : undefined}>
                        {amount(item)}
                      </td>
                      <td className={TD}>
                        {statusSelect(item)}
                        {item.statusSource === 'rule' && <div className="mt-1 text-xs text-slate-500">From a rule</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="divide-y divide-slate-100 lg:hidden dark:divide-slate-800">
              {data.items.map((item: any, index: number) => (
                <li key={`${item.store}-${item.orderId}-${index}`} className="space-y-2 px-4 py-3 text-sm">
                  <div className="flex justify-between gap-3">
                    <span className="font-medium">{item.name}</span>
                    <span className="shrink-0 tabular-nums">{amount(item)}</span>
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    {item.date} · {item.storeName}
                    {item.deliveryZip ? ` · ${item.deliveryZip}` : ''}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {categorySelect(item)}
                    {statusSelect(item)}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
        {data && <Pager offset={offset} pageSize={PAGE} total={data.total} onChange={(next) => filters.set({ page: String(next) })} />}
      </Card>

      <Confirm
        open={bulk !== null}
        title={`Mark ${data ? plural(data.total, 'item') : 'items'} as ${bulk}?`}
        confirmLabel={`Mark as ${bulk}`}
        busy={busy}
        onCancel={() => setBulk(null)}
        onConfirm={markAll}
      >
        Every item matching the current filters will be marked {bulk}. Your tax groups use this. You can change any item back later.
      </Confirm>
    </>
  );
}

interface SortStatus {
  waiting: number;
  unsure: number;
  sorted: number;
  hasKey: boolean;
  running: boolean;
}

// Items the keyword rules couldn't place, sorted by Claude on request. Anything it
// isn't sure about stays Uncategorized for you to choose.
function AutoSort({ onDone }: { onDone: () => void }) {
  const { data, reload } = useApi<SortStatus>('/api/items/auto-sort');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [result, setResult] = useState('');
  if (!data || (!data.waiting && !data.unsure && !result)) return null;

  async function run(retryUnsure = false) {
    setBusy(true);
    setProblem('');
    setResult('');
    try {
      const r = await post<{ asked: number; sortedNow: number; unsureNow: number; status: SortStatus }>('/api/items/auto-sort', { retryUnsure });
      setResult(
        `Claude sorted ${plural(r.sortedNow, 'item name')}${r.unsureNow ? ` and wasn't sure about ${r.unsureNow}` : ''}.${r.status.waiting ? ` ${plural(r.status.waiting, 'more')} to go: press Sort again.` : ''}`
      );
      reload();
      onDone();
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-4 rounded-lg border border-violet-200 bg-violet-50 px-4 py-3 text-sm dark:border-violet-900 dark:bg-violet-950/50">
      <div className="flex flex-wrap items-center gap-3">
        <Sparkles className="size-4 shrink-0 text-violet-600 dark:text-violet-400" aria-hidden />
        <div className="min-w-0 flex-1">
          {data.waiting > 0 ? (
            <span>
              <strong>{plural(data.waiting, 'item name')}</strong> {data.waiting === 1 ? 'has' : 'have'} no category, or only a guess from the store.
            </span>
          ) : (
            <span>Every item name has been looked at.</span>
          )}
          {data.unsure > 0 && (
            <span className="text-slate-600 dark:text-slate-300">
              {' '}
              Claude wasn't sure about {data.unsure}: pick <Link to="/items?category=Uncategorized&preset=all" className="underline">Uncategorized, all time</Link> to do those yourself.
            </span>
          )}
        </div>
        {data.hasKey ? (
          <div className="flex flex-wrap gap-2">
            {data.waiting > 0 && (
              <Button variant="primary" busy={busy} onClick={() => run()}>
                Sort them with Claude
              </Button>
            )}
            {data.unsure > 0 && (
              <Button busy={busy} onClick={() => run(true)} title="For after you add a category that might fit them">
                Ask again about unsure ones
              </Button>
            )}
          </div>
        ) : (
          <Link to="/settings" className="text-violet-700 underline dark:text-violet-300">
            Add an Anthropic API key in Settings to sort them
          </Link>
        )}
      </div>
      {busy && <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">Sorting… this takes a few seconds per hundred names.</p>}
      {result && <p className="mt-2 text-emerald-800 dark:text-emerald-300">{result}</p>}
      {problem && <p className="mt-2 text-red-700 dark:text-red-400">{problem}</p>}
      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
        Only the item names and your category names are sent to Anthropic, using your own API key. Your own choices always win: change any item and similar names learn from it.
      </p>
    </div>
  );
}
