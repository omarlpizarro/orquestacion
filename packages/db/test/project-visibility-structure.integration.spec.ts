import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertAuthMember } from '../src/testing/auth-fixtures.js';
import { type PostgresHarness, startPostgresHarness } from '../src/testing/postgres-harness.js';
import type { Tx } from '../src/transaction.js';
import { withTenantTransaction } from '../src/transaction.js';

/**
 * ADR-017, PR de estructura (migración 0012): lo que quedó en la base sin
 * cambiar ningún comportamiento. Postgres real con `app_login`, igual que el
 * resto: casi todo lo que se verifica acá vive en constraints, triggers y
 * privilegios que un mock no ejecuta.
 */
describe('estructura de visibilidad de proyectos (0012)', () => {
  let harness: PostgresHarness;
  const orgA = `org_a_${randomUUID().replaceAll('-', '')}`;
  const orgB = `org_b_${randomUUID().replaceAll('-', '')}`;
  // Dueño de las dos organizaciones: este archivo prueba la ESTRUCTURA (0012),
  // no quién ve qué. Las policies por proyecto (0015) exigen que el miembro
  // exista en auth.member, y un owner las atraviesa todas; la matriz de
  // acceso vive en project-isolation.integration.spec.ts.
  const member = `member_${randomUUID().replaceAll('-', '')}`;
  let siteA: string;
  let projectA: string;
  let projectA2: string;
  let taskA: string;

  const asA = <T>(run: (tx: Tx) => Promise<T>) =>
    withTenantTransaction(
      harness.db,
      { organizationId: orgA, memberId: member, requestId: randomUUID() },
      run,
    );
  const asB = <T>(run: (tx: Tx) => Promise<T>) =>
    withTenantTransaction(
      harness.db,
      { organizationId: orgB, memberId: `${member}_b`, requestId: randomUUID() },
      run,
    );

  /** Los errores de `pg` viajan en `cause` (mismo patrón que tenant-isolation). */
  async function expectPgError(promise: Promise<unknown>, code: string) {
    await expect(promise).rejects.toMatchObject({ cause: { code } });
  }

  async function insertProject(
    tx: Tx,
    organizationId: string,
    siteId: string,
    code: string,
  ): Promise<string> {
    const id = randomUUID();
    await tx.execute(sql`
      insert into project (id, organization_id, site_id, created_by_member_id, code, name)
      values (${id}, ${organizationId}, ${siteId}, ${member}, ${code}, ${code})
    `);
    return id;
  }

  async function insertTask(tx: Tx, projectId: string): Promise<string> {
    const id = randomUUID();
    await tx.execute(sql`
      insert into task (id, organization_id, created_by_member_id, project_id, title, position)
      values (${id}, ${orgA}, ${member}, ${projectId}, 'tarea', ${`a${id.slice(0, 8)}`})
    `);
    return id;
  }

  beforeAll(async () => {
    harness = await startPostgresHarness();
    await harness.ownerDb.execute(sql`
      insert into auth.organization (id, name, slug, created_at) values
        (${orgA}, 'Org A', ${orgA}, now()), (${orgB}, 'Org B', ${orgB}, now())
    `);
    await insertAuthMember(harness.ownerDb, {
      organizationId: orgA,
      memberId: member,
      role: 'owner',
    });
    await insertAuthMember(harness.ownerDb, {
      organizationId: orgB,
      memberId: `${member}_b`,
      role: 'owner',
    });
    siteA = randomUUID();
    await asA((tx) =>
      tx.execute(sql`
        insert into site (id, organization_id, name, timezone)
        values (${siteA}, ${orgA}, 'Sitio A', 'America/Argentina/Buenos_Aires')
      `),
    );
    projectA = await asA((tx) => insertProject(tx, orgA, siteA, 'PRY-A'));
    projectA2 = await asA((tx) => insertProject(tx, orgA, siteA, 'PRY-A2'));
    taskA = await asA((tx) => insertTask(tx, projectA));
  });

  afterAll(async () => {
    await harness.stop();
  });

  describe('project.visibility', () => {
    it('un proyecto nuevo es reservado por defecto, aunque el INSERT no hable de visibilidad', async () => {
      const result = await asA((tx) =>
        tx.execute<{ visibility: string }>(
          sql`select visibility from project where id = ${projectA}`,
        ),
      );
      expect(result.rows[0]?.visibility).toBe('reserved');
    });

    it('rechaza un valor fuera de reserved|site: el CHECK NOT VALID rige para toda fila nueva', async () => {
      await expectPgError(
        asA((tx) =>
          tx.execute(sql`update project set visibility = 'secreto' where id = ${projectA}`),
        ),
        '23514',
      );
    });

    it('acepta site', async () => {
      await asA((tx) =>
        tx.execute(sql`update project set visibility = 'site' where id = ${projectA2}`),
      );
      const result = await asA((tx) =>
        tx.execute<{ visibility: string }>(
          sql`select visibility from project where id = ${projectA2}`,
        ),
      );
      expect(result.rows[0]?.visibility).toBe('site');
    });
  });

  describe('project_member', () => {
    async function addMember(tx: Tx, projectId: string, memberId: string): Promise<string> {
      const id = randomUUID();
      await tx.execute(sql`
        insert into project_member (id, organization_id, created_by_member_id, project_id, member_id)
        values (${id}, ${orgA}, ${member}, ${projectId}, ${memberId})
      `);
      return id;
    }

    it('no permite dos filas activas del mismo miembro en un proyecto', async () => {
      await asA((tx) => addMember(tx, projectA, 'm_dup'));
      await expectPgError(
        asA((tx) => addMember(tx, projectA, 'm_dup')),
        '23505',
      );
    });

    it('quitar es deleted_at, y con la fila quitada se puede volver a agregar', async () => {
      const first = await asA((tx) => addMember(tx, projectA, 'm_rejoin'));
      await asA((tx) =>
        tx.execute(sql`update project_member set deleted_at = now() where id = ${first}`),
      );
      const second = await asA((tx) => addMember(tx, projectA, 'm_rejoin'));
      expect(second).not.toBe(first);
    });

    it('la FK compuesta rechaza un proyecto inexistente en la organización', async () => {
      await expectPgError(
        asA((tx) => addMember(tx, randomUUID(), 'm_fantasma')),
        '23503',
      );
    });

    it('no ve las filas de otra organización (RLS) y no puede escribir en ella', async () => {
      const seen = await asB((tx) => tx.execute(sql`select id from project_member`));
      expect(seen.rows).toEqual([]);
      await expectPgError(
        asB((tx) =>
          tx.execute(sql`
            insert into project_member (id, organization_id, created_by_member_id, project_id, member_id)
            values (${randomUUID()}, ${orgA}, ${member}, ${projectA}, 'colado')
          `),
        ),
        '42501',
      );
    });
  });

  describe('task_update.project_id', () => {
    async function insertUpdate(tx: Tx, taskId: string, projectId: string | null) {
      const id = randomUUID();
      await tx.execute(sql`
        insert into task_update (id, organization_id, created_by_member_id, task_id, project_id, kind)
        values (${id}, ${orgA}, ${member}, ${taskId}, ${projectId}, 'comment')
      `);
      return id;
    }
    const projectOf = async (updateId: string) =>
      (
        await asA((tx) =>
          tx.execute<{ project_id: string | null }>(
            sql`select project_id from task_update where id = ${updateId}`,
          ),
        )
      ).rows[0]?.project_id;

    it('un INSERT que no trae project_id (el código anterior) recibe el de la tarea', async () => {
      const id = await asA((tx) => insertUpdate(tx, taskA, null));
      expect(await projectOf(id)).toBe(projectA);
    });

    it('un INSERT con el project_id correcto lo conserva', async () => {
      const id = await asA((tx) => insertUpdate(tx, taskA, projectA));
      expect(await projectOf(id)).toBe(projectA);
    });

    it('la FK compuesta rechaza un project_id que no es el de la tarea', async () => {
      await expectPgError(
        asA((tx) => insertUpdate(tx, taskA, projectA2)),
        '23503',
      );
    });
  });

  describe('project_id inmutable una vez fijado', () => {
    it('task: cambiarlo falla con integrity_constraint_violation', async () => {
      await expectPgError(
        asA((tx) => tx.execute(sql`update task set project_id = ${projectA2} where id = ${taskA}`)),
        '23000',
      );
    });

    it('task_update: cambiarlo falla', async () => {
      const id = randomUUID();
      await asA((tx) =>
        tx.execute(sql`
          insert into task_update (id, organization_id, created_by_member_id, task_id, kind)
          values (${id}, ${orgA}, ${member}, ${taskA}, 'comment')
        `),
      );
      await expectPgError(
        asA((tx) =>
          tx.execute(sql`update task_update set project_id = ${projectA2} where id = ${id}`),
        ),
        '23000',
      );
    });

    it('project_member: cambiarlo falla', async () => {
      const id = randomUUID();
      await asA((tx) =>
        tx.execute(sql`
          insert into project_member (id, organization_id, created_by_member_id, project_id, member_id)
          values (${id}, ${orgA}, ${member}, ${projectA}, 'm_inmutable')
        `),
      );
      await expectPgError(
        asA((tx) =>
          tx.execute(sql`update project_member set project_id = ${projectA2} where id = ${id}`),
        ),
        '23000',
      );
    });

    it('también vale para el dueño del esquema (el trigger no distingue roles)', async () => {
      // El dueño también está sujeto a RLS (FORCE), y desde 0015 las policies por
      // proyecto llaman funciones a las que app_owner no tiene EXECUTE (solo
      // app_user, ADR-017 §4). Se baja FORCE dentro de la transacción de la
      // prueba —el error esperado la deshace— para que el UPDATE llegue al
      // trigger, que es lo que se quiere ver.
      await expectPgError(
        harness.ownerDb.transaction(async (tx) => {
          await tx.execute(sql`alter table task no force row level security`);
          await tx.execute(sql`update task set project_id = ${projectA2} where id = ${taskA}`);
        }),
        '23000',
      );
    });

    it('actualizar otras columnas de la tarea sigue andando', async () => {
      await asA((tx) => tx.execute(sql`update task set title = 'otro título' where id = ${taskA}`));
    });
  });

  describe('audit_log', () => {
    type AuditRow = {
      entity_type: string;
      action: string;
      actor_member_id: string | null;
      actor_kind: string;
      project_id: string | null;
      request_id: string | null;
      changed: Record<string, unknown>;
    };
    const auditOf = (entityId: string) =>
      asA((tx) =>
        tx.execute<AuditRow>(sql`
          select entity_type, action, actor_member_id, actor_kind, project_id, request_id, changed
          from audit_log where entity_id = ${entityId} order by id
        `),
      ).then((result) => result.rows);

    it('crear un proyecto deja una entrada con el actor, el proyecto y el request', async () => {
      const entries = await auditOf(projectA);
      expect(entries[0]).toMatchObject({
        entity_type: 'project',
        action: 'insert',
        actor_member_id: member,
        actor_kind: 'member',
        project_id: projectA,
      });
      expect(entries[0]?.request_id).toBeTruthy();
    });

    it('pasar de reserved a site queda registrado con el valor anterior y el nuevo', async () => {
      const id = await asA((tx) => insertProject(tx, orgA, siteA, 'PRY-VIS'));
      await asA((tx) => tx.execute(sql`update project set visibility = 'site' where id = ${id}`));

      const entries = await auditOf(id);
      const change = entries.find((entry) => entry.action === 'update');
      expect(change?.changed).toEqual({ visibility: ['reserved', 'site'] });
      expect(change?.actor_member_id).toBe(member);
    });

    it('un UPDATE que no cambia ningún dato (solo version/updated_at) no genera entrada', async () => {
      const id = await asA((tx) => insertProject(tx, orgA, siteA, 'PRY-NOOP'));
      await asA((tx) => tx.execute(sql`update project set name = name where id = ${id}`));

      expect((await auditOf(id)).map((entry) => entry.action)).toEqual(['insert']);
    });

    it('agregar un miembro al proyecto registra project_member con su project_id', async () => {
      const id = randomUUID();
      await asA((tx) =>
        tx.execute(sql`
          insert into project_member (id, organization_id, created_by_member_id, project_id, member_id)
          values (${id}, ${orgA}, ${member}, ${projectA}, 'm_auditado')
        `),
      );
      const entries = await auditOf(id);
      expect(entries[0]).toMatchObject({
        entity_type: 'project_member',
        action: 'insert',
        project_id: projectA,
      });
    });

    it('un cambio sin contexto de miembro queda con actor nulo y actor_kind system', async () => {
      const id = await withTenantTransaction(
        harness.db,
        { organizationId: orgA, memberId: '', requestId: 'system:prueba' },
        (tx) => insertProject(tx, orgA, siteA, 'PRY-SISTEMA'),
      );
      const entries = await auditOf(id);
      expect(entries[0]).toMatchObject({
        actor_member_id: null,
        actor_kind: 'system',
        request_id: 'system:prueba',
      });
    });

    it('otra organización no ve las entradas de esta', async () => {
      const seen = await asB((tx) => tx.execute(sql`select id from audit_log`));
      expect(seen.rows).toEqual([]);
    });

    it('es inmutable: ni UPDATE ni DELETE, ni por el padre ni por una partición', async () => {
      const partition = await currentMonthPartition();
      for (const target of ['audit_log', partition]) {
        await expectPgError(
          asA((tx) => tx.execute(sql.raw(`update ${target} set action = 'delete'`))),
          '42501',
        );
        await expectPgError(
          asA((tx) => tx.execute(sql.raw(`delete from ${target}`))),
          '42501',
        );
      }
    });

    it('leer una partición por su nombre tampoco salta el aislamiento entre organizaciones', async () => {
      const partition = await currentMonthPartition();
      const asOrgA = await asA((tx) => tx.execute(sql.raw(`select id from ${partition}`)));
      const asOrgB = await asB((tx) => tx.execute(sql.raw(`select id from ${partition}`)));
      expect(asOrgA.rows.length).toBeGreaterThan(0);
      expect(asOrgB.rows).toEqual([]);
    });
  });

  /** El dueño también está sujeto a RLS: se cuenta org por org, como app_login. */
  async function rowsInDefaultPartition(): Promise<number> {
    let total = 0;
    for (const organizationId of [orgA, orgB]) {
      const result = await withTenantTransaction(
        harness.db,
        { organizationId, memberId: member, requestId: randomUUID() },
        (tx) =>
          tx.execute<{ count: string }>(sql`select count(*)::text as count from audit_log_default`),
      );
      total += Number(result.rows[0]?.count);
    }
    return total;
  }

  async function currentMonthPartition(): Promise<string> {
    const result = await harness.ownerDb.execute<{ name: string }>(sql`
      select 'audit_log_' || to_char((now() at time zone 'UTC')::date, 'YYYY_MM') as name
    `);
    return result.rows[0]?.name ?? '';
  }

  describe('particiones de audit_log', () => {
    it('hay una por cada uno de los 13 meses (el actual y los 12 siguientes) más la DEFAULT', async () => {
      const result = await harness.ownerDb.execute<{ name: string }>(sql`
        select c.relname as name
        from pg_inherits i
        join pg_class c on c.oid = i.inhrelid
        where i.inhparent = 'audit_log'::regclass
      `);
      const names = result.rows.map((row) => row.name);
      expect(names).toHaveLength(14);
      expect(names).toContain('audit_log_default');

      const expected = await harness.ownerDb.execute<{ name: string }>(sql`
        select 'audit_log_' || to_char(
          (date_trunc('month', now() at time zone 'UTC') + make_interval(months => g))::date, 'YYYY_MM'
        ) as name
        from generate_series(0, 12) g
      `);
      for (const row of expected.rows) expect(names).toContain(row.name);
    });

    it('los límites son meses calendario en UTC', async () => {
      const result = await harness.ownerDb.execute<{ lower: string; upper: string }>(sql`
        select pg_get_expr(c.relpartbound, c.oid) as bound
        from pg_class c
        where c.relname = ${await currentMonthPartition()}
      `);
      expect(String(result.rows[0]?.['bound'])).toMatch(/00:00:00\+00/);
    });

    it('la DEFAULT no recibió ninguna fila: todo lo escrito por los tests cae en su mes', async () => {
      expect(await rowsInDefaultPartition()).toBe(0);
    });

    it('padre y particiones tienen RLS habilitada y forzada', async () => {
      const result = await harness.ownerDb.execute<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(sql`
        select c.relname, c.relrowsecurity, c.relforcerowsecurity
        from pg_class c
        where c.relkind in ('r', 'p')
          and (c.relname = 'audit_log' or c.relname like 'audit_log\_%')
      `);
      expect(result.rows.length).toBe(15);
      for (const row of result.rows) {
        expect(row, row.relname).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
      }
    });

    it('app_login no puede ejecutar app_ensure_audit_partitions (solo el dueño)', async () => {
      await expectPgError(
        asA((tx) => tx.execute(sql`select app_ensure_audit_partitions(current_date, 1)`)),
        '42501',
      );
    });

    it('es idempotente', async () => {
      await harness.ownerDb.execute(sql`select app_ensure_audit_partitions(current_date, 13)`);
      const result = await harness.ownerDb.execute<{ count: string }>(sql`
        select count(*)::text as count from pg_inherits where inhparent = 'audit_log'::regclass
      `);
      expect(Number(result.rows[0]?.count)).toBe(14);
    });

    it('verificado: no se puede crear la partición de un mes si la DEFAULT ya tiene filas de ese mes', async () => {
      // Lo que el job del paso 8 tiene que contemplar (docs/phase-2-brief.md).
      await asA((tx) =>
        tx.execute(sql`
          insert into audit_log (organization_id, entity_type, entity_id, action, changed, created_at)
          values (${orgA}, 'project', ${randomUUID()}, 'insert', '{}', '2099-03-15T00:00:00Z')
        `),
      );
      expect(await rowsInDefaultPartition()).toBe(1);

      await expect(
        harness.ownerDb.execute(sql`select app_ensure_audit_partitions('2099-03-01', 1)`),
      ).rejects.toMatchObject({ cause: { code: '23514' } });
    });
  });

  describe('roles nuevos (ADR-017)', () => {
    type RoleRow = {
      rolname: string;
      rolcanlogin: boolean;
      rolbypassrls: boolean;
      rolsuper: boolean;
    };
    const roles = () =>
      harness.ownerDb
        .execute<RoleRow>(
          sql`select rolname, rolcanlogin, rolbypassrls, rolsuper from pg_roles
              where rolname in ('app_worker', 'app_rls_helper')`,
        )
        .then((result) => Object.fromEntries(result.rows.map((row) => [row.rolname, row])));

    it('app_worker puede conectarse, sin superusuario ni BYPASSRLS, y hereda los permisos de app_user', async () => {
      const byName = await roles();
      expect(byName.app_worker).toMatchObject({
        rolcanlogin: true,
        rolbypassrls: false,
        rolsuper: false,
      });
      const member = await harness.ownerDb.execute<{ ok: boolean }>(
        sql`select pg_has_role('app_worker', 'app_user', 'member') as ok`,
      );
      expect(member.rows[0]?.ok).toBe(true);
    });

    it('app_rls_helper es NOLOGIN con BYPASSRLS y no tiene membresías en ningún sentido', async () => {
      const byName = await roles();
      expect(byName.app_rls_helper).toMatchObject({
        rolcanlogin: false,
        rolbypassrls: true,
        rolsuper: false,
      });
      const links = await harness.ownerDb.execute<{ count: string }>(sql`
        select count(*)::text as count from pg_auth_members m
        join pg_roles r on r.oid = m.roleid or r.oid = m.member
        where r.rolname = 'app_rls_helper'
      `);
      expect(Number(links.rows[0]?.count)).toBe(0);
    });

    it('ningún otro rol que no sea superusuario tiene BYPASSRLS', async () => {
      const result = await harness.ownerDb.execute<{ rolname: string }>(sql`
        select rolname from pg_roles
        where rolbypassrls and not rolsuper and rolname !~ '^pg_'
      `);
      expect(result.rows.map((row) => row.rolname)).toEqual(['app_rls_helper']);
    });
  });
});
