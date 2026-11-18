// The Tailscale and home-network switches, for the owner.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../params';
import type { AccessService } from '../access';
import type { AuthedRequest } from '../app';

const body = z.object({
  lan: z.object({ on: z.boolean(), days: z.number().int().min(1).max(365).nullable().optional() }).optional(),
  tailscale: z.boolean().optional(),
});

export function accessRoutes(app: FastifyInstance, access: AccessService) {
  const via = (request: { socket: { remoteAddress?: string }; host?: string }) => access.way(request.socket.remoteAddress, String(request.host || ''));

  app.get('/api/settings/access', async (request) => access.describe(via(request)));

  app.post('/api/settings/access', async (request) => {
    const result = body.safeParse(request.body);
    if (!result.success) throw new HttpError(400, result.error.issues[0]?.message || 'Invalid request.');
    (request as unknown as AuthedRequest).audit('settings.access', result.data);
    try {
      access.change(result.data);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    return access.describe(via(request));
  });
}
