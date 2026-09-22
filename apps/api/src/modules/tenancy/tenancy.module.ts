import { Module } from '@nestjs/common';
import { TenancyService } from './tenancy.service.js';

@Module({
  providers: [TenancyService],
  exports: [TenancyService],
})
export class TenancyModule {}

// Otro módulo solo puede importar el archivo de módulo de este, nunca sus
// internals (CLAUDE.md §5, dependency-cruiser `no-cross-module-internals`).
export { TenancyService } from './tenancy.service.js';
