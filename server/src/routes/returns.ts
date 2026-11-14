// Tax returns as filed, beside Business Hub's figures. Signed-in users only.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ReturnsService } from '../returns/service';
import { HttpError, queryOf } from '../params';
import type { AuthedRequest } from '../app';

const lineSchema = z.object({
  section: z.string().trim().min(1).max(120),
  line: z.string().trim().min(1).max(160),
  reported: z.number().min(-1e10).max(1e10),
  worksheet: z.number().min(-1e10).max(1e10).nullable().optional(),
  categories: z.array(z.string().trim().min(1).max(100)).max(30).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
});
const saveSchema = z.object({
  entityId: z.number().int().positive(),
  year: z.string().regex(/^\d{4}$/, 'A year looks like 2023.'),
  form: z.string().trim().max(40).nullable().optional(),
  lines: z.array(lineSchema).max(200),
});

export function returnsRoutes(app: FastifyInstance, returns: ReturnsService, entityExists: (id: number) => boolean) {
  app.get('/api/returns', async (request) => {
    const year = queryOf(request.query).get('year') || returns.years()[0] || String(new Date().getFullYear() - 1);
    if (!/^\d{4}$/.test(year)) throw new HttpError(400, 'A year looks like 2023.');
    return returns.list(year);
  });

  app.post('/api/returns', async (request) => {
    const result = saveSchema.safeParse(request.body);
    if (!result.success) {
      const issue = result.error.issues[0];
      throw new HttpError(400, issue ? `${issue.path.join('.') || 'Request'}: ${issue.message}` : 'Invalid request.');
    }
    const body = result.data;
    if (!entityExists(body.entityId)) throw new HttpError(404, 'That business or property was not found.');
    (request as unknown as AuthedRequest).audit('returns.save', { entityId: body.entityId, year: body.year, lines: body.lines.length });
    return returns.save(body.entityId, body.year, body.form ?? null, body.lines);
  });
}
