import { DomainError } from '../../../../shared/errors/domain-error.js';
import { MAX_TASK_DEPTH } from '../max-task-depth.js';

export class TaskDepthExceededError extends DomainError {
  readonly code = 'UNPROCESSABLE_CONTENT';
  readonly httpStatus = 422;

  constructor(parentTaskId: string) {
    super(
      `Esta tarea ya tiene ${MAX_TASK_DEPTH} niveles de subtareas, no se puede descomponer más.`,
      {
        domain_code: 'max_depth_exceeded',
        details: { parentTaskId, maxDepth: MAX_TASK_DEPTH },
      },
    );
  }
}
