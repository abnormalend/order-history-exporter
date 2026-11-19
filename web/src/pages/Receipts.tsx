// Receipts and checks: take a photo or upload files, and see what's been read and matched.
// A check waits for its number to clear the bank.
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Camera, CheckCircle2, Clock, FileText, Landmark, Link2, Loader2, Search, Upload } from 'lucide-react';
import { useApi } from '../api';
import { KIND_PATH, STATUS_LABELS, receiptQuery, uploadReceipt } from '../receipts';
import type { Receipt, ReceiptKind } from '../receipts';
import { useBusiness } from '../business';
import { money, plural, whole } from '../format';
import { Banner, Button, Card, Empty, Field, Input, Loading, MultiSelect, PageHeader, Pager, Select, cx } from '../ui';
import { PeriodFilter, useFilters } from '../filters';
import { CheckMasker } from '../checkMask';
import type { Mask } from '../checkMask';

const PAGE = 60;
type View = 'all' | 'review' | 'unmatched' | 'matched';

type Grouping = 'month' | 'vendor' | 'category';
type Choice = { name: string; count: number };

interface ListData {
  total: number;
  receipts: (Receipt & { group: string })[];
  groups: { key: string; label: string; count: number; total: number }[];
  choices: { years: string[]; vendors: Choice[]; categories: Choice[] };
  counts: { total: number; review: number; unmatched: number; reading: number };
  reader: { set: boolean; canStore: boolean };
}

interface Upload {
  name: string;
  kind: ReceiptKind;
  state: 'sending' | 'done' | 'duplicate' | 'error';
  message?: string;
  id?: number;
}

