// Guests: everyone who has stayed, one row each, with the contact details the booking
// platforms passed on. Downloads as a spreadsheet; guests marked "don't contact" stay
// out of it.
import { useMemo, useState } from 'react';
import { Download, Search } from 'lucide-react';
import { download, post, useApi } from '../api';
import { businessQuery, useBusiness } from '../business';
import { money } from '../format';
import { PLATFORM_NAMES } from '../stays';

const dayText = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
import { Banner, Button, Card, Empty, Input, Loading, PageHeader, Select, SortHeader, Stat, TD, TH, TR, cx } from '../ui';

interface Guest {
  key: string;
  name: string;
  email: string | null;
  emailRelay: boolean;
  phone: string | null;
  location: string | null;
  platforms: string[];
  properties: string[];
  stays: number;
  nights: number;
  firstStay: string;
  lastStay: string;
  upcoming: boolean;
  spent: number;
  noContact: boolean;
  note: string | null;
}

type Sort = 'name' | 'location' | 'stays' | 'lastStay' | 'spent';
const SORTS: Record<Sort, (g: Guest) => string | number> = {
  name: (g) => g.name.toLowerCase(),
  location: (g) => (g.location || '~').toLowerCase(),
  stays: (g) => g.stays,
  lastStay: (g) => g.lastStay,
  spent: (g) => g.spent,
};

