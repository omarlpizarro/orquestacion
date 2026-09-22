import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { CreateTaskController } from './features/create-task/create-task.controller.js';
import { CreateTaskHandler } from './features/create-task/create-task.handler.js';

@Module({
  imports: [TenancyModule],
  controllers: [CreateTaskController],
  providers: [CreateTaskHandler],
})
export class ProjectsModule {}
