import { Module } from '@nestjs/common';
import { CollaborationModule } from '../collaboration/collaboration.module.js';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { ChangeTaskStatusController } from './features/change-task-status/change-task-status.controller.js';
import { ChangeTaskStatusHandler } from './features/change-task-status/change-task-status.handler.js';
import { CreateTaskController } from './features/create-task/create-task.controller.js';
import { CreateTaskHandler } from './features/create-task/create-task.handler.js';

@Module({
  imports: [TenancyModule, CollaborationModule],
  controllers: [CreateTaskController, ChangeTaskStatusController],
  providers: [CreateTaskHandler, ChangeTaskStatusHandler],
})
export class ProjectsModule {}
