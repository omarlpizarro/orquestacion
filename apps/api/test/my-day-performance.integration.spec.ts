import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { newId } from '@orq/contracts';
import { type Db, withTenantTransaction } from '@orq/db';
import { type PostgresHarness, startPostgresHarness } from '@orq/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { localDayWindow } from '../src/modules/projects/domain/local-day-window.js';
import { buildMyDayTaskQuery } from '../src/modules/projects/infrastructure/task.repository.js';
import { AUTH } from '../src/shared/auth/auth.tokens.js';
import type { Auth } from '../src/shared/auth/build-auth.js';
import { mountBetterAuth } from '../src/shared/auth/mount-better-auth.js';
import { DB } from '../src/shared/database/database.tokens.js';
import { resolveTenantIdentity } from '../src/shared/request-context/request-context.middleware.js';
import { getDefaultSiteId } from './helpers/get-default-site-id.js';
import { signUpAndCreateOrg } from './helpers/sign-up-and-create-org.js';

const ORG_COUNT = 50;
const TASKS_PER_ORG = 500;

// Las siete industrias objetivo (CLAUDE.md §1), repartidas entre las 50 orgs.
const INDUSTRIES = [
  'gastronomia',
  'agro',
  'salud',
  'mineria',
  'energia',
  'construccion',
  'eventos',
];

// Los cuatro estados "abiertos" (todo menos done/cancelled): la consulta de
// Mi Día ya excluye los otros dos, así que sembrarlos acá no aportaría nada
// a la selectividad que el índice necesita demostrar.
const OPEN_STATUSES = ['pending', 'in_progress', 'blocked', 'in_review'];

interface PlanNode {
  'Node Type'?: string;
  'Index Name'?: string;
  'Relation Name'?: string;
  Plans?: PlanNode[];
}

/** Recorre el árbol de EXPLAIN (FORMAT JSON) buscando todos los "Index Name". */
function indexNamesInPlan(node: PlanNode): string[] {
  const own = node['Index Name'] ? [node['Index Name']] : [];
  const nested = (node.Plans ?? []).flatMap(indexNamesInPlan);
  return [...own, ...nested];
}

/** Mismo recorrido, para confirmar que ningún nodo es un Seq Scan sobre `task`. */
function seqScansOnTaskInPlan(node: PlanNode): PlanNode[] {
  const own = node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'task' ? [node] : [];
  const nested = (node.Plans ?? []).flatMap(seqScansOnTaskInPlan);
  return [...own, ...nested];
}

/**
 * Seed de volumen (docs/phase-2-brief.md, "Seed y rendimiento"): con diez
 * filas el planner de Postgres siempre prefiere un Seq Scan (es más barato
 * para una tabla chica, tenga o no índice), así que un test de EXPLAIN sin
 * volumen real no prueba nada. 50 organizaciones reales (alta vía Better
 * Auth, no sintéticas) con 500 tareas cada una — igual que create-task.integration.spec.ts,
 * las tareas se insertan directo por SQL: lo que este test ejercita es el
 * plan de lectura, no el camino de escritura.
 */
