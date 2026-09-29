import { Module } from '@nestjs/common';
import { GrantSiteAccessController } from './features/grant-site-access/grant-site-access.controller.js';
import { GrantSiteAccessHandler } from './features/grant-site-access/grant-site-access.handler.js';
import { TenancyService } from './tenancy.service.js';

@Module({
  controllers: [GrantSiteAccessController],
  providers: [TenancyService, GrantSiteAccessHandler],
  exports: [TenancyService],
})
export class TenancyModule {}

// Otro módulo solo puede importar el archivo de módulo de este, nunca sus
// internals (CLAUDE.md §5, dependency-cruiser `no-cross-module-internals`).
export { TenancyService } from './tenancy.service.js';
