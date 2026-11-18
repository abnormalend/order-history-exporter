// Settings > Access: switch Tailscale and the home network on or off. The server keeps
// one of them open at all times and shuts a timed home-network opening on its own.
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Globe, House, ShieldCheck } from 'lucide-react';
import { post, useApi } from './api';
import { Banner, Button, Card, Confirm, Select } from './ui';

interface Access {
  gated: boolean;
  via: 'tailscale' | 'lan' | 'local';
  tailnetHost: string | null;
  lanReady: boolean;
  lanUrls: string[];
  tailscale: boolean;
  lan: { on: boolean; until: string | null };
}

type Change = { lan?: { on: boolean; days?: number | null }; tailscale?: boolean };

const VIA = { tailscale: 'Tailscale', lan: 'the home network', local: 'the server itself' };

function Row({ icon, name, state, on, children }: { icon: ReactNode; name: string; state: string; on: boolean; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 py-3 first:border-t-0 dark:border-slate-800">
      <div className="flex min-w-0 items-center gap-2.5">
        {icon}
        <div className="min-w-0">
          <div className="text-sm font-semibold">{name}</div>
          <div className={on ? 'text-xs text-emerald-700 dark:text-emerald-400' : 'text-xs text-slate-500 dark:text-slate-400'}>{state}</div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

export function AccessCard() {
  const status = useApi<Access>('/api/settings/access');
  const [days, setDays] = useState('7');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // A change that shuts the way this page came in, waiting for a yes.
  const [pending, setPending] = useState<{ change: Change; what: string } | null>(null);
  const a = status.data;

  async function apply(change: Change) {
    setBusy(true);
    setError('');
    try {
      await post('/api/settings/access', change);
      setPending(null);
      status.reload();
    } catch (e) {
      setError((e as Error).message);
      setPending(null);
    }
    setBusy(false);
  }
  const ask = (change: Change, shuts: 'tailscale' | 'lan', what: string) => (a?.via === shuts ? setPending({ change, what }) : apply(change));

  if (!a) return null;
  if (!a.gated)
    return (
      <Card title="Access">
        <p className="text-sm text-slate-600 dark:text-slate-300">Tailscale isn't set up on this server, so there's nothing to switch here. Every address the server answers on is open.</p>
      </Card>
    );

  const lanTimed = a.lan.on && a.lan.until !== null;
  const canStopTailscale = a.lan.on && !lanTimed;
  const lanState = !a.lan.on ? 'Off' : a.lan.until ? `On until ${new Date(a.lan.until).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}, then off by itself` : 'On until you turn it off';

  return (
    <Card title="Access">
      {error && <Banner>{error}</Banner>}
      <p className="mb-2 text-sm text-slate-600 dark:text-slate-300">
        You're connected through <strong>{VIA[a.via]}</strong>. One way in always stays open.
      </p>
      <Row icon={<ShieldCheck className="size-5 shrink-0 text-slate-500" aria-hidden />} name="Tailscale" state={a.tailscale ? `On: https://${a.tailnetHost}` : 'Off'} on={a.tailscale}>
        {a.tailscale ? (
          <Button
            variant="danger"
            busy={busy}
            disabled={!canStopTailscale}
            title={canStopTailscale ? undefined : 'Turn the home network on until you turn it off first'}
            onClick={() => ask({ tailscale: false }, 'tailscale', 'Tailscale')}
          >
            Turn off
          </Button>
        ) : (
          <Button variant="primary" busy={busy} onClick={() => apply({ tailscale: true })}>
            Turn on
          </Button>
        )}
      </Row>
      <Row icon={<House className="size-5 shrink-0 text-slate-500" aria-hidden />} name="Home network" state={lanState} on={a.lan.on}>
        {a.lanReady && (
          <>
            <Select value={days} onChange={(e) => setDays(e.target.value)} aria-label="How long" className="w-auto">
              <option value="1">For 1 day</option>
              <option value="7">For 7 days</option>
              <option value="30">For 30 days</option>
              <option value="">Until I turn it off</option>
            </Select>
            <Button variant={a.lan.on ? 'secondary' : 'primary'} busy={busy} disabled={!a.tailscale && days !== ''} onClick={() => apply({ lan: { on: true, days: days ? Number(days) : null } })}>
              {a.lan.on ? 'Change' : 'Turn on'}
            </Button>
            {a.lan.on && (
              <Button variant="danger" busy={busy} disabled={!a.tailscale} title={a.tailscale ? undefined : 'Turn Tailscale on first'} onClick={() => ask({ lan: { on: false } }, 'lan', 'the home network')}>
                Turn off
              </Button>
            )}
          </>
        )}
      </Row>
      {a.lanReady ? (
        <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          <div className="mb-1 flex items-center gap-1.5">
            <Globe className="size-3.5" aria-hidden /> Home-network addresses, from your other VPN or at home:
          </div>
          <ul className="space-y-0.5 pl-5">
            {a.lanUrls.map((url) => (
              <li key={url} className="font-mono break-all">
                {url}
              </li>
            ))}
          </ul>
          <p className="mt-2">Each address signs in separately. Home-network connections aren't encrypted by the hub, so use them at home or through your VPN, never port-forwarded to the internet.</p>
        </div>
      ) : (
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          The server only listens inside its container, so the home network can't reach it yet. To make it possible, run this once on Proxmox (add a local DNS name if you have one), then come back here to turn it on:
          <code className="mt-1 block font-mono break-all text-slate-700 dark:text-slate-300">pct exec &lt;container id&gt; -- bash /opt/expense-hub/deploy/proxmox/enable-lan.sh hub.home</code>
        </p>
      )}
      <Confirm
        open={pending !== null}
        title={`Turn off ${pending?.what ?? ''}?`}
        confirmLabel="Turn off"
        busy={busy}
        onCancel={() => setPending(null)}
        onConfirm={() => pending && apply(pending.change)}
      >
        You're using {pending?.what} right now, so this page will stop working here. Open Business Hub through the other way in to keep going.
      </Confirm>
    </Card>
  );
}