describe('Mi Día — seed de volumen y EXPLAIN (integración)', () => {
  let harness: PostgresHarness;
  let app: NestFastifyApplication;
  let auth: Auth;
  let db: Db;
  let targetOrganizationId = '';
  let targetMemberId = '';

  beforeAll(async () => {
    harness = await startPostgresHarness();
    process.env.DATABASE_URL = harness.appConnectionUri;
    process.env.DATABASE_APP_ROLE = 'app_login';
    process.env.BETTER_AUTH_SECRET = 'test_secret_'.padEnd(32, 'x');
    process.env.BETTER_AUTH_URL = 'http://localhost:3000';

    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
      logger: false,
    });
    auth = app.get<Auth>(AUTH);
    db = app.get<Db>(DB);
    mountBetterAuth(app, auth);
    await app.init();

    for (let orgIndex = 0; orgIndex < ORG_COUNT; orgIndex++) {
      const org = await signUpAndCreateOrg(app, `Volumen ${orgIndex}`);
      const tenant = await resolveTenantIdentity(auth, { cookie: org.cookie });
      if (!tenant) throw new Error('esperaba tenant resuelto tras crear la organización');

      const tenantContext = {
        organizationId: org.organizationId,
        memberId: tenant.memberId,
        requestId: newId(),
      };

      await withTenantTransaction(db, tenantContext, (tx) =>
        tx.execute(sql`
          insert into organization_profile (organization_id, industry)
          values (${org.organizationId}, ${INDUSTRIES[orgIndex % INDUSTRIES.length]})
        `),
      );

      const siteId = await getDefaultSiteId(db, {
        organizationId: org.organizationId,
        memberId: tenant.memberId,
      });
      const projectId = newId();
      await withTenantTransaction(db, tenantContext, (tx) =>
        tx.execute(sql`
          insert into project (id, organization_id, site_id, created_by_member_id, code, name)
          values (${projectId}, ${org.organizationId}, ${siteId}, ${tenant.memberId}, 'PRY-1', 'Proyecto de volumen')
        `),
      );

      const ids: string[] = [];
      const titles: string[] = [];
      const statuses: string[] = [];
      const plannedEndAts: string[] = [];
      const positions: string[] = [];
      for (let i = 0; i < TASKS_PER_ORG; i++) {
        ids.push(newId());
        titles.push(`Tarea ${i}`);
        statuses.push(OPEN_STATUSES[i % OPEN_STATUSES.length] as string);
        // Repartidas entre -15 y +15 días: mezcla de vencidas, de hoy y futuras.
        const offsetDays = (i % 31) - 15;
        plannedEndAts.push(new Date(Date.now() + offsetDays * 86_400_000).toISOString());
        positions.push(`a${String(i).padStart(6, '0')}`);
      }

      // IDs UUIDv7 generados acá, no gen_random_uuid() en el server (CLAUDE.md
      // regla dura 6) — un solo INSERT ... SELECT ... FROM unnest(...) en vez
      // de 500 sentencias, todavía dentro de la transacción con contexto de
      // tenant seteado (regla dura 3). `sql.param(array)` porque interpolar
      // un array JS crudo en un template `sql` de drizzle-orm no lo manda
      // como un solo parámetro de array de Postgres: lo expande en una
      // lista `(a, b, c, ...)` (pensada para `IN (...)`), que Postgres no
      // puede castear a `uuid[]` — verificado contra el error real
      // ("cannot cast type record to uuid[]") antes de este fix.
      // `sql.param` con el encoder por defecto (`noopEncoder`) entrega el
      // array tal cual al driver `pg`, que sí sabe serializarlo como un
      // array real de Postgres.
      await withTenantTransaction(db, tenantContext, (tx) =>
        tx.execute(sql`
          insert into task (
            id, organization_id, created_by_member_id, project_id,
            title, status, assignee_member_id, planned_end_at, position
          )
          select t.id, ${org.organizationId}, ${tenant.memberId}, ${projectId},
                 t.title, t.status, ${tenant.memberId}, t.planned_end_at, t.position
          from unnest(
            ${sql.param(ids)}::uuid[], ${sql.param(titles)}::text[],
            ${sql.param(statuses)}::text[], ${sql.param(plannedEndAts)}::timestamptz[],
            ${sql.param(positions)}::text[]
          ) as t(id, title, status, planned_end_at, position)
        `),
      );

      if (orgIndex === ORG_COUNT - 1) {
        targetOrganizationId = org.organizationId;
        targetMemberId = tenant.memberId;
      }
    }

    // Sin esto, el planner decide con las estadísticas de una tabla recién
    // creada (vacía) en vez de con los ~25.000 registros que se acaban de
    // insertar, y puede seguir eligiendo Seq Scan aunque el volumen ya esté.
    // Requiere ser dueño de la tabla (o superusuario): app_login no puede.
    await harness.ownerPool.query('ANALYZE task');
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await harness.stop();
  });

  it('usa el índice compuesto task_org_assignee_status_planned_end_idx, no un Seq Scan, con ~25.000 tareas en la tabla', async () => {
    const plan = await withTenantTransaction(
      db,
      { organizationId: targetOrganizationId, memberId: targetMemberId, requestId: newId() },
      async (tx) => {
        const dayWindow = localDayWindow(new Date(), 'America/Argentina/Buenos_Aires');
        const query = buildMyDayTaskQuery({
          organizationId: targetOrganizationId,
          assigneeMemberId: targetMemberId,
          todayStartUtc: dayWindow.startUtc,
          todayEndUtc: dayWindow.endUtc,
        });
        const result = await tx.execute<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>(
          sql`explain (format json) ${query}`,
        );
        return result.rows[0]?.['QUERY PLAN'][0]?.Plan;
      },
    );

    if (!plan) throw new Error('EXPLAIN no devolvió ningún plan');
    expect(indexNamesInPlan(plan)).toContain('task_org_assignee_status_planned_end_idx');
    expect(seqScansOnTaskInPlan(plan)).toHaveLength(0);
  });
});