export function Guests() {
  const { business, current } = useBusiness();
  const data = useApi<{ guests: Guest[] }>(`/api/guests?${businessQuery(business).slice(1)}`);
  const [search, setSearch] = useState('');
  const [show, setShow] = useState<'all' | 'reachable' | 'repeat' | 'nocontact'>('all');
  const [sort, setSort] = useState<Sort>('lastStay');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [error, setError] = useState('');
  const guests = data.data?.guests ?? [];

  const rows = useMemo(() => {
    const words = search.trim().toLowerCase();
    const picked = guests.filter((g) => {
      if (show === 'reachable' && (g.noContact || !((g.email && !g.emailRelay) || g.phone))) return false;
      if (show === 'repeat' && g.stays < 2) return false;
      if (show === 'nocontact' && !g.noContact) return false;
      return !words || [g.name, g.email, g.phone, g.location, ...g.properties].some((v) => v && v.toLowerCase().includes(words));
    });
    const key = SORTS[sort];
    return picked.sort((a, b) => {
      const x = key(a);
      const y = key(b);
      const order = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      return dir === 'asc' ? order : -order;
    });
  }, [guests, search, show, sort, dir]);

  const onSort = (column: string) => {
    if (column === sort) setDir(dir === 'asc' ? 'desc' : 'asc');
    else {
      setSort(column as Sort);
      setDir(column === 'name' || column === 'location' ? 'asc' : 'desc');
    }
  };
  const mark = async (g: Guest, change: { noContact?: boolean; note?: string | null }) => {
    setError('');
    try {
      await post('/api/guests/mark', { key: g.key, ...change });
      await data.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const realEmails = guests.filter((g) => g.email && !g.emailRelay && !g.noContact).length;
  const phones = guests.filter((g) => g.phone && !g.noContact).length;

  return (
    <>
      <PageHeader
        title={current ? `Guests: ${current.name}` : 'Guests'}
        description="Everyone who has stayed, one row per guest, with the contact details the booking platforms passed on. Guests who booked again are matched by email or phone."
        actions={
          <Button
            variant="primary"
            disabled={!guests.length}
            onClick={() =>
              download(`/api/guests.csv?${businessQuery(business).slice(1)}`, `guests${current ? `_${current.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}` : ''}.csv`).catch((e) =>
                setError(e.message),
              )
            }
          >
            <Download className="size-4" aria-hidden /> Download spreadsheet
          </Button>
        }
      />
      {(error || data.error) && <Banner>{error || data.error?.message}</Banner>}
      {!data.data && data.loading && <Loading />}
      {data.data && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Guests" value={guests.length} />
            <Stat label="Came back" value={guests.filter((g) => g.stays > 1).length} hint="Two stays or more" />
            <Stat label="With their own email" value={realEmails} hint="Not an Airbnb relay address" />
            <Stat label="With a phone number" value={phones} />
          </div>
          <Banner tone="info">
            Airbnb gives a relay email that only reaches the guest through Airbnb, and its rules don&rsquo;t allow using guest details from a booking for marketing. Before you send texts or emails,
            make sure each guest agreed to hear from you, and mark anyone who asks to stop as &ldquo;don&rsquo;t contact&rdquo;. The download leaves them out.
          </Banner>
          <Card padded={false} className="mt-4">
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3 dark:border-slate-800">
              <div className="relative min-w-48 flex-1">
                <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-slate-400" aria-hidden />
                <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, email, phone, city or property" aria-label="Search guests" className="pl-8" />
              </div>
              <Select value={show} onChange={(e) => setShow(e.target.value as typeof show)} aria-label="Which guests" className="w-48">
                <option value="all">All guests</option>
                <option value="reachable">Reachable directly</option>
                <option value="repeat">Came back</option>
                <option value="nocontact">Don&rsquo;t contact</option>
              </Select>
              <span className="text-sm text-slate-500">{rows.length.toLocaleString()} shown</span>
            </div>
            {!rows.length ? (
              <Empty>{guests.length ? 'No guests match.' : 'No stays yet. Connect Hospitable in Settings to bring them in.'}</Empty>
            ) : (
              <div className="max-h-[70vh] overflow-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-10 bg-white dark:bg-slate-900">
                    <tr>
                      <SortHeader label="Guest" column="name" sort={sort} dir={dir} onSort={onSort} />
                      <th className={TH}>Email</th>
                      <th className={TH}>Phone</th>
                      <SortHeader label="From" column="location" sort={sort} dir={dir} onSort={onSort} />
                      <th className={TH}>Booked through</th>
                      <th className={TH}>Stayed at</th>
                      <SortHeader label="Stays" column="stays" sort={sort} dir={dir} onSort={onSort} align="right" />
                      <SortHeader label="Last stay" column="lastStay" sort={sort} dir={dir} onSort={onSort} />
                      <SortHeader label="Paid" column="spent" sort={sort} dir={dir} onSort={onSort} align="right" />
                      <th className={TH}>Contact</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((g) => (
                      <tr key={g.key} className={cx(TR, g.noContact && 'opacity-60')}>
                        <td className={cx(TD, 'font-medium whitespace-nowrap')}>
                          {g.name}
                          {g.note && (
                            <div className="max-w-56 truncate text-xs font-normal text-slate-500" title={g.note}>
                              {g.note}
                            </div>
                          )}
                        </td>
                        <td className={TD}>
                          {g.email ? (
                            g.emailRelay ? (
                              <span className="text-xs text-slate-500" title={g.email}>
                                Airbnb relay only
                              </span>
                            ) : (
                              <a href={`mailto:${g.email}`} className="break-all text-emerald-700 hover:underline dark:text-emerald-400">
                                {g.email}
                              </a>
                            )
                          ) : (
                            '–'
                          )}
                        </td>
                        <td className={cx(TD, 'whitespace-nowrap')}>
                          {g.phone ? (
                            <a href={`tel:${g.phone.replace(/[^\d+]/g, '')}`} className="hover:underline">
                              {g.phone}
                            </a>
                          ) : (
                            '–'
                          )}
                        </td>
                        <td className={TD}>{g.location ?? '–'}</td>
                        <td className={cx(TD, 'whitespace-nowrap')}>{g.platforms.map((p) => PLATFORM_NAMES[p] || p).join(', ')}</td>
                        <td className={TD}>{g.properties.join(', ')}</td>
                        <td className={cx(TD, 'text-right tabular-nums')}>{g.stays}</td>
                        <td className={cx(TD, 'whitespace-nowrap')}>
                          {dayText(g.lastStay)}
                          {g.upcoming && <span className="ml-1 rounded-full bg-sky-100 px-1.5 text-xs text-sky-800 dark:bg-sky-900/60 dark:text-sky-200">coming</span>}
                        </td>
                        <td className={cx(TD, 'text-right tabular-nums')}>{money(g.spent)}</td>
                        <td className={cx(TD, 'whitespace-nowrap')}>
                          <label className="inline-flex items-center gap-1.5 text-xs">
                            <input type="checkbox" checked={g.noContact} onChange={(e) => mark(g, { noContact: e.target.checked })} />
                            Don&rsquo;t contact
                          </label>
                          <button
                            type="button"
                            className="ml-2 text-xs text-slate-500 hover:underline"
                            onClick={() => {
                              const note = window.prompt(`Note about ${g.name}`, g.note ?? '');
                              if (note !== null) mark(g, { note: note.trim() || null });
                            }}
                          >
                            Note
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </>
  );
}
