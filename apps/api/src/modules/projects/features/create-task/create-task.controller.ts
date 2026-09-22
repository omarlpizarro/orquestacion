import { Controller, Logger } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract, domainErrorData } from '@orq/contracts';
import { DomainError } from '../../../../shared/errors/domain-error.js';
import { CreateTaskHandler } from './create-task.handler.js';

@Controller()
export class CreateTaskController {
  private readonly logger = new Logger(CreateTaskController.name);

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
          if (!respond) {
            // No debería pasar con los errores de este slice: es la red
            // de seguridad para el día que un `DomainError` nuevo use un
            // code que el contrato no declaró. Preferimos un 422 logueado
            // a que oRPC intente llamar a `undefined` y explote como 500
            // opaco.
            this.logger.error(
              `DomainError con code "${error.code}" no está declarado en el contrato de create-task.`,
            );
            throw errors.UNPROCESSABLE_CONTENT({
              message: error.message,
              data: { domain_code: 'unmapped_domain_error' },
            });
          }
          throw respond({ message: error.message, data: domainErrorData.parse(error.data) });
        }
        throw error;
      }
    });
  }
}
