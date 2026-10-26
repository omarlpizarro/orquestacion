import { Module } from '@nestjs/common';
import { GetMemberNamesController } from './features/get-member-names/get-member-names.controller.js';
import { GetMemberNamesHandler } from './features/get-member-names/get-member-names.handler.js';
import { GrantSiteAccessController } from './features/grant-site-access/grant-site-access.controller.js';
import { GrantSiteAccessHandler } from './features/grant-site-access/grant-site-access.handler.js';
import { TenancyService } from './tenancy.service.js';

@Module({
  controllers: [GrantSiteAccessController, GetMemberNamesController],
  providers: [TenancyService, GrantSiteAccessHandler, GetMemberNamesHandler],
  exports: [TenancyService],
})
export class TenancyModule {}

// Otro módulo solo puede importar el archivo de módulo de este, nunca sus
// internals (CLAUDE.md §5, dependency-cruiser `no-cross-module-internals`).
export { TenancyService } from './tenancy.service.js';
