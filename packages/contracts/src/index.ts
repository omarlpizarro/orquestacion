import { populateContractRouterPaths } from '@orpc/contract';
import { healthContract } from './health/health.contract.js';
import { addProjectMemberContract } from './projects/add-project-member.contract.js';
import { changeProjectVisibilityContract } from './projects/change-project-visibility.contract.js';
import { changeTaskStatusContract } from './projects/change-task-status.contract.js';
import { createProjectContract } from './projects/create-project.contract.js';
import { createTaskContract } from './projects/create-task.contract.js';
import { getProjectContract } from './projects/get-project.contract.js';
import { listProjectsContract } from './projects/list-projects.contract.js';
import { myDayContract } from './projects/my-day.contract.js';
import { removeProjectMemberContract } from './projects/remove-project-member.contract.js';
import { grantSiteAccessContract } from './tenancy/grant-site-access.contract.js';

export const contract = populateContractRouterPaths({
  health: healthContract,
  tenancy: {
    grantSiteAccess: grantSiteAccessContract,
  },
  projects: {
    createProject: createProjectContract,
    getProject: getProjectContract,
    listProjects: listProjectsContract,
    changeProjectVisibility: changeProjectVisibilityContract,
    addProjectMember: addProjectMemberContract,
    removeProjectMember: removeProjectMemberContract,
    createTask: createTaskContract,
    changeTaskStatus: changeTaskStatusContract,
    myDay: myDayContract,
  },
});
export type Contract = typeof contract;

export { type HealthOutput, healthContract, healthOutputSchema } from './health/health.contract.js';
export {
  type AddProjectMemberInput,
  type AddProjectMemberOutput,
  addProjectMemberContract,
  addProjectMemberInputSchema,
  addProjectMemberOutputSchema,
} from './projects/add-project-member.contract.js';
export {
  type ChangeProjectVisibilityInput,
  changeProjectVisibilityContract,
  changeProjectVisibilityInputSchema,
} from './projects/change-project-visibility.contract.js';
export {
  type ChangeTaskStatusInput,
  changeTaskStatusContract,
  changeTaskStatusInputSchema,
} from './projects/change-task-status.contract.js';
export {
  type CreateProjectInput,
  createProjectContract,
  createProjectInputSchema,
  type ProjectOutput,
  type ProjectVisibility,
  projectAccessLevelSchema,
  projectOutputSchema,
  projectStatusSchema,
  projectVisibilitySchema,
} from './projects/create-project.contract.js';
export {
  type CreateTaskInput,
  createTaskContract,
  createTaskInputSchema,
  type TaskOutput,
  taskOutputSchema,
  taskStatusSchema,
} from './projects/create-task.contract.js';
export {
  type GetProjectInput,
  getProjectContract,
  getProjectInputSchema,
} from './projects/get-project.contract.js';
export {
  type ListProjectsInput,
  type ListProjectsOutput,
  listProjectsContract,
  listProjectsInputSchema,
  listProjectsOutputSchema,
} from './projects/list-projects.contract.js';
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
export {
  type RemoveProjectMemberInput,
  type RemoveProjectMemberOutput,
  removeProjectMemberContract,
  removeProjectMemberInputSchema,
  removeProjectMemberOutputSchema,
} from './projects/remove-project-member.contract.js';
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