export function Receipts({ kind = 'receipt' }: { kind?: ReceiptKind }) {
  const isCheck = kind === 'check';
  const noun = isCheck ? 'check' : 'receipt';
  const { business } = useBusiness();
  const filters = useFilters();
  const view = (filters.value('view') || 'all') as View;
  const offset = Number(filters.value('page')) || 0;
  const [search, setSearch] = useState(filters.value('q'));
  const group = (filters.value('group') || 'month') as Grouping;
  const query = receiptQuery(filters, kind, business);
  query.set('limit', String(PAGE));
  query.set('offset', String(offset));
  const list = useApi<ListData>(`/api/receipts?${query}`);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const camera = useRef<HTMLInputElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const checkCamera = useRef<HTMLInputElement>(null);
  // A check photo waiting for its account number to be covered.
  const [masking, setMasking] = useState<{ file: File; done: (mask: Mask | null) => void } | null>(null);
  const coverNumbers = (file: File) =>
    new Promise<Mask | null>((resolve) =>
      setMasking({
        file,
        done: (mask) => {
          setMasking(null);
          resolve(mask);
        },
      }),
    );
  const counts = list.data?.counts;
  const flash = (useLocation().state as { flash?: string } | null)?.flash;
  // Opened receipts keep the list's filters, so they can step to the next one.
  const listParams = new URLSearchParams(filters.params);
  listParams.delete('page');
  const listSearch = listParams.size ? `?${listParams}` : '';

  useEffect(() => {
    const timer = setTimeout(() => {
      if (search !== filters.value('q')) filters.set({ q: search });
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  // While receipts are being read, check back every few seconds.
  useEffect(() => {
    if (!counts?.reading) return;
    const timer = setInterval(list.reload, 4000);
    return () => clearInterval(timer);
  }, [counts?.reading, list.reload]);

  async function send(chosen: FileList | null, as: ReceiptKind = kind) {
    if (!chosen?.length) return;
    const batch = [...chosen];
    setUploads((u) => [...batch.map((f) => ({ name: f.name, kind: as, state: 'sending' as const })), ...u].slice(0, 20));
    for (const file of batch) {
      let update: Partial<Upload>;
      try {
        let mask: Mask | undefined;
        if (as === 'check' && file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
          const chosen = await coverNumbers(file);
          if (!chosen) throw new Error('Not sent.');
          mask = chosen;
        }
        const result = await uploadReceipt(file, as, mask);
        update = { state: result.duplicate ? 'duplicate' : 'done', id: result.id };
      } catch (e) {
        update = { state: 'error', message: (e as Error).message };
      }
      setUploads((u) => {
        const index = u.findIndex((x) => x.name === file.name && x.state === 'sending');
        return index < 0 ? u : u.map((x, i) => (i === index ? { ...x, ...update } : x));
      });
      list.reload();
    }
    if (camera.current) camera.current.value = '';
    if (files.current) files.current.value = '';
    if (checkCamera.current) checkCamera.current.value = '';
  }

  const tabs: [View, string, number | undefined][] = [
    ['all', 'All', counts?.total],
    ['review', 'To check', counts?.review],
    ['unmatched', isCheck ? 'Not cleared yet' : 'Not matched', counts?.unmatched],
    ['matched', isCheck ? 'Cleared' : 'Matched', undefined],
  ];

  return (
    <>
      <PageHeader
        title={isCheck ? 'Checks' : 'Receipts'}
        description={
          isCheck
            ? 'Photograph each check before you send it, or upload check images from your bank. The account number along the bottom is covered on your device first; then the number, payee and business are read, and it is linked to the bank transaction when it clears.'
            : 'Photograph or upload receipts. Each is read, then matched to its card or bank transaction.'
        }
      />
      {flash && <Banner tone="info">{flash}</Banner>}
      {masking && <CheckMasker file={masking.file} onDone={masking.done} />}

      <div className="mb-5 grid grid-cols-2 gap-3 sm:flex">
        <Button variant="primary" className="min-h-12 sm:min-h-9" onClick={() => camera.current?.click()}>
          <Camera className="size-5 sm:size-4" aria-hidden />
          {isCheck ? 'Photograph a check' : 'Take a photo'}
        </Button>
        <Button className="min-h-12 sm:min-h-9" onClick={() => files.current?.click()}>
          <Upload className="size-5 sm:size-4" aria-hidden />
          Upload files
        </Button>
        {!isCheck && (
          <Button className="col-span-2 min-h-12 sm:min-h-9" onClick={() => checkCamera.current?.click()}>
            <Landmark className="size-5 sm:size-4" aria-hidden />
            Photograph a check
          </Button>
        )}
        <input ref={camera} type="file" accept="image/*" capture="environment" className="sr-only" aria-label={`Take a photo of a ${noun}`} onChange={(e) => send(e.target.files)} />
        <input ref={checkCamera} type="file" accept="image/*" capture="environment" className="sr-only" aria-label="Take a photo of a check" onChange={(e) => send(e.target.files, 'check')} />
        <input
          ref={files}
          type="file"
          accept={isCheck ? 'image/*' : 'image/*,application/pdf'}
          multiple
          className="sr-only"
          aria-label={`Choose ${noun} files`}
          onChange={(e) => send(e.target.files)}
        />
      </div>

      {list.data && !list.data.reader.set && (
        <Banner tone="warning">
          Photos are kept, but not read automatically until you add an Anthropic API key in{' '}
          <Link to="/settings" className="font-medium underline">
            Settings
          </Link>
          . You can also fill in each one yourself.
        </Banner>
      )}

      {uploads.length > 0 && (
        <Card className="mb-5" padded={false}>
          <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
            {uploads.map((u, i) => (
              <li key={`${u.name}-${i}`} className="flex items-center justify-between gap-3 px-4 py-2">
                <span className="truncate">{u.name}</span>
                <span className={cx('shrink-0 text-xs', u.state === 'error' ? 'text-red-700 dark:text-red-400' : 'text-slate-500 dark:text-slate-400')}>
                  {u.state === 'sending' && (
                    <span className="inline-flex items-center gap-1">
                      <Loader2 className="size-3.5 animate-spin" aria-hidden /> Sending
                    </span>
                  )}
                  {u.state === 'done' && u.id && (
                    <Link to={`${KIND_PATH[u.kind]}/${u.id}`} className="text-emerald-700 underline dark:text-emerald-400">
                      {u.kind === 'check' && !isCheck ? 'Added to checks' : 'Added'}
                    </Link>
                  )}
                  {u.state === 'duplicate' && u.id && (
                    <Link to={`${KIND_PATH[u.kind]}/${u.id}`} className="underline">
                      Already here
                    </Link>
                  )}
                  {u.state === 'error' && u.message}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={`Which ${noun}s`}>
          {tabs.map(([value, label, count]) => (
            <button
              key={value}
              type="button"
              aria-pressed={view === value}
              onClick={() => filters.set({ view: value === 'all' ? '' : value })}
              className={cx(
                'rounded-full px-3 py-1.5 text-sm font-medium',
                view === value
                  ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900'
                  : 'border border-slate-300 bg-white hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800',
              )}
            >
              {label}
              {count ? ` (${whole(count)})` : ''}
            </button>
          ))}
        </div>
      </div>

      <form className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6" onSubmit={(e) => e.preventDefault()} aria-label="Filters">
        <PeriodFilter years={list.data?.choices.years || []} />
        <MultiSelect
          label={isCheck ? 'Paid to' : 'Vendor'}
          allLabel={isCheck ? 'Everyone' : 'All vendors'}
          options={(list.data?.choices.vendors || []).map((v): [string, string] => [v.name, `${v.name} (${v.count})`])}
          selected={filters.values('vendor')}
          onChange={(next) => filters.set({ vendor: next })}
        />
        <MultiSelect
          label="Category"
          allLabel="All categories"
          options={[...(list.data?.choices.categories || []).map((c): [string, string] => [c.name, `${c.name} (${c.count})`]), ['none', 'No category']]}
          selected={filters.values('category')}
          onChange={(next) => filters.set({ category: next })}
        />
        <Field label="Group by">
          <Select value={group} onChange={(e) => filters.set({ group: e.target.value === 'month' ? '' : e.target.value })}>
            <option value="month">Month</option>
            <option value="vendor">{isCheck ? 'Paid to' : 'Vendor'}</option>
            <option value="category">Category</option>
          </Select>
        </Field>
        <Field label="Search" className="col-span-2 sm:col-span-1">
          <div className="relative">
            <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-slate-400" aria-hidden />
            <Input type="search" className="pl-8" placeholder={isCheck ? 'Payee, number or memo' : 'Vendor, item or note'} value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </Field>
      </form>

      {list.error && <Banner>{list.error.message}</Banner>}
      {!list.data && list.loading && <Loading />}
      {list.data && !list.data.receipts.length && (
        <Card>
          <Empty>{counts?.total ? `No ${noun}s match.` : isCheck ? 'No checks yet. Photograph one before you send it.' : 'No receipts yet. Take a photo or upload one to start.'}</Empty>
        </Card>
      )}
      {list.data && list.data.receipts.length > 0 && (
        <>
          {sections(list.data).map(({ group: g, receipts }) => (
            <section key={g.key} className="mb-6" aria-label={g.label}>
              <h2 className="mb-2 flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-200 pb-1.5 dark:border-slate-800">
                <span className="text-base font-semibold">{g.label}</span>
                <span className="text-sm text-slate-600 tabular-nums dark:text-slate-400">
                  {plural(g.count, noun)} · {money(g.total)}
                </span>
              </h2>
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {receipts.map((r) => (
                  <li key={r.id}>
                    <ReceiptTile receipt={r} search={listSearch} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <Pager offset={offset} pageSize={PAGE} total={list.data.total} onChange={(next) => filters.set({ page: String(next) })} />
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{plural(list.data.total, noun)}</p>
        </>
      )}
    </>
  );
}

// This page's receipts, split into their groups (a group can carry over to the next page).
function sections(data: ListData) {
  const byKey = new Map(data.groups.map((g) => [g.key, g]));
  const out: { group: ListData['groups'][number]; receipts: ListData['receipts'] }[] = [];
  for (const r of data.receipts) {
    const last = out[out.length - 1];
    if (last && last.group.key === r.group) last.receipts.push(r);
    else out.push({ group: byKey.get(r.group) || { key: r.group, label: '', count: 0, total: 0 }, receipts: [r] });
  }
  return out;
}

function ReceiptTile({ receipt: r, search }: { receipt: Receipt; search: string }) {
  const needsLook = r.status === 'failed' || (r.status === 'pending' && r.readError) || (r.status === 'read' && !r.checked);
  const isCheck = r.kind === 'check';
  return (
    <Link
      to={`${KIND_PATH[r.kind]}/${r.id}${search}`}
      className="block overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm hover:border-emerald-500 dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="flex aspect-[4/3] items-center justify-center overflow-hidden bg-slate-100 dark:bg-slate-800">
        {r.hasThumb ? <img src={`/api/receipts/${r.id}/thumb`} alt="" loading="lazy" className="size-full object-cover object-top" /> : <FileText className="size-10 text-slate-400" aria-hidden />}
      </div>
      <div className="p-2.5 text-sm">
        <div className="flex items-start justify-between gap-2">
          <span className="truncate font-medium">
            {isCheck && r.checkNumber ? <span className="text-slate-500 dark:text-slate-400">#{r.checkNumber} </span> : null}
            {r.vendor || r.fileName || (isCheck ? 'Check' : 'Receipt')}
          </span>
          <span className="shrink-0 tabular-nums">{money(r.total)}</span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
          <span>{r.date || STATUS_LABELS[r.status]}</span>
          {r.status === 'reading' || (r.status === 'pending' && !r.readError) ? (
            <Loader2 className="size-3.5 animate-spin" aria-label="Being read" />
          ) : r.transactionId ? (
            isCheck ? (
              <span className="inline-flex items-center gap-0.5 text-emerald-700 dark:text-emerald-400">
                <Link2 className="size-3.5" aria-hidden /> Cleared
              </span>
            ) : (
              <Link2 className="size-3.5 text-emerald-600" aria-label="Matched to a transaction" />
            )
          ) : needsLook ? (
            <span className="rounded bg-amber-100 px-1.5 text-[10px] font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">Review</span>
          ) : isCheck ? (
            <span className="inline-flex items-center gap-0.5">
              <Clock className="size-3.5" aria-hidden /> Not cleared
            </span>
          ) : (
            <CheckCircle2 className="size-3.5" aria-label="Checked" />
          )}
        </div>
        {isCheck && r.entityName && <div className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">{r.entityName}</div>}
      </div>
    </Link>
  );
}
