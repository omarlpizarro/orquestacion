import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadServerEnv } from '@orq/config';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const env = loadServerEnv();
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
  await app.listen(env.PORT, '0.0.0.0');
}

bootstrap();
