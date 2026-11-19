// Material participation hours: the logs, the work that is worked out from stays and
// repeating jobs, questions about paid help and purchases, and the yearly tests.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HOUR_SOURCES } from '../hours/service';
import type { HoursService } from '../hours/service';
import { HttpError } from '../params';
import type { AuthedRequest } from '../app';

const name = z.string().trim().min(1).max(80);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates look like YYYY-MM-DD.');
const hours = z.number().positive('Hours must be more than zero.').max(24, 'No more than 24 hours a day.');
const id = z.number().int().positive();
const propertyId = z.string().min(1).max(80).nullable();
const task = z.string().trim().min(1).max(200);

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new HttpError(400, result.error.issues[0]?.message || 'Invalid request.');
  return result.data;
}
const idOf = (params: unknown) => {
  const value = Number((params as { id: string }).id);
  if (!Number.isInteger(value) || value <= 0) throw new HttpError(400, 'Which one?');
  return value;
};
const audit = (request: unknown, action: string, detail: unknown) => (request as AuthedRequest).audit(action, detail);
const minutes = (h: number) => Math.round(h * 60);

const taskBody = z.object({ personId: id, propertyId, task, hours, from: day.nullable().default(null), to: day.nullable().default(null) });
const recurringBody = z.object({
  personId: id,
  entityId: id,
  propertyId: propertyId.default(null),
  task,
  hours,
  everyDays: z.number().int().min(1).max(366).default(7),
  start: day,
  end: day.nullable().default(null),
});
const entryBody = z.object({
  personId: id,
  entityId: id.nullable().default(null),
  propertyId: propertyId.default(null),
  day,
  task,
  hours,
  note: z.string().trim().max(500).nullable().default(null),
});

