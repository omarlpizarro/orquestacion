import { Controller, Logger } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { contract } from '@orq/contracts';
import { rethrowDomainError } from '../../../../shared/errors/orpc-domain-error.js';
import { AddTaskCommentHandler } from './add-task-comment.handler.js';

@Controller()
export class AddTaskCommentController {
  private readonly logger = new Logger(AddTaskCommentController.name);

  constructor(private readonly handler: AddTaskCommentHandler) {}

  @Implement(contract.projects.addTaskComment)
  addTaskComment() {
    return implement(contract.projects.addTaskComment).handler(async ({ input, errors }) => {
      try {
        return await this.handler.execute(input);
      } catch (error) {
        // Los errores de este slice son casos finos de los códigos genéricos que
        // ya declara `base` (CLAUDE.md §8); `domain_code` los distingue.
        return rethrowDomainError(error, errors, this.logger, 'add-task-comment');
      }
    });
  }
}
