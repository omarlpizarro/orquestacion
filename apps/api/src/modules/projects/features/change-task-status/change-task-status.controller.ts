import { Controller, Logger } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract, domainErrorData } from '@orq/contracts';
import { DomainError } from '../../../../shared/errors/domain-error.js';
import { ChangeTaskStatusHandler } from './change-task-status.handler.js';

@Controller()
export class ChangeTaskStatusController {
  private readonly logger = new Logger(ChangeTaskStatusController.name);

  constructor(private readonly handler: ChangeTaskStatusHandler) {}

  @Implement(contract.projects.changeTaskStatus)
  changeTaskStatus() {
    return implement(contract.projects.changeTaskStatus).handler(async ({ input, errors }) => {
      try {
        return await this.handler.execute(input);
      } catch (error) {
        // Genérico a propósito, igual que create-task: los errores de este
        // slice (tarea inexistente, transición inválida, rol sin permiso,
        // motivo faltante, versión desactualizada) son casos finos de los
        // códigos genéricos que ya declara `base` (CLAUDE.md §8).
        if (error instanceof DomainError) {
          const respond = errors[error.code as keyof typeof errors];
          if (!respond) {
            this.logger.error(
              `DomainError con code "${error.code}" no está declarado en el contrato de change-task-status.`,
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
