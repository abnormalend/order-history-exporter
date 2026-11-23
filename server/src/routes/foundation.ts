// A private foundation's dashboard: investment growth, grants and the five-year calendar.
import type { FastifyInstance } from 'fastify';
import { HttpError } from '../params';
import type { FoundationService } from '../foundation/service';

export function foundationRoutes(app: FastifyInstance, foundation: FoundationService, entityExists: (id: number) => boolean) {
  app.get('/api/foundation/:id', async (request) => {
    const raw = (request.params as { id: string }).id;
    const id = /^\d+$/.test(raw) ? Number(raw) : 0;
    if (!id || !entityExists(id)) throw new HttpError(404, 'No such foundation.');
    return foundation.summary(id);
  });
}
