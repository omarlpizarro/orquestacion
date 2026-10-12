import { Module } from '@nestjs/common';
import { CollaborationModule } from '../collaboration/collaboration.module.js';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { AddProjectMemberController } from './features/add-project-member/add-project-member.controller.js';
import { AddProjectMemberHandler } from './features/add-project-member/add-project-member.handler.js';
import { AddTaskCommentController } from './features/add-task-comment/add-task-comment.controller.js';
import { AddTaskCommentHandler } from './features/add-task-comment/add-task-comment.handler.js';
import { ChangeProjectVisibilityController } from './features/change-project-visibility/change-project-visibility.controller.js';
import { ChangeProjectVisibilityHandler } from './features/change-project-visibility/change-project-visibility.handler.js';
import { ChangeTaskStatusController } from './features/change-task-status/change-task-status.controller.js';
import { ChangeTaskStatusHandler } from './features/change-task-status/change-task-status.handler.js';
import { CreateProjectController } from './features/create-project/create-project.controller.js';
import { CreateProjectHandler } from './features/create-project/create-project.handler.js';
import { CreateTaskController } from './features/create-task/create-task.controller.js';
import { CreateTaskHandler } from './features/create-task/create-task.handler.js';
import { GetProjectController } from './features/get-project/get-project.controller.js';
import { GetProjectHandler } from './features/get-project/get-project.handler.js';
import { GetTaskController } from './features/get-task/get-task.controller.js';
import { GetTaskHandler } from './features/get-task/get-task.handler.js';
import { ListProjectTasksController } from './features/list-project-tasks/list-project-tasks.controller.js';
import { ListProjectTasksHandler } from './features/list-project-tasks/list-project-tasks.handler.js';
import { ListProjectsController } from './features/list-projects/list-projects.controller.js';
import { ListProjectsHandler } from './features/list-projects/list-projects.handler.js';
import { MyDayController } from './features/my-day/my-day.controller.js';
import { MyDayHandler } from './features/my-day/my-day.handler.js';
import { RemoveProjectMemberController } from './features/remove-project-member/remove-project-member.controller.js';
import { RemoveProjectMemberHandler } from './features/remove-project-member/remove-project-member.handler.js';
import { ProjectAccessService } from './project-access.service.js';

@Module({
  imports: [TenancyModule, CollaborationModule],
  controllers: [
    CreateProjectController,
    GetProjectController,
    ListProjectsController,
    GetTaskController,
    ListProjectTasksController,
    AddTaskCommentController,
    ChangeProjectVisibilityController,
    AddProjectMemberController,
    RemoveProjectMemberController,
    CreateTaskController,
    ChangeTaskStatusController,
    MyDayController,
  ],
  providers: [
    CreateProjectHandler,
    GetProjectHandler,
    ListProjectsHandler,
    GetTaskHandler,
    ListProjectTasksHandler,
    AddTaskCommentHandler,
    ChangeProjectVisibilityHandler,
    AddProjectMemberHandler,
    RemoveProjectMemberHandler,
    CreateTaskHandler,
    ChangeTaskStatusHandler,
    MyDayHandler,
    ProjectAccessService,
  ],
  exports: [ProjectAccessService],
})
export class ProjectsModule {}
