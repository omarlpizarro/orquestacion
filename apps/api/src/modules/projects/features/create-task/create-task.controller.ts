import { Controller } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@orq/contracts';
import { DomainError } from '../../../../shared/errors/domain-error.js';
import { CreateTaskHandler } from './create-task.handler.js';

@Controller()
export class CreateTaskController {
  constructor(private readonly handler: CreateTaskHandler) {}

  @Implement(contract.projects.createTask)
  createTask() {
    return implement(contract.projects.createTask).handler(async ({ input, errors }) => {
      try {
        return await this.handler.execute(input);
      } catch (error) {
        // Genérico a propósito: los tres errores de este slice (proyecto
        // inexistente, tarea padre inexistente, profundidad excedida) son
        // casos finos de los códigos genéricos que ya declara `base`
        // (CLAUDE.md §8) — `DomainError.code` es la clave de ese mapa, y
        // `data` ya tiene la forma de `domainErrorData`.
        if (error instanceof DomainError) {
          const respond = errors[error.code as keyof typeof errors];
          throw respond({
            message: error.message,
            data: error.data as { domain_code: string; details?: Record<string, unknown> },
          });
        }
        throw error;
      }
    });
  }
}
