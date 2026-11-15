// Personal money: a summary for a month or a year with a look ahead, and budgets.
// The owner sees their own or a family member's; a family member's login sees only
// their own.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { PersonalService } from '../personal/service';
import { HttpError, queryOf } from '../params';
import type { AuthedRequest } from '../app';

// Whose money a request is about: a family login is always its own person.
function personFor(request: FastifyRequest, asked: string | number | null | undefined): number | null {
  const user = (request as AuthedRequest).user!;
  if (user.role === 'member') return user.personId;
  if (asked === null || asked === undefined || asked === '' || asked === 'me') return null;
  const id = Number(asked);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Whose money?');
  return id;
}

export function personalRoutes(app: FastifyInstance, personal: PersonalService) {
  app.get('/api/personal', async (request) => {
    const query = queryOf(request.query);
    const month = query.get('month');
    const year = query.get('year');
    if (month && !/^\d{4}-\d{2}$/.test(month)) throw new HttpError(400, 'A month looks like 2026-11.');
    if (year && !/^\d{4}$/.test(year)) throw new HttpError(400, 'A year looks like 2026.');
    const person = personFor(request, query.get('person'));
    if (person !== null && !personal.people().some((p) => p.id === person)) throw new HttpError(404, 'That person is not here.');
    const accounts = (query.get('accounts') || '')
      .split(',')
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0);
    const summary = personal.summary({ month, year, accounts: accounts.length ? accounts : null, person });
    // A family member isn't shown who else is here.
    return (request as AuthedRequest).user!.role === 'member' ? { ...summary, people: [] } : summary;
  });

  app.post('/api/personal/budgets', async (request) => {
    const result = z
      .object({ group: z.string().min(1).max(40), monthly: z.number().min(0).max(1e8).nullable(), person: z.number().int().positive().nullable().optional() })
      .safeParse(request.body);
    if (!result.success) throw new HttpError(400, 'A budget is a kind of spending and an amount.');
    const person = personFor(request, result.data.person);
    try {
      const budgets = personal.setBudget(person, result.data.group, result.data.monthly);
      (request as unknown as AuthedRequest).audit('personal.budget', { ...result.data, person });
      return { budgets };
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  });
}
