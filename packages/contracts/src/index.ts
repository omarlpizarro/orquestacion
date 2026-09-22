import { populateContractRouterPaths } from '@orpc/contract';
import { healthContract } from './health/health.contract.js';
import { createTaskContract } from './projects/create-task.contract.js';

export const contract = populateContractRouterPaths({
  health: healthContract,
  projects: {
    createTask: createTaskContract,
  },
});
export type Contract = typeof contract;

export { type HealthOutput, healthContract, healthOutputSchema } from './health/health.contract.js';
export {
  type CreateTaskInput,
  createTaskContract,
  createTaskInputSchema,
  type TaskOutput,
  taskOutputSchema,
  taskStatusSchema,
} from './projects/create-task.contract.js';
export { base, domainErrorData, withClientMutationId } from './shared/base.contract.js';
export { idSchema, newId } from './shared/id.js';
export { localDateTimeSchema } from './shared/local-datetime.js';
export { memberIdSchema } from './shared/member-id.js';
