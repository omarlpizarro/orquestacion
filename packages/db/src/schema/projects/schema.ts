import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { ltree, standardColumns } from '../../columns.js';
import { organization } from '../auth/schema.js';
import { site } from '../tenancy/schema.js';

export const project = pgTable(
  'project',
  {
    ...standardColumns(),
    siteId: uuid('site_id'),
    sopTemplateId: uuid('sop_template_id'),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    status: text('status').notNull().default('planning'),
    startsAt: timestamp('starts_at', { withTimezone: true, mode: 'string' }),
    endsAt: timestamp('ends_at', { withTimezone: true, mode: 'string' }),
    archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'string' }),
    customFields: jsonb('custom_fields').notNull().default({}),
  },
  (table) => [
    unique().on(table.organizationId, table.code),
    unique().on(table.organizationId, table.id),
    foreignKey({
      columns: [table.organizationId],
      foreignColumns: [organization.id],
    }),
    // Compuesta hacia `site`, aparte de la directa a `organization`: cuando
    // `site_id` es null, Postgres no evalúa una FK compuesta (MATCH SIMPLE),
    // así que sin la de arriba un proyecto sin sitio quedaría con
    // `organization_id` sin validar contra nada.
    foreignKey({
      columns: [table.organizationId, table.siteId],
      foreignColumns: [site.organizationId, site.id],
    }),
    check(
      'project_status_check',
      sql`${table.status} in ('planning','active','on_hold','archived')`,
    ),
  ],
);

/**
 * `path` es `ltree`, mantenida por un trigger `BEFORE INSERT` (ver
 * `0005_projects.sql`) — nunca la escribe la aplicación. La profundidad
 * libre queda en el esquema; el límite real de tres niveles lo aplica
 * `domain/` (ADR-006), no un `CHECK` acá.
 */
export const task = pgTable(
  'task',
  {
    ...standardColumns(),
    projectId: uuid('project_id').notNull(),
    parentTaskId: uuid('parent_task_id'),
    path: ltree('path').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    status: text('status').notNull().default('pending'),
    criticality: text('criticality').notNull().default('normal'),
    assigneeMemberId: text('assignee_member_id'),
    plannedStartAt: timestamp('planned_start_at', { withTimezone: true, mode: 'string' }),
    plannedEndAt: timestamp('planned_end_at', { withTimezone: true, mode: 'string' }),
    actualStartAt: timestamp('actual_start_at', { withTimezone: true, mode: 'string' }),
    actualEndAt: timestamp('actual_end_at', { withTimezone: true, mode: 'string' }),
    isMilestone: boolean('is_milestone').notNull().default(false),
    ackRequired: boolean('ack_required').notNull().default(false),
    position: text('position').notNull(),
    customFields: jsonb('custom_fields').notNull().default({}),
  },
  (table) => [
    unique().on(table.organizationId, table.id),
    foreignKey({
      columns: [table.organizationId, table.projectId],
      foreignColumns: [project.organizationId, project.id],
    }),
    foreignKey({
      columns: [table.organizationId, table.parentTaskId],
      foreignColumns: [table.organizationId, table.id],
    }),
    index('task_path_idx').using('gist', table.path),
    index('task_org_project_position_idx').on(
      table.organizationId,
      table.projectId,
      table.position,
    ),
    check(
      'task_status_check',
      sql`${table.status} in ('pending','in_progress','blocked','in_review','done','cancelled')`,
    ),
    check(
      'task_criticality_check',
      sql`${table.criticality} in ('low','normal','high','critical')`,
    ),
    check(
      'task_dates_coherent_check',
      sql`${table.plannedEndAt} is null or ${table.plannedStartAt} is null or ${table.plannedEndAt} >= ${table.plannedStartAt}`,
    ),
  ],
);
