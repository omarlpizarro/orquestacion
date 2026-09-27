import { Injectable } from '@nestjs/common';
import type { MyDayOutput } from '@orq/contracts';
import { TransactionService } from '../../../../shared/database/transaction.service.js';
import { getRequestContext } from '../../../../shared/request-context/request-context.js';
import { TenancyService } from '../../../tenancy/tenancy.module.js';
import { localDayWindow } from '../../domain/local-day-window.js';
import { findMyDayTaskRows } from '../../infrastructure/task.repository.js';
import { toTaskOutput } from '../../infrastructure/task-output.mapper.js';
import type { MyDayQuery } from './my-day.query.js';

@Injectable()
export class MyDayHandler {
  constructor(
    private readonly transactions: TransactionService,
    private readonly tenancy: TenancyService,
  ) {}

  async execute(query: MyDayQuery): Promise<MyDayOutput> {
    const { tenant } = getRequestContext();
    if (!tenant) {
      throw new Error('my-day requiere una sesión con organización activa.');
    }

    const tasks = await this.transactions.withTenant(async (tx) => {
      const timeZone =
        query.time_zone ??
        (await this.tenancy.resolveTimezone(tx, {
          organizationId: tenant.organizationId,
          siteId: null,
        }));
      // Qué sección le corresponde a cada tarea y en qué orden se muestran
      // lo resuelve la consulta (infrastructure/task.repository.ts,
      // buildMyDayTaskQuery) — acá solo se resuelve la zona horaria de
      // "hoy" (docs/phase-2-brief.md, "Mi Día y zonas horarias").
      const dayWindow = localDayWindow(new Date(), timeZone);

      return findMyDayTaskRows(tx, {
        organizationId: tenant.organizationId,
        assigneeMemberId: tenant.memberId,
        todayStartUtc: dayWindow.startUtc,
        todayEndUtc: dayWindow.endUtc,
      });
    });

    return {
      tasks: tasks.map((task) => ({
        ...toTaskOutput(task),
        section: task.section,
        is_overdue: task.isOverdue,
      })),
    };
  }
}
