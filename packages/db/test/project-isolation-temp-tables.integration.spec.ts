import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertAuthMember, insertAuthOrganization } from '../src/testing/auth-fixtures.js';
import { type PostgresHarness, startPostgresHarness } from '../src/testing/postgres-harness.js';
import { type Tx, withTenantTransaction } from '../src/transaction.js';

/**
 * Regresión de seguridad de ADR-017: las funciones auxiliares de RLS corren con
 * BYPASSRLS, y para las relaciones Postgres busca primero en el esquema
 * temporal salvo que pg_temp figure explícito en el search_path. Una sesión de
 * la API (app_login) podría crear una tabla temporal project_member falsa y
 * hacer que la función la lea en vez de la real.
 *
 * Dos capas, y las dos se prueban:
 *   1. Los roles de la aplicación no pueden crear tablas temporales.
 *   2. Aunque pudieran (se les devuelve el permiso a propósito), las funciones
 *      no leen la tabla falsa: search_path = pg_catalog, public, pg_temp y
 *      todo calificado con su esquema.
 */
describe('tablas temporales no se interponen en las funciones auxiliares (ADR-017)', () => {
  let harness: PostgresHarness;
  const suffix = randomUUID().replaceAll('-', '');
  const orgA = `org_a_${suffix}`;
  const ownerA = `owner_${suffix}`;
  const attacker = `attacker_${suffix}`; // operator sin acceso a nada
  const siteId = randomUUID();
  const reservedProject = randomUUID();
  const reservedTask = randomUUID();

  const asAttacker = <T>(run: (tx: Tx) => Promise<T>) =>
    withTenantTransaction(
      harness.db,
      { organizationId: orgA, memberId: attacker, requestId: randomUUID() },
      run,
    );

  beforeAll(async () => {
    harness = await startPostgresHarness();
    await insertAuthOrganization(harness.ownerDb, { id: orgA });
    await insertAuthMember(harness.ownerDb, {
      organizationId: orgA,
      memberId: ownerA,
      role: 'owner',
    });
    await insertAuthMember(harness.ownerDb, {
      organizationId: orgA,
      memberId: attacker,
      role: 'operator',
    });
    await withTenantTransaction(
      harness.db,
      { organizationId: orgA, memberId: ownerA, requestId: randomUUID() },
      async (tx) => {
        await tx.execute(sql`
          insert into site (id, organization_id, name, timezone)
          values (${siteId}, ${orgA}, 'Sitio', 'America/Argentina/Buenos_Aires')
        `);
        await tx.execute(sql`
          insert into project (id, organization_id, site_id, created_by_member_id, code, name)
          values (${reservedProject}, ${orgA}, ${siteId}, ${ownerA}, 'RESERVADO', 'RESERVADO')
        `);
        await tx.execute(sql`
          insert into task (id, organization_id, created_by_member_id, project_id, title, position)
          values (${reservedTask}, ${orgA}, ${ownerA}, ${reservedProject}, 'tarea', 'a0')
        `);
      },
    );
  });

  afterAll(async () => {
    await harness.stop();
  });

  describe('capa 1: ningún rol de la aplicación crea tablas temporales', () => {
    it('app_login y app_worker reciben permission denied', async () => {
      for (const pool of [harness.appPool, harness.workerPool]) {
        await expect(pool.query('create temp table intento (id int)')).rejects.toMatchObject({
          code: '42501',
        });
      }
    });
  });

  describe('capa 2: aunque pudieran, las funciones no leen la tabla falsa', () => {
    // Se simula una defensa rota: el permiso vuelve a PUBLIC. No lo hace ningún
    // código de la aplicación; solo este test, con el superusuario del contenedor.
    beforeAll(async () => {
      await harness.superuserPool.query(
        `grant temporary on database "${harness.container.getDatabase()}" to public`,
      );
    });
    afterAll(async () => {
      await harness.superuserPool.query(
        `revoke temporary on database "${harness.container.getDatabase()}" from public`,
      );
    });

    /** Tablas falsas con exactamente las columnas que leen las funciones, y filas que le darían acceso. */
    async function shadowEverything(tx: Tx) {
      await tx.execute(sql`
        create temp table project (
          id uuid, organization_id text, site_id uuid, visibility text, deleted_at timestamptz
        ) on commit drop
      `);
      await tx.execute(sql`
        create temp table project_member (
          organization_id text, project_id uuid, member_id text, deleted_at timestamptz
        ) on commit drop
      `);
      await tx.execute(sql`
        create temp table member_site_access (
          organization_id text, member_id text, site_id uuid
        ) on commit drop
      `);
      await tx.execute(sql`
        create temp table task (
          id uuid, organization_id text, project_id uuid, assignee_member_id text,
          deleted_at timestamptz
        ) on commit drop
      `);
      // La función corre como otro rol: para que pueda leer las tablas falsas, el
      // atacante (su dueño) le da SELECT. Es lo único que le falta al ataque.
      for (const table of ['project', 'project_member', 'member_site_access', 'task']) {
        await tx.execute(sql.raw(`grant select on pg_temp.${table} to public`));
      }
      await tx.execute(sql`
        insert into pg_temp.project values (${reservedProject}, ${orgA}, ${siteId}, 'site', null)
      `);
      await tx.execute(sql`
        insert into pg_temp.project_member values (${orgA}, ${reservedProject}, ${attacker}, null)
      `);
      await tx.execute(sql`
        insert into pg_temp.member_site_access values (${orgA}, ${attacker}, ${siteId})
      `);
      await tx.execute(sql`
        insert into pg_temp.task values (${reservedTask}, ${orgA}, ${reservedProject}, ${attacker}, null)
      `);
    }

    it('control positivo: una función SIN pg_temp ni calificar SÍ lee la tabla falsa (el ataque es real)', async () => {
      // Esta función es el patrón que el manual de Postgres desaconseja, creado a
      // propósito para demostrar que el vector funciona en este mismo Postgres.
      await harness.ownerDb.execute(sql`
        create function public.zz_unqualified_control(p uuid) returns boolean
        language sql stable security definer set search_path = public, pg_catalog
        as 'select exists (select 1 from project_member where project_id = p)'
      `);
      await harness.ownerDb.execute(
        sql`grant execute on function public.zz_unqualified_control(uuid) to app_user`,
      );
      try {
        const { leaked } = await asAttacker(async (tx) => {
          await shadowEverything(tx);
          const row = (
            await tx.execute<{ leaked: boolean }>(
              sql`select public.zz_unqualified_control(${reservedProject}) as leaked`,
            )
          ).rows[0];
          return { leaked: row?.leaked };
        });
        expect(leaked).toBe(true);
      } finally {
        await harness.ownerDb.execute(sql`drop function public.zz_unqualified_control(uuid)`);
      }
    });

    it('las funciones auxiliares ignoran las tablas falsas: el proyecto reservado sigue invisible', async () => {
      const result = await asAttacker(async (tx) => {
        await shadowEverything(tx);
        const functions = (
          await tx.execute<{
            privileged: boolean;
            full: boolean;
            assigned: boolean;
          }>(sql`
            select public.app_is_privileged() as privileged,
                   public.app_has_full_project_access(${reservedProject}) as full,
                   public.app_has_assigned_project_access(${reservedProject}) as assigned
          `)
        ).rows[0];
        const fullIds = (
          await tx.execute<{ id: string }>(
            sql`select id from public.app_full_access_project_ids() as t(id)`,
          )
        ).rows;
        const assignedIds = (
          await tx.execute<{ id: string }>(
            sql`select id from public.app_assigned_task_ids() as t(id)`,
          )
        ).rows;
        // Lo que ve de verdad: las tablas reales, calificadas (sin calificar, la
        // sesión del atacante leería sus propias tablas falsas).
        const projects = (await tx.execute<{ id: string }>(sql`select id from public.project`))
          .rows;
        const tasks = (await tx.execute<{ id: string }>(sql`select id from public.task`)).rows;
        const members = (
          await tx.execute<{ id: string }>(sql`select id from public.project_member`)
        ).rows;
        return { functions, fullIds, assignedIds, projects, tasks, members };
      });

      expect(result.functions).toEqual({ privileged: false, full: false, assigned: false });
      expect(result.fullIds).toEqual([]);
      expect(result.assignedIds).toEqual([]);
      expect(result.projects).toEqual([]);
      expect(result.tasks).toEqual([]);
      expect(result.members).toEqual([]);
    });

    it('tampoco se puede escribir en el proyecto reservado con las tablas falsas puestas', async () => {
      await expect(
        asAttacker(async (tx) => {
          await shadowEverything(tx);
          await tx.execute(sql`
            insert into public.task (id, organization_id, created_by_member_id, project_id, title, position)
            values (${randomUUID()}, ${orgA}, ${attacker}, ${reservedProject}, 'colada', 'a1')
          `);
        }),
      ).rejects.toMatchObject({ cause: { code: '42501' } });
    });
  });
});
