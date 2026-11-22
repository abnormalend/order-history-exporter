// Guests: everyone who has booked, put together from their stays, with the contact
// details Hospitable passes on (name, email, phone, where they're from). A guest who
// booked more than once is one row, matched by email, then phone, then name.
//
// Airbnb hides a guest's real email behind a relay address that only reaches them
// while the booking is active, so those are marked. A guest can be marked "don't
// contact", which keeps them out of the export unless asked for.
import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from '../params';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

// Addresses a platform made up to pass messages on, not the guest's own.
const RELAY = /@(guest\.airbnb\.com|airbnb\.com|messages\.homeaway\.com|guest\.booking\.com|m\.expediapartnercentral\.com)$/i;
const digits = (phone: string | null) => (phone || '').replace(/\D/g, '');

export interface Guest {
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

// What a stay can be matched on: its real email and its phone number, or, with
// neither, the guest's name.
function idsOf(s: Row) {
  const ids: string[] = [];
  const email = String(s.guest_email || '')
    .trim()
    .toLowerCase();
  if (email && !RELAY.test(email)) ids.push(`email:${email}`);
  const phone = digits(s.guest_phone);
  if (phone.length >= 7) ids.push(`phone:${phone.slice(-10)}`);
  if (!ids.length) {
    const name = [s.guest_first, s.guest_last].filter(Boolean).join(' ').trim().toLowerCase();
    ids.push(name ? `name:${name}` : `stay:${s.id}`);
  }
  return ids;
}

export function guestService({ db, today = () => new Date().toISOString().slice(0, 10) }: { db: DatabaseSync; today?: () => string }) {
  // entity: only guests of that business's properties.
  function list(entity: number | null): Guest[] {
    const stays = db
      .prepare(
        `SELECT s.id, s.platform, s.arrival, s.departure, s.nights, s.guest_first, s.guest_last, s.guest_email, s.guest_phone, s.guest_location, s.guest_total,
                p.name AS property
         FROM stays s LEFT JOIN stay_properties p ON p.id = s.property_id
         WHERE s.status = 'accepted' ${entity === null ? '' : 'AND p.entity_id = ?'}
         ORDER BY s.arrival`,
      )
      .all(...(entity === null ? [] : [entity])) as Row[];
    const marks = new Map((db.prepare('SELECT guest_key, no_contact, note FROM guest_contacts').all() as Row[]).map((m) => [String(m.guest_key), m]));
    const now = today();
    // Stays sharing an email or a phone number are one guest.
    const parent = new Map<string, string>();
    const root = (id: string): string => {
      let r = id;
      while (parent.get(r) && parent.get(r) !== r) r = parent.get(r)!;
      parent.set(id, r);
      return r;
    };
    for (const st of stays) {
      const ids = idsOf(st);
      for (const id of ids) if (!parent.has(id)) parent.set(id, id);
      for (const id of ids.slice(1)) parent.set(root(id), root(ids[0]));
    }
    const groupIds = new Map<string, string[]>();
    for (const id of parent.keys()) groupIds.set(root(id), [...(groupIds.get(root(id)) || []), id]);
    // A guest's key: the email if there is one, then the phone, then the name. Marks
    // are found by any of the guest's identifiers, so they survive a new email.
    const keyFor = (group: string) => {
      const ids = groupIds.get(group) || [group];
      return ids.find((i) => i.startsWith('email:')) || ids.find((i) => i.startsWith('phone:')) || ids[0];
    };
    const guests = new Map<string, Guest & { ids: string[] }>();
    // Ordered by arrival, so the newest details win.
    for (const s of stays) {
      const group = root(idsOf(s)[0]);
      const key = keyFor(group);
      const name = [s.guest_first, s.guest_last].filter(Boolean).join(' ').trim();
      const email = s.guest_email ? String(s.guest_email).trim() : null;
      const g =
        guests.get(key) ||
        ({
          key,
          ids: groupIds.get(group) || [key],
          name: '',
          email: null,
          emailRelay: false,
          phone: null,
          location: null,
          platforms: [],
          properties: [],
          stays: 0,
          nights: 0,
          firstStay: s.arrival,
          lastStay: s.arrival,
          upcoming: false,
          spent: 0,
          noContact: false,
          note: null,
        } as Guest & { ids: string[] });
      if (name) g.name = name;
      // A real address is kept over a relay one.
      if (email && (!g.email || g.emailRelay || !RELAY.test(email))) {
        g.email = email;
        g.emailRelay = RELAY.test(email);
      }
      if (s.guest_phone) g.phone = String(s.guest_phone);
      if (s.guest_location) g.location = String(s.guest_location);
      const platform = s.platform === 'homeaway' ? 'vrbo' : s.platform === 'manual' ? 'direct' : String(s.platform);
      if (!g.platforms.includes(platform)) g.platforms.push(platform);
      if (s.property && !g.properties.includes(s.property)) g.properties.push(String(s.property));
      g.stays += 1;
      g.nights += Number(s.nights || 0);
      g.lastStay = String(s.arrival);
      if (String(s.arrival) > now) g.upcoming = true;
      g.spent += Number(s.guest_total || 0);
      guests.set(key, g);
    }
    return [...guests.values()]
      .map((g) => {
        const { ids, ...guest } = g;
        const mark = ids.map((i) => marks.get(i)).find(Boolean);
        return { ...guest, name: g.name || 'Guest', spent: Math.round(g.spent * 100) / 100, noContact: Boolean(mark?.no_contact), note: mark?.note ?? null };
      })
      .sort((a, b) => b.lastStay.localeCompare(a.lastStay) || a.name.localeCompare(b.name));
  }

  function mark(key: string, change: { noContact?: boolean; note?: string | null }) {
    if (!/^(email|phone|name|stay):.{1,200}$/.test(key)) throw new HttpError(400, 'Which guest?');
    const before = db.prepare('SELECT no_contact, note FROM guest_contacts WHERE guest_key = ?').get(key) as Row | undefined;
    const noContact = change.noContact ?? Boolean(before?.no_contact);
    const note = change.note !== undefined ? change.note : (before?.note ?? null);
    db.prepare(
      `INSERT INTO guest_contacts (guest_key, no_contact, note, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (guest_key) DO UPDATE SET no_contact = excluded.no_contact, note = excluded.note, updated_at = excluded.updated_at`,
    ).run(key, noContact ? 1 : 0, note, new Date().toISOString());
  }

  return { list, mark };
}

export type GuestService = ReturnType<typeof guestService>;
