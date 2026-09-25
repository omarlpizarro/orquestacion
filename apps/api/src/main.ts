import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadServerEnv } from '@orq/config';
import { AppModule } from './app.module.js';
import { AUTH } from './shared/auth/auth.tokens.js';
import type { Auth } from './shared/auth/build-auth.js';
import { mountBetterAuth } from './shared/auth/mount-better-auth.js';

async function bootstrap() {
  const env = loadServerEnv();
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
  mountBetterAuth(app, app.get<Auth>(AUTH));
  await app.listen(env.PORT, '0.0.0.0');
}

bootstrap();
