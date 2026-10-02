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
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { ltree, standardColumns } from '../../columns.js';
import { organization } from '../auth/schema.js';
import { site } from '../tenancy/schema.js';

export const project = pgTable(
  'project',
  {
    ...standardColumns(),
    siteId: uuid('site_id').notNull(),
    sopTemplateId: uuid('sop_template_id'),
    /**
     * ADR-017: los proyectos son reservados por defecto. Los que ya existían
     * al agregar la columna quedaron en `site` (ver `0012`) para no cambiar lo
     * que ven hoy; nada lee esta columna hasta el PR de comportamiento.
     */
    visibility: text('visibility').notNull().default('reserved'),
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
    // Compuesta hacia `site`: valida que `site_id` pertenezca a la misma
    // organización que `project.organization_id`, no solo que exista. Desde
    // ADR-013 `site_id` es `NOT NULL`, así que esta FK compuesta ya alcanza
    // para validar `organization_id` transitivamente (mismo patrón que
    // `task`, que tampoco tiene FK directa a `organization`) — la FK directa
    // de arriba quedó redundante, no se saca en esta migración para no medir
    // ese cambio junto con el de `site_id`, ver docs/adr/013-project-site-id-obligatorio.md.
    foreignKey({
      columns: [table.organizationId, table.siteId],
      foreignColumns: [site.organizationId, site.id],
    }),
    check(
      'project_status_check',
      sql`${table.status} in ('planning','active','on_hold','archived')`,
    ),
    check('project_visibility_check', sql`${table.visibility} in ('reserved','site')`),
  ],
);

/**
 * ADR-017: miembros explícitos de un proyecto. Sin rol (ADR-015): el rol sale
 * siempre de la organización. Quitar a alguien es `deleted_at`, nunca un
 * borrado físico (regla dura 9). `project_id` es inmutable una vez fijado
 * (`app_apply_project_immutability()`).
 */
export const projectMember = pgTable(
  'project_member',
  {
    ...standardColumns(),
    projectId: uuid('project_id').notNull(),
    memberId: text('member_id').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.projectId],
      foreignColumns: [project.organizationId, project.id],
    }),
    // Un miembro activo por proyecto; con `deleted_at` se puede volver a agregar.
    uniqueIndex('project_member_org_project_member_active_uidx')
      .on(table.organizationId, table.projectId, table.memberId)
      .where(sql`${table.deletedAt} is null`),
    // "En qué proyectos participa este miembro": sirve a las funciones de RLS
    // del PR de comportamiento.
    index('project_member_org_member_project_idx')
      .on(table.organizationId, table.memberId, table.projectId)
      .where(sql`${table.deletedAt} is null`),
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
    // ADR-017: blanco de la FK compuesta de las tablas hijas que copian
    // `project_id`, para que la copia no pueda diverger del proyecto de la tarea.
    unique().on(table.organizationId, table.id, table.projectId),
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
    // Vista "Mi Día" (docs/data-model.md, "Índices, rendimiento y
    // crecimiento"): parcial porque una tarea borrada nunca entra a esa
    // consulta, y así el índice no carga con filas que jamás se leen por
    // este camino.
    index('task_org_assignee_status_planned_end_idx')
      .on(table.organizationId, table.assigneeMemberId, table.status, table.plannedEndAt)
      .where(sql`${table.deletedAt} is null`),
    // findLastSiblingPosition (create-task, PR 1): faltaba desde ese PR, se
    // agrega acá para no generar una migración que solo agrega un índice
    // (docs/phase-2-brief.md).
    index('task_org_project_parent_idx').on(
      table.organizationId,
      table.projectId,
      table.parentTaskId,
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