export function hoursRoutes(app: FastifyInstance, hoursService: HoursService) {
  // Working the hours out on every visit keeps them up to date with new stays.
  app.get('/api/hours', async () => {
    hoursService.rebuild();
    return hoursService.overview();
  });

  app.get('/api/hours/summary', async (request) => {
    const year = String((request.query as { year?: string }).year || new Date().getFullYear());
    if (!/^\d{4}$/.test(year)) throw new HttpError(400, 'Which year?');
    return { year, businesses: hoursService.summary(year) };
  });

  app.get('/api/hours/entries', async (request) => {
    const q = request.query as Record<string, string | undefined>;
    const filters = parse(
      z.object({
        log: z.coerce.number().int().positive(),
        year: z
          .string()
          .regex(/^\d{4}$/)
          .nullable()
          .default(null),
        source: z
          .enum(HOUR_SOURCES as [string, ...string[]])
          .nullable()
          .default(null),
        person: z.coerce.number().int().positive().nullable().default(null),
        entity: z.coerce.number().int().positive().nullable().default(null),
        removed: z.enum(['1', '0']).default('0'),
        offset: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }),
      Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined && v !== '')),
    );
    return hoursService.entries({
      logId: filters.log,
      year: filters.year,
      source: filters.source as never,
      personId: filters.person,
      entityId: filters.entity,
      removed: filters.removed === '1',
      offset: filters.offset,
      limit: filters.limit,
    });
  });

  app.post('/api/hours/logs', async (request) => {
    const body = parse(z.object({ name, people: z.array(name).max(10).default([]) }), request.body);
    const logId = hoursService.addLog(body.name);
    for (const person of body.people) hoursService.addPerson(logId, person);
    audit(request, 'hours.log.add', { id: logId, name: body.name });
    return { id: logId, ...hoursService.overview() };
  });
  app.post('/api/hours/logs/:id', async (request) => {
    const logId = idOf(request.params);
    const body = parse(z.object({ name }), request.body);
    hoursService.renameLog(logId, body.name);
    audit(request, 'hours.log.rename', { id: logId, name: body.name });
    return hoursService.overview();
  });
  app.post('/api/hours/logs/:id/delete', async (request) => {
    const logId = idOf(request.params);
    hoursService.removeLog(logId);
    audit(request, 'hours.log.delete', { id: logId });
    return hoursService.overview();
  });
  app.post('/api/hours/logs/:id/people', async (request) => {
    const logId = idOf(request.params);
    const body = parse(z.object({ name }), request.body);
    const personId = hoursService.addPerson(logId, body.name);
    audit(request, 'hours.person.add', { logId, id: personId });
    return hoursService.overview();
  });
  app.post('/api/hours/people/:id', async (request) => {
    const personId = idOf(request.params);
    const body = parse(z.object({ name }), request.body);
    hoursService.renamePerson(personId, body.name);
    audit(request, 'hours.person.rename', { id: personId });
    return hoursService.overview();
  });
  app.post('/api/hours/people/:id/delete', async (request) => {
    const personId = idOf(request.params);
    hoursService.removePerson(personId);
    audit(request, 'hours.person.delete', { id: personId });
    return hoursService.overview();
  });

  app.post('/api/hours/tasks', async (request) => {
    const body = parse(taskBody, request.body);
    const taskId = hoursService.addTask({ ...body, minutes: minutes(body.hours) });
    audit(request, 'hours.task.add', { id: taskId, ...body });
    return hoursService.overview();
  });
  app.post('/api/hours/tasks/:id', async (request) => {
    const taskId = idOf(request.params);
    const body = parse(taskBody, request.body);
    hoursService.updateTask(taskId, { ...body, minutes: minutes(body.hours) });
    audit(request, 'hours.task.update', { id: taskId, ...body });
    return hoursService.overview();
  });
  app.post('/api/hours/tasks/:id/delete', async (request) => {
    const taskId = idOf(request.params);
    hoursService.removeTask(taskId);
    audit(request, 'hours.task.delete', { id: taskId });
    return hoursService.overview();
  });

  app.post('/api/hours/recurring', async (request) => {
    const body = parse(recurringBody, request.body);
    const ruleId = hoursService.addRecurring({ ...body, minutes: minutes(body.hours) });
    audit(request, 'hours.recurring.add', { id: ruleId, ...body });
    return hoursService.overview();
  });
  app.post('/api/hours/recurring/:id', async (request) => {
    const ruleId = idOf(request.params);
    const body = parse(recurringBody, request.body);
    hoursService.updateRecurring(ruleId, { ...body, minutes: minutes(body.hours) });
    audit(request, 'hours.recurring.update', { id: ruleId, ...body });
    return hoursService.overview();
  });
  app.post('/api/hours/recurring/:id/delete', async (request) => {
    const ruleId = idOf(request.params);
    hoursService.removeRecurring(ruleId);
    audit(request, 'hours.recurring.delete', { id: ruleId });
    return hoursService.overview();
  });

  app.post('/api/hours/entries', async (request) => {
    const body = parse(entryBody, request.body);
    const entryId = hoursService.addEntry({ ...body, minutes: minutes(body.hours) });
    audit(request, 'hours.entry.add', { id: entryId });
    return { id: entryId };
  });
  app.post('/api/hours/entries/:id', async (request) => {
    const entryId = idOf(request.params);
    const body = parse(entryBody, request.body);
    hoursService.updateEntry(entryId, { ...body, minutes: minutes(body.hours) });
    audit(request, 'hours.entry.update', { id: entryId });
    return { ok: true };
  });
  app.post('/api/hours/entries/:id/delete', async (request) => {
    const entryId = idOf(request.params);
    hoursService.removeEntry(entryId);
    audit(request, 'hours.entry.delete', { id: entryId });
    return { ok: true };
  });
  app.post('/api/hours/entries/:id/reset', async (request) => {
    const entryId = idOf(request.params);
    hoursService.resetEntry(entryId);
    audit(request, 'hours.entry.reset', { id: entryId });
    return { ok: true };
  });

  app.get('/api/hours/help', async () => ({ payments: hoursService.helpPayments() }));
  app.post('/api/hours/help/:id', async (request) => {
    const transactionId = idOf(request.params);
    const body = parse(z.object({ isHelp: z.boolean(), stayId: z.string().min(1).max(80).nullable().default(null), hours: z.number().min(0).max(200).nullable().default(null) }), request.body);
    hoursService.answerHelp(transactionId, body);
    audit(request, 'hours.help.answer', { transactionId, ...body });
    return { payments: hoursService.helpPayments() };
  });
  app.post('/api/hours/help/:id/forget', async (request) => {
    const transactionId = idOf(request.params);
    hoursService.forgetHelp(transactionId);
    audit(request, 'hours.help.forget', { transactionId });
    return { payments: hoursService.helpPayments() };
  });

  app.get('/api/hours/purchases', async (request) => {
    const q = request.query as Record<string, string | undefined>;
    const answered = q.answered === '1';
    const offset = Math.max(0, Number(q.offset) || 0);
    return hoursService.purchases({ answered, offset, limit: 50 });
  });
  app.post('/api/hours/purchases/:id', async (request) => {
    const transactionId = idOf(request.params);
    const body = parse(
      z.object({
        installed: z.boolean(),
        personId: id.nullable().default(null),
        hours: hours.nullable().default(null),
        task: task.nullable().default(null),
        day: day.nullable().default(null),
        propertyId: propertyId.default(null),
      }),
      request.body,
    );
    hoursService.answerPurchase(transactionId, { ...body, minutes: body.hours === null ? null : minutes(body.hours) });
    audit(request, 'hours.purchase.answer', { transactionId, installed: body.installed });
    return { ok: true };
  });
  app.post('/api/hours/purchases/:id/forget', async (request) => {
    const transactionId = idOf(request.params);
    hoursService.forgetPurchase(transactionId);
    audit(request, 'hours.purchase.forget', { transactionId });
    return { ok: true };
  });

  app.post('/api/hours/import', async (request) => {
    const body = parse(
      z.object({
        logId: id,
        rows: z
          .array(
            z.object({
              person: name,
              day,
              task,
              hours,
              entity: z.string().trim().max(120).nullable().default(null),
              property: z.string().trim().max(120).nullable().default(null),
              note: z.string().trim().max(500).nullable().default(null),
            }),
          )
          .min(1)
          .max(5000),
      }),
      request.body,
    );
    const added = hoursService.importRows(body.logId, body.rows);
    audit(request, 'hours.import', { logId: body.logId, added });
    return { added };
  });
}
