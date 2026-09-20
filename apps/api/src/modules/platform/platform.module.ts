import { Module } from '@nestjs/common';
import { GetHealthController } from './features/get-health/get-health.controller.js';
import { GetHealthHandler } from './features/get-health/get-health.handler.js';

@Module({
  controllers: [GetHealthController],
  providers: [GetHealthHandler],
})
export class PlatformModule {}
