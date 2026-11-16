// Wealth: net worth across every household account, and accounts typed in by hand.
// Owners only (a family login is refused before reaching these).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { WealthService } from '../wealth/service';
import { HOLDERS } from '../wealth/service';
import { HttpError, queryOf } from '../params';
import type { AuthedRequest } from '../app';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date looks like 2026-11-15.');
const money = z.number().min(-1e10).max(1e10);
const holder = z.enum(HOLDERS).nullable();

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new HttpError(400, result.error.issues[0]?.message || 'Invalid request.');
  return result.data;
}
const idOf = (params: unknown) => {
  const id = Number((params as { id: string }).id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Which account?');
  return id;
};
const audit = (request: unknown, action: string, detail: unknown) => (request as AuthedRequest).audit(action, detail);

export function wealthRoutes(app: FastifyInstance, wealth: WealthService) {
  app.get('/api/wealth', async (request) => wealth.summary({ business: queryOf(request.query).get('business') === '1' }));

  app.post('/api/wealth/accounts', async (request) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(100),
        institution: z.string().trim().max(100).nullable().optional(),
        investType: z.string().min(1).max(40),
        holder,
        balance: money,
        day: day.nullable().optional(),
      }),
      request.body
    );
    const id = wealth.addAccount(body);
    audit(request, 'wealth.account.add', { id, ...body });
    return { id };
  });

  app.post('/api/wealth/accounts/:id', async (request) => {
    const id = idOf(request.params);
    const body = parse(z.object({ investType: z.string().min(1).max(40).nullable().optional(), holder: holder.optional(), name: z.string().trim().min(1).max(100).optional() }), request.body);
    wealth.updateAccount(id, body);
    audit(request, 'wealth.account.update', { id, ...body });
    return { ok: true };
  });

  app.get('/api/wealth/accounts/:id/balances', async (request) => ({ balances: wealth.balances(idOf(request.params)) }));

  app.post('/api/wealth/accounts/:id/balance', async (request) => {
    const id = idOf(request.params);
    const body = parse(z.object({ balance: money, day: day.nullable().optional() }), request.body);
    wealth.setBalance(id, body.balance, body.day);
    audit(request, 'wealth.balance', { id, ...body });
    return { ok: true };
  });

  app.post('/api/wealth/accounts/:id/delete', async (request) => {
    const id = idOf(request.params);
    wealth.removeAccount(id);
    audit(request, 'wealth.account.delete', { id });
    return { ok: true };
  });
}
