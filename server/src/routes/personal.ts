// The owner's personal money: a monthly summary with a look ahead, and budgets.
// Signed-in users only.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PersonalService } from '../personal/service';
import { HttpError, queryOf } from '../params';
import type { AuthedRequest } from '../app';

export function personalRoutes(app: FastifyInstance, personal: PersonalService) {
  app.get('/api/personal', async (request) => {
    const query = queryOf(request.query);
    const month = query.get('month');
    if (month && !/^\d{4}-\d{2}$/.test(month)) throw new HttpError(400, 'A month looks like 2026-11.');
    const accounts = (query.get('accounts') || '')
      .split(',')
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0);
    return personal.summary(month, accounts.length ? accounts : null);
  });

  app.post('/api/personal/budgets', async (request) => {
    const result = z.object({ group: z.string().min(1).max(40), monthly: z.number().min(0).max(1e8).nullable() }).safeParse(request.body);
    if (!result.success) throw new HttpError(400, 'A budget is a kind of spending and an amount.');
    try {
      const budgets = personal.setBudget(result.data.group, result.data.monthly);
      (request as unknown as AuthedRequest).audit('personal.budget', result.data);
      return { budgets };
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  });
}
