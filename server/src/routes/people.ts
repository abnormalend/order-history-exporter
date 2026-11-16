// Family members and their logins. The owner only: a family login is refused before
// it reaches these (see the member check in app.ts).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PeopleService } from '../people/service';
import { HttpError } from '../params';
import type { AuthedRequest } from '../app';

const name = z.string().trim().min(1).max(60);
const username = z.string().trim().min(1).max(60);
const password = z.string().min(10, 'Use at least 10 characters.').max(200);

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new HttpError(400, result.error.issues[0]?.message || 'Invalid request.');
  return result.data;
}
const idOf = (params: unknown) => {
  const id = Number((params as { id: string }).id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Which person?');
  return id;
};
const audit = (request: unknown, action: string, detail: unknown) => (request as AuthedRequest).audit(action, detail);

const selfOf = (request: unknown) => (request as AuthedRequest).user!.id;

export function peopleRoutes(app: FastifyInstance, people: PeopleService) {
  // Admins: full access, the same as the first login.
  app.get('/api/admins', async (request) => ({ admins: people.admins(), selfId: selfOf(request) }));

  app.post('/api/admins', async (request) => {
    const body = parse(z.object({ username, password }), request.body);
    const id = people.addAdmin(body.username, body.password);
    audit(request, 'admin.add', { id, username: body.username });
    return { admins: people.admins(), selfId: selfOf(request) };
  });

  app.post('/api/admins/:id/password', async (request) => {
    const id = idOf(request.params);
    const body = parse(z.object({ password }), request.body);
    const login = people.resetAdminPassword(id, body.password, selfOf(request));
    audit(request, 'admin.password', { id, username: login });
    return { admins: people.admins(), selfId: selfOf(request) };
  });

  app.post('/api/admins/:id/delete', async (request) => {
    const id = idOf(request.params);
    const login = people.removeAdmin(id, selfOf(request));
    audit(request, 'admin.delete', { id, username: login });
    return { admins: people.admins(), selfId: selfOf(request) };
  });

  app.get('/api/people', async () => people.list());

  app.post('/api/people', async (request) => {
    const body = parse(z.object({ name }), request.body);
    const id = people.add(body.name);
    audit(request, 'person.add', { id, name: body.name });
    return { id, ...people.list() };
  });

  app.post('/api/people/:id', async (request) => {
    const id = idOf(request.params);
    const body = parse(z.object({ name: name.optional(), accounts: z.array(z.number().int().positive()).max(200).optional() }), request.body);
    people.update(id, body);
    audit(request, 'person.update', { id, ...body });
    return people.list();
  });

  app.post('/api/people/:id/delete', async (request) => {
    const id = idOf(request.params);
    people.remove(id);
    audit(request, 'person.delete', { id });
    return people.list();
  });

  app.post('/api/people/:id/login', async (request) => {
    const id = idOf(request.params);
    const body = parse(z.object({ username, password }), request.body);
    people.addLogin(id, body.username, body.password);
    audit(request, 'person.login.add', { id, username: body.username });
    return people.list();
  });

  app.post('/api/people/:id/login/password', async (request) => {
    const id = idOf(request.params);
    const body = parse(z.object({ password }), request.body);
    const login = people.resetPassword(id, body.password);
    audit(request, 'person.login.password', { id, username: login });
    return people.list();
  });

  app.post('/api/people/:id/login/delete', async (request) => {
    const id = idOf(request.params);
    const login = people.removeLogin(id);
    audit(request, 'person.login.delete', { id, username: login });
    return people.list();
  });
}
