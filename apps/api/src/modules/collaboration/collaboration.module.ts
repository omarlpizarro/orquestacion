import { Module } from '@nestjs/common';
import { CollaborationService } from './collaboration.service.js';

@Module({
  providers: [CollaborationService],
  exports: [CollaborationService],
})
export class CollaborationModule {}

// Otro módulo solo puede importar el archivo de módulo de este, nunca sus
// internals (CLAUDE.md §5, dependency-cruiser `no-cross-module-internals`).
export { CollaborationService, type TaskUpdateKind } from './collaboration.service.js';
