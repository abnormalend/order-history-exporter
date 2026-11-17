// The retirement plan: read it with its projection, try changes without saving, save.
// Owners only (a family login is refused before reaching these).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { RetirementService } from '../retirement/service';
import type { Plan } from '../retirement/project';
import { STATES } from '../retirement/tax';
import { HttpError } from '../params';
import type { AuthedRequest } from '../app';

const thisYear = new Date().getFullYear();
const dollars = z.number().min(0).max(1e8);
const rate = z.number().min(-0.5).max(0.5);
const person = z
  .object({
    name: z.string().trim().min(1).max(40),
    birthYear: z.number().int().min(thisYear - 100, 'Check the birth year.').max(thisYear - 16, 'Check the birth year.'),
    retireAge: z.number().int().min(30).max(85),
    planToAge: z.number().int().min(60).max(110),
    takeHome: dollars,
    contributions: z.object({ pre_tax: dollars, roth: dollars, hsa: dollars, deferred: dollars.optional() }),
    ssAtFullAge: z.number().min(0).max(20000),
    ssClaimAge: z.number().min(62, 'Social Security starts at 62 at the earliest.').max(70, 'Waiting past 70 adds nothing.'),
  })
  .refine((p) => p.planToAge > p.retireAge, 'The plan has to run past retiring.');
const planSchema = z.object({
  me: person,
  spouse: person.nullable(),
  spending: dollars,
  spendingChangeAt80: z.number().min(-0.9).max(1),
  markets: z.object({
    stocks: rate,
    bonds: rate,
    cash: rate,
    inflation: z.number().min(-0.05).max(0.2),
    volatility: z.object({ stocks: z.number().min(0).max(0.6), bonds: z.number().min(0).max(0.4) }).optional(),
  }),
  streams: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(60),
        owner: z.enum(['me', 'spouse']),
        startAge: z.number().int().min(0).max(110),
        endAge: z.number().int().min(0).max(120).nullable(),
        yearly: z.number().min(0).max(1e8),
        inflationAdjusted: z.boolean(),
        taxable: z.boolean().optional(),
      })
    )
    .max(30),
  events: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(60),
        year: z.number().int().min(thisYear - 1).max(thisYear + 80),
        years: z.number().int().min(1).max(60),
        amount: z.number().min(-1e8).max(1e8),
      })
    )
    .max(50),
  taxes: z
    .object({
      enabled: z.boolean(),
      state: z.enum(Object.keys(STATES) as [string, ...string[]]),
      stateRate: z.number().min(0).max(0.15).optional(),
      stateDeduction: dollars.optional(),
      rothConversionsTo: z.union([z.literal(0.12), z.literal(0.22), z.literal(0.24), z.literal(0.32)]).nullable(),
      withdrawalOrder: z.enum(['standard', 'pretax_first']),
      deferredYears: z.number().int().min(1).max(15),
    })
    .optional(),
});

function parse(body: unknown): Plan {
  const result = planSchema.safeParse(body);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new HttpError(400, issue ? `${issue.path.join(' › ') || 'Plan'}: ${issue.message}` : 'Invalid plan.');
  }
  return result.data as Plan;
}

export function retirementRoutes(app: FastifyInstance, retirement: RetirementService) {
  app.get('/api/retirement', async () => retirement.get());
  app.post('/api/retirement/preview', async (request) => retirement.preview(parse(request.body)));
  app.post('/api/retirement/simulate', async (request) => {
    const body = (request.body ?? {}) as { plan?: unknown; trials?: unknown };
    const trials = body.trials === undefined ? undefined : Number(body.trials);
    if (trials !== undefined && !(Number.isInteger(trials) && trials >= 100 && trials <= 5000)) throw new HttpError(400, 'Trials: 100 to 5,000.');
    return retirement.trials(parse(body.plan), { trials });
  });
  app.post('/api/retirement/compare', async (request) => retirement.compare(parse(request.body)));
  app.post('/api/retirement/scenarios', async (request) => {
    const body = (request.body ?? {}) as { name?: unknown; plan?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 60) throw new HttpError(400, 'Give the scenario a name (up to 60 characters).');
    const scenarios = retirement.saveScenario(name, parse(body.plan));
    (request as AuthedRequest).audit('retirement.scenario', { name });
    return { scenarios };
  });
  app.post('/api/retirement/scenarios/:id/delete', async (request) => {
    const id = Number((request.params as { id: string }).id);
    const scenarios = retirement.removeScenario(id);
    (request as AuthedRequest).audit('retirement.scenario.delete', { id });
    return { scenarios };
  });
  app.post('/api/retirement/plan', async (request) => {
    const plan = parse(request.body);
    const projection = retirement.save(plan);
    (request as AuthedRequest).audit('retirement.plan', { people: plan.spouse ? 2 : 1, streams: plan.streams.length, events: plan.events.length });
    return { projection };
  });
}
