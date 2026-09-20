import { z } from 'zod';
import { base } from '../shared/base.contract.js';

export const healthOutputSchema = z.object({
  status: z.literal('ok'),
  requestId: z.string(),
  database: z.object({
    reachable: z.literal(true),
    connectedAs: z.string(),
    serverTimeUtc: z.string(),
  }),
});
export type HealthOutput = z.infer<typeof healthOutputSchema>;

export const healthContract = {
  get: base
    .errors({
      DATABASE_MISCONFIGURED: {
        status: 503,
        message: 'La base de datos está mal configurada.',
      },
    })
    .route({
      method: 'GET',
      path: '/health',
      summary: 'Verifica que la API y la base de datos respondan',
      tags: ['platform'],
    })
    .output(healthOutputSchema),
};
