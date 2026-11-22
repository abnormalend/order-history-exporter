// Guests from the stays: the list, a spreadsheet of it, and "don't contact" marks.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { core } from '../legacy';
import { HttpError, queryOf } from '../params';
import type { GuestService } from '../stays/guests';
import type { AuthedRequest } from '../app';

const PLATFORMS: Record<string, string> = { airbnb: 'Airbnb', vrbo: 'Vrbo', booking: 'Booking.com', direct: 'Direct' };
const entityOf = (value: string | null) => (value && /^\d+$/.test(value) ? Number(value) : null);

export function guestRoutes(app: FastifyInstance, guests: GuestService) {
  app.get('/api/guests', async (request) => ({ guests: guests.list(entityOf(queryOf(request.query).get('entity'))) }));

  // All guests as a CSV, for a spreadsheet or a mailing tool. Guests marked "don't
  // contact" are left out unless all=1.
  app.get('/api/guests.csv', async (request, reply) => {
    const query = queryOf(request.query);
    const all = query.get('all') === '1';
    const rows = guests.list(entityOf(query.get('entity'))).filter((g) => all || !g.noContact);
    const header = [
      'Name',
      'Email',
      'Email is a platform relay',
      'Phone',
      'From',
      'Booked through',
      'Properties',
      'Stays',
      'Nights',
      'First stay',
      'Last stay',
      'Upcoming stay',
      'Total paid',
      "Don't contact",
      'Note',
    ];
    const lines = rows.map((g) => [
      g.name,
      g.email ?? '',
      g.emailRelay ? 'yes' : '',
      g.phone ?? '',
      g.location ?? '',
      g.platforms.map((p) => PLATFORMS[p] || p).join(', '),
      g.properties.join(', '),
      g.stays,
      g.nights,
      g.firstStay,
      g.lastStay,
      g.upcoming ? 'yes' : '',
      g.spent,
      g.noContact ? 'yes' : '',
      g.note ?? '',
    ]);
    (request as AuthedRequest).audit('guests.export', { rows: rows.length });
    const body = `﻿${[header, ...lines].map((row) => row.map((v) => core.csvCell(v)).join(',')).join('\r\n')}\r\n`;
    return reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="guests.csv"').header('Cache-Control', 'no-store').send(body);
  });

  app.post('/api/guests/mark', async (request) => {
    const result = z.object({ key: z.string().min(3).max(220), noContact: z.boolean().optional(), note: z.string().trim().max(500).nullable().optional() }).safeParse(request.body);
    if (!result.success) throw new HttpError(400, result.error.issues[0]?.message || 'Invalid request.');
    const { key, ...change } = result.data;
    guests.mark(key, { ...change, note: change.note === '' ? null : change.note });
    (request as AuthedRequest).audit('guests.mark', { noContact: change.noContact });
    return { ok: true };
  });
}
