// Which ways in are open: Tailscale (its proxy, on this machine, for the tailnet name) and
// the home network (straight to the port). Tailscale is on and the home network off until
// the owner changes them in Settings. One of the two always stays on, and a home-network
// opening with an end date shuts itself, so the books can't be locked away by mistake.
import type { DatabaseSync } from 'node:sqlite';

export type Way = 'tailscale' | 'lan' | 'local';

export interface AccessSetup {
  // The tailnet name Tailscale serves (OHE_PUBLIC_HOST). Without one, nothing is gated.
  tailnetHost: string | null;
  // Whether the server listens beyond this machine, so the home network can reach it.
  lanReady: boolean;
  // Addresses to show for the home network.
  lanUrls: string[];
}

export interface AccessState {
  tailscale: boolean;
  lan: { on: boolean; until: string | null };
}

const LAN_KEY = 'access.lan';
const TAILSCALE_KEY = 'access.tailscale';
const loopback = (address: string) => address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';

// Only Tailscale's proxy, on this machine, can be asking for the tailnet name; anything
// arriving from another machine came over the home network, whatever name it gives.
export function wayIn(remoteAddress: string | undefined, host: string, tailnetHost: string | null): Way {
  if (!loopback(String(remoteAddress || ''))) return 'lan';
  const name = host.toLowerCase().replace(/:\d+$/, '');
  return tailnetHost && name === tailnetHost ? 'tailscale' : 'local';
}

export function accessService(db: DatabaseSync, setup: AccessSetup, now = () => new Date()) {
  const read = (key: string) => (db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
  const write = (key: string, value: string | null) => {
    if (value === null) db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
    else db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  };

  function state(): AccessState {
    let lan: AccessState['lan'] = { on: false, until: null };
    try {
      const saved = JSON.parse(read(LAN_KEY) || 'null');
      if (saved?.on) lan = { on: true, until: typeof saved.until === 'string' ? saved.until : null };
    } catch {
      // A damaged value counts as off.
    }
    if (lan.on && lan.until && now() >= new Date(lan.until)) lan = { on: false, until: null };
    // Tailscale can be off only while the home network is open for good.
    const tailscale = read(TAILSCALE_KEY) !== 'off' || !lan.on || lan.until !== null;
    return { tailscale, lan };
  }

  const gated = () => Boolean(setup.tailnetHost);

  return {
    gated,
    way: (remoteAddress: string | undefined, host: string) => wayIn(remoteAddress, host, setup.tailnetHost),
    // Why this way in is shut, or null when it's open.
    refusal(way: Way): string | null {
      if (!gated() || way === 'local') return null;
      const s = state();
      if (way === 'lan' && !s.lan.on) return 'Home-network access to Business Hub is turned off. Open it through Tailscale, or turn it on under Settings > Access.';
      if (way === 'tailscale' && !s.tailscale) return 'Tailscale access to Business Hub is turned off. Open it on the home network, or turn it back on under Settings > Access.';
      return null;
    },
    describe(way: Way) {
      return { gated: gated(), via: way, tailnetHost: setup.tailnetHost, lanReady: setup.lanReady, lanUrls: setup.lanUrls, ...state() };
    },
    // lan: open it (for some days, or until turned off) or shut it. tailscale: on or off.
    change(input: { lan?: { on: boolean; days?: number | null }; tailscale?: boolean }) {
      if (!gated()) throw new Error('Access switches need Tailscale set up first.');
      const s = state();
      const lan = input.lan ? (input.lan.on ? { on: true, until: input.lan.days ? new Date(now().getTime() + input.lan.days * 86400000).toISOString() : null } : { on: false, until: null }) : s.lan;
      const tailscale = input.tailscale ?? s.tailscale;
      if (lan.on && !setup.lanReady) throw new Error('The server only listens inside its container. Run the home-network setup on Proxmox first (shown on this card).');
      if (!tailscale && !lan.on) throw new Error('Keep one way in open: turn the home network on before turning Tailscale off.');
      if (!tailscale && lan.until) throw new Error("Tailscale can't be off while home-network access has an end date, or nothing would be left open. Choose “until I turn it off”, or keep Tailscale on.");
      write(LAN_KEY, lan.on ? JSON.stringify(lan) : null);
      write(TAILSCALE_KEY, tailscale ? null : 'off');
      return state();
    },
  };
}

export type AccessService = ReturnType<typeof accessService>;
