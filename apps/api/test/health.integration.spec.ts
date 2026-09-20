import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { type PostgresHarness, startPostgresHarness } from '@orq/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

describe('GET /health (integración)', () => {
  let harness: PostgresHarness;
  let app: NestFastifyApplication;

  beforeAll(async () => {
    harness = await startPostgresHarness();
    process.env.DATABASE_URL = harness.appConnectionUri;
    process.env.DATABASE_APP_ROLE = 'app_login';

    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
      logger: false,
    });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await harness.stop();
  });

  it('responde 200 conectada como app_login, con el mismo requestId que envió', async () => {
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: '/health',
        headers: { 'x-request-id': '01945f4e-0000-7000-8000-000000000000' },
      });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      status: 'ok',
      requestId: '01945f4e-0000-7000-8000-000000000000',
      database: { reachable: true, connectedAs: 'app_login' },
    });
  });

  it('responde 503 si DATABASE_APP_ROLE no coincide con la conexión real', async () => {
    // Prueba negativa: si esto alguna vez devuelve 200, el health check dejó
    // de detectar una conexión mal configurada.
    process.env.DATABASE_APP_ROLE = 'un_rol_que_no_es';

    const misconfiguredApp = await NestFactory.create<NestFastifyApplication>(
      AppModule,
      new FastifyAdapter(),
      { logger: false },
    );
    await misconfiguredApp.init();

    try {
      const response = await misconfiguredApp.getHttpAdapter().getInstance().inject({
        method: 'GET',
        url: '/health',
      });
      expect(response.statusCode).toBe(503);
    } finally {
      await misconfiguredApp.close();
      process.env.DATABASE_APP_ROLE = 'app_login';
    }
  });
});
