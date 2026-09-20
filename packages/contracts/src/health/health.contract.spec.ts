import { describe, expect, it } from 'vitest';
import { healthOutputSchema } from './health.contract.js';

describe('healthOutputSchema', () => {
  it('acepta una respuesta saludable', () => {
    const result = healthOutputSchema.safeParse({
      status: 'ok',
      requestId: '01945f4e-0000-7000-8000-000000000000',
      database: {
        reachable: true,
        connectedAs: 'app_login',
        serverTimeUtc: '2026-09-19T00:00:00.000Z',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rechaza un status distinto de ok', () => {
    const result = healthOutputSchema.safeParse({
      status: 'degraded',
      requestId: '01945f4e-0000-7000-8000-000000000000',
      database: { reachable: true, connectedAs: 'app_login', serverTimeUtc: 'now' },
    });
    expect(result.success).toBe(false);
  });
});
