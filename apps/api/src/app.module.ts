import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ORPCModule } from '@orpc/nest';
import { PlatformModule } from './modules/platform/platform.module.js';
import { ProjectsModule } from './modules/projects/projects.module.js';
import { AuthModule } from './shared/auth/auth.module.js';
import { ConfigModule } from './shared/config/config.module.js';
import { DatabaseModule } from './shared/database/database.module.js';
import { DomainErrorFilter } from './shared/errors/domain-error.filter.js';
import { RequestContextMiddleware } from './shared/request-context/request-context.middleware.js';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    AuthModule,
    ORPCModule.forRoot({}),
    PlatformModule,
    ProjectsModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: DomainErrorFilter }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
