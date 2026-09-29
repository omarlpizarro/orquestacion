import { populateContractRouterPaths } from '@orpc/contract';
import { healthContract } from './health/health.contract.js';
import { changeTaskStatusContract } from './projects/change-task-status.contract.js';
import { createTaskContract } from './projects/create-task.contract.js';
import { myDayContract } from './projects/my-day.contract.js';
import { grantSiteAccessContract } from './tenancy/grant-site-access.contract.js';

export const contract = populateContractRouterPaths({
  health: healthContract,
  tenancy: {
    grantSiteAccess: grantSiteAccessContract,
  },
  projects: {
    createTask: createTaskContract,
    changeTaskStatus: changeTaskStatusContract,
    myDay: myDayContract,
  },
});
export type Contract = typeof contract;

export { type HealthOutput, healthContract, healthOutputSchema } from './health/health.contract.js';
export {
  type ChangeTaskStatusInput,
  changeTaskStatusContract,
  changeTaskStatusInputSchema,
} from './projects/change-task-status.contract.js';
export {
  type CreateTaskInput,
  createTaskContract,
  createTaskInputSchema,
  type TaskOutput,
  taskOutputSchema,
  taskStatusSchema,
} from './projects/create-task.contract.js';
export {
  type MyDayInput,
  type MyDayOutput,
  type MyDaySection,
  type MyDayTaskOutput,
  myDayContract,
  myDayInputSchema,
  myDayOutputSchema,
  myDaySectionSchema,
  myDayTaskOutputSchema,
} from './projects/my-day.contract.js';
export { base, domainErrorData, withClientMutationId } from './shared/base.contract.js';
export { idSchema, newId } from './shared/id.js';
export { localDateTimeSchema } from './shared/local-datetime.js';
export { memberIdSchema } from './shared/member-id.js';
export { ianaTimeZoneSchema } from './shared/time-zone.js';
export {
  type GrantSiteAccessInput,
  type GrantSiteAccessOutput,
  grantSiteAccessContract,
  grantSiteAccessInputSchema,
  grantSiteAccessOutputSchema,
} from './tenancy/grant-site-access.contract.js';
