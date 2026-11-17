// Wealth: net worth across every household account, and accounts typed in by hand.
// Owners only (a family login is refused before reaching these).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { WealthService } from '../wealth/service';
import { HOLDERS } from '../wealth/service';
import { ASSET_CLASSES } from '../wealth/positions';
import type { AssetClass } from '../wealth/positions';
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

  app.get('/api/wealth/accounts/:id/holdings', async (request) => wealth.holdings(idOf(request.params)));

  // A brokerage positions file: read first, then saved to the accounts chosen.
  const positionsFile = z.object({ fileName: z.string().max(200).optional(), text: z.string().min(1, 'The file is empty.').max(2_000_000, 'That file is too big for a positions download.') });
  app.post('/api/wealth/positions/inspect', async (request) => wealth.inspectPositions(parse(positionsFile, request.body).text));

  app.post('/api/wealth/positions', async (request) => {
    const body = parse(positionsFile.extend({ assign: z.record(z.string().max(10), z.union([z.number().int().positive(), z.literal('new'), z.null()])) }), request.body);
    const result = wealth.savePositions(body.text, body.assign);
    audit(request, 'wealth.positions', { fileName: body.fileName ?? null, assign: body.assign, ...result });
    return result;
  });

  app.post('/api/wealth/classes', async (request) => {
    const body = parse(z.object({ key: z.string().trim().min(1).max(210), assetClass: z.enum(Object.keys(ASSET_CLASSES) as [AssetClass, ...AssetClass[]]).nullable() }), request.body);
    wealth.setClass(body.key, body.assetClass);
    audit(request, 'wealth.class', body);
    return { ok: true };
  });

  app.post('/api/wealth/suggestions', async (request) => {
    const body = parse(z.object({ ids: z.array(z.number().int().positive()).min(1).max(200) }), request.body);
    const changed = wealth.applySuggestions(body.ids);
    audit(request, 'wealth.suggestions', { ...body, changed });
    return { changed };
  });

  app.post('/api/wealth/accounts/:id/delete', async (request) => {
    const id = idOf(request.params);
    wealth.removeAccount(id);
    audit(request, 'wealth.account.delete', { id });
    return { ok: true };
  });
}
