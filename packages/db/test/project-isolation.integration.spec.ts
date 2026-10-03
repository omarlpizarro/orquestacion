import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertAuthMember, insertAuthOrganization } from '../src/testing/auth-fixtures.js';
import { type PostgresHarness, startPostgresHarness } from '../src/testing/postgres-harness.js';
import { type Tx, withTenantTransaction } from '../src/transaction.js';

/**
 * ADR-017, PR de comportamiento (migración 0015): quién ve y quién puede
 * escribir qué, impuesto por la base. Postgres real con `app_login`; casi todo
 * lo que se verifica vive en policies y funciones que un mock no ejecuta.
 *
 * Siete actores en la misma organización y el mismo sitio, sobre un proyecto
 * reservado (R) y uno abierto al sitio (S).
 */
describe('aislamiento por proyecto (ADR-017)', () => {
  let harness: PostgresHarness;
  const suffix = randomUUID().replaceAll('-', '');
  const orgA = `org_a_${suffix}`;
  const orgB = `org_b_${suffix}`;

  type ActorName =
    | 'owner'
    | 'director'
    | 'creator'
    | 'explicit'
    | 'assigned'
    | 'siteManager'
    | 'outsider';
  const roles: Record<ActorName, string> = {
    owner: 'owner',
    director: 'director',
    creator: 'manager',
    explicit: 'operator',
    assigned: 'operator',
    siteManager: 'manager',
    outsider: 'operator',
  };
  const memberId = (actor: ActorName) => `${actor}_${suffix}`;

  let siteId: string;
  let projectR: string;
  let projectS: string;
  let taskAssigned: string;
  let taskUnassigned: string;
  let taskOfExplicit: string;
  let taskInS: string;
  let updateOnAssigned: string;
  let updateOnUnassigned: string;

  const as = <T>(actor: ActorName, run: (tx: Tx) => Promise<T>, organizationId = orgA) =>
    withTenantTransaction(
      harness.db,
      { organizationId, memberId: memberId(actor), requestId: randomUUID() },
      run,
    );

  const ids = async (actor: ActorName, query: ReturnType<typeof sql>) => {
    const result = await as(actor, (tx) => tx.execute<{ id: string }>(query));
    return result.rows.map((row) => row.id).sort();
  };
  const sorted = (...values: string[]) => [...values].sort();

  async function expectPgError(promise: Promise<unknown>, code: string) {
    await expect(promise).rejects.toMatchObject({ cause: { code } });
  }

  async function insertTask(
    tx: Tx,
    params: { projectId: string; assignee: ActorName | null; by: ActorName },
  ): Promise<string> {
    const id = randomUUID();
    await tx.execute(sql`
      insert into task (id, organization_id, created_by_member_id, project_id, title, position,
                        assignee_member_id)
      values (${id}, ${orgA}, ${memberId(params.by)}, ${params.projectId}, 'tarea',
              ${`a${id.slice(0, 8)}`}, ${params.assignee ? memberId(params.assignee) : null})
    `);
    return id;
  }

  async function insertTaskUpdate(tx: Tx, taskId: string, by: ActorName): Promise<string> {
    const id = randomUUID();
    await tx.execute(sql`
      insert into task_update (id, organization_id, created_by_member_id, task_id, kind, body)
      values (${id}, ${orgA}, ${memberId(by)}, ${taskId}, 'comment', 'novedad')
    `);
    return id;
  }

  beforeAll(async () => {
    harness = await startPostgresHarness();
    await insertAuthOrganization(harness.ownerDb, { id: orgA });
    await insertAuthOrganization(harness.ownerDb, { id: orgB });
    for (const actor of Object.keys(roles) as ActorName[]) {
      await insertAuthMember(harness.ownerDb, {
        organizationId: orgA,
        memberId: memberId(actor),
        role: roles[actor],
      });
    }
    await insertAuthMember(harness.ownerDb, {
      organizationId: orgB,
      memberId: `ownerb_${suffix}`,
      role: 'owner',
    });

    siteId = randomUUID();
    await as('owner', async (tx) => {
      await tx.execute(sql`
        insert into site (id, organization_id, name, timezone)
        values (${siteId}, ${orgA}, 'Sitio A', 'America/Argentina/Buenos_Aires')
      `);
      // Solo el manager del sitio trabaja en él. El creador y el miembro explícito
      // NO (un miembro explícito actúa según su rol aunque no tenga el sitio,
      // ADR-017 §8), ni el asignado ni el ajeno.
      await tx.execute(sql`
        insert into member_site_access (organization_id, member_id, site_id)
        values (${orgA}, ${memberId('siteManager')}, ${siteId})
      `);
    });

    projectR = randomUUID();
    projectS = randomUUID();
    await as('owner', async (tx) => {
      for (const [id, code, visibility] of [
        [projectR, 'PRY-R', 'reserved'],
        [projectS, 'PRY-S', 'site'],
      ] as const) {
        await tx.execute(sql`
          insert into project (id, organization_id, site_id, created_by_member_id, code, name, visibility)
          values (${id}, ${orgA}, ${siteId}, ${memberId('creator')}, ${code}, ${code}, ${visibility})
        `);
      }
      for (const actor of ['creator', 'explicit'] as const) {
        await tx.execute(sql`
          insert into project_member (id, organization_id, created_by_member_id, project_id, member_id)
          values (${randomUUID()}, ${orgA}, ${memberId('owner')}, ${projectR}, ${memberId(actor)})
        `);
      }
      taskAssigned = await insertTask(tx, {
        projectId: projectR,
        assignee: 'assigned',
        by: 'owner',
      });
      taskUnassigned = await insertTask(tx, { projectId: projectR, assignee: null, by: 'owner' });
      taskOfExplicit = await insertTask(tx, {
        projectId: projectR,
        assignee: 'explicit',
        by: 'owner',
      });
      taskInS = await insertTask(tx, { projectId: projectS, assignee: null, by: 'owner' });
      updateOnAssigned = await insertTaskUpdate(tx, taskAssigned, 'owner');
      updateOnUnassigned = await insertTaskUpdate(tx, taskUnassigned, 'owner');
    });
  });

  afterAll(async () => {
    await harness.stop();
  });

  describe('qué ve cada actor', () => {
    const projectsQuery = sql`select id from project`;
    const tasksQuery = sql`select id from task`;
    const updatesQuery = sql`select id from task_update`;
    const membersQuery = sql`select id from project_member`;

    it('owner y director ven todo, sin ser miembros ni tener fila de sitio', async () => {
      for (const actor of ['owner', 'director'] as const) {
        expect(await ids(actor, projectsQuery)).toEqual(sorted(projectR, projectS));
        expect(await ids(actor, tasksQuery)).toEqual(
          sorted(taskAssigned, taskUnassigned, taskOfExplicit, taskInS),
        );
        expect(await ids(actor, updatesQuery)).toEqual(
          sorted(updateOnAssigned, updateOnUnassigned),
        );
      }
    });

    it('el creador (miembro explícito) ve el reservado completo, sin acceso al sitio', async () => {
      expect(await ids('creator', projectsQuery)).toEqual([projectR]);
      expect(await ids('creator', tasksQuery)).toEqual(
        sorted(taskAssigned, taskUnassigned, taskOfExplicit),
      );
      expect(await ids('creator', membersQuery)).toHaveLength(2);
    });

    it('un miembro explícito actúa según su rol aunque no tenga el sitio (y es operator)', async () => {
      expect(await ids('explicit', projectsQuery)).toEqual([projectR]);
      expect(await ids('explicit', tasksQuery)).toEqual(
        sorted(taskAssigned, taskUnassigned, taskOfExplicit),
      );
    });

    it('el asignado que no es miembro ve el proyecto y SOLO su tarea, con sus novedades', async () => {
      expect(await ids('assigned', projectsQuery)).toEqual([projectR]);
      expect(await ids('assigned', tasksQuery)).toEqual([taskAssigned]);
      expect(await ids('assigned', updatesQuery)).toEqual([updateOnAssigned]);
    });

    it('el asignado no ve quién más participa del proyecto', async () => {
      expect(await ids('assigned', membersQuery)).toEqual([]);
    });

    it('el manager del mismo sitio, sin ser miembro, ve el abierto y no el reservado', async () => {
      expect(await ids('siteManager', projectsQuery)).toEqual([projectS]);
      expect(await ids('siteManager', tasksQuery)).toEqual([taskInS]);
      expect(await ids('siteManager', updatesQuery)).toEqual([]);
    });

    it('un operator ajeno no ve nada, y no distingue "no existe" de "no lo veo"', async () => {
      expect(await ids('outsider', projectsQuery)).toEqual([]);
      expect(await ids('outsider', tasksQuery)).toEqual([]);
      expect(await ids('outsider', updatesQuery)).toEqual([]);
      const byId = await ids('outsider', sql`select id from project where id = ${projectR}`);
      const missing = await ids('outsider', sql`select id from project where id = ${randomUUID()}`);
      expect(byId).toEqual(missing);
    });

    it('la bitácora la ven privilegiados y quien tiene acceso completo, no el asignado', async () => {
      const audit = sql`select entity_id as id from audit_log where entity_type = 'project'`;
      expect(await ids('owner', audit)).toEqual(sorted(projectR, projectS));
      expect(await ids('creator', audit)).toEqual([projectR]);
      expect(await ids('siteManager', audit)).toEqual([projectS]);
      expect(await ids('assigned', audit)).toEqual([]);
      expect(await ids('outsider', audit)).toEqual([]);
    });

    it('otra organización no ve nada de esta, ni siquiera siendo owner', async () => {
      const result = await withTenantTransaction(
        harness.db,
        { organizationId: orgB, memberId: `ownerb_${suffix}`, requestId: randomUUID() },
        (tx) => tx.execute<{ id: string }>(sql`select id from project`),
      );
      expect(result.rows).toEqual([]);
    });
  });

  describe('qué puede escribir cada actor', () => {
    it('el asignado modifica su tarea y no la ajena (la fila no existe para él)', async () => {
      const own = await as('assigned', (tx) =>
        tx.execute(sql`update task set title = 'propia' where id = ${taskAssigned} returning id`),
      );
      expect(own.rows).toHaveLength(1);
      const other = await as('assigned', (tx) =>
        tx.execute(sql`update task set title = 'ajena' where id = ${taskUnassigned} returning id`),
      );
      expect(other.rows).toHaveLength(0);
    });

    it('el asignado no inserta tareas en un proyecto que ve solo por asignación', async () => {
      await expectPgError(
        as('assigned', (tx) =>
          insertTask(tx, { projectId: projectR, assignee: null, by: 'assigned' }),
        ),
        '42501',
      );
    });

    it('el asignado escribe novedades en su tarea y no en la de otro', async () => {
      await as('assigned', (tx) => insertTaskUpdate(tx, taskAssigned, 'assigned'));
      await expectPgError(
        as('assigned', (tx) => insertTaskUpdate(tx, taskUnassigned, 'assigned')),
        '42501',
      );
    });

    it('el miembro explícito inserta tareas en el reservado; el manager del sitio, no', async () => {
      await as('explicit', (tx) =>
        insertTask(tx, { projectId: projectR, assignee: null, by: 'explicit' }),
      );
      await expectPgError(
        as('siteManager', (tx) =>
          insertTask(tx, { projectId: projectR, assignee: null, by: 'siteManager' }),
        ),
        '42501',
      );
    });

    it('el manager del sitio inserta en el proyecto abierto', async () => {
      await as('siteManager', (tx) =>
        insertTask(tx, { projectId: projectS, assignee: null, by: 'siteManager' }),
      );
    });

    it('un operator ajeno no inserta ni modifica nada', async () => {
      await expectPgError(
        as('outsider', (tx) =>
          insertTask(tx, { projectId: projectS, assignee: null, by: 'outsider' }),
        ),
        '42501',
      );
      const changed = await as('outsider', (tx) =>
        tx.execute(sql`update task set title = 'x' returning id`),
      );
      expect(changed.rows).toHaveLength(0);
      const deleted = await as('outsider', (tx) =>
        tx.execute(sql`delete from task_update returning id`),
      );
      expect(deleted.rows).toHaveLength(0);
    });

    it('nadie fuera del proyecto agrega miembros; el asignado tampoco', async () => {
      for (const actor of ['assigned', 'siteManager', 'outsider'] as const) {
        await expectPgError(
          as(actor, (tx) =>
            tx.execute(sql`
              insert into project_member (id, organization_id, created_by_member_id, project_id, member_id)
              values (${randomUUID()}, ${orgA}, ${memberId(actor)}, ${projectR}, ${memberId(actor)})
            `),
          ),
          '42501',
        );
      }
    });
  });

  describe('cambios de acceso', () => {
    it('desasignar le quita al asignado el acceso al proyecto, sin acordarse de nada más', async () => {
      const task = await as('owner', (tx) =>
        insertTask(tx, { projectId: projectR, assignee: 'outsider', by: 'owner' }),
      );
      expect(await ids('outsider', sql`select id from project`)).toEqual([projectR]);
      await as('owner', (tx) =>
        tx.execute(sql`update task set assignee_member_id = null where id = ${task}`),
      );
      expect(await ids('outsider', sql`select id from project`)).toEqual([]);
    });

    it('una tarea terminada o cancelada sigue dando acceso por asignación', async () => {
      const task = await as('owner', (tx) =>
        insertTask(tx, { projectId: projectR, assignee: 'outsider', by: 'owner' }),
      );
      await as('owner', (tx) =>
        tx.execute(sql`update task set status = 'cancelled' where id = ${task}`),
      );
      expect(await ids('outsider', sql`select id from project`)).toEqual([projectR]);
      await as('owner', (tx) =>
        tx.execute(sql`update task set deleted_at = now() where id = ${task}`),
      );
      expect(await ids('outsider', sql`select id from project`)).toEqual([]);
    });

    it('quitar a un miembro explícito le quita el acceso completo; le queda lo asignado', async () => {
      await as('owner', (tx) =>
        tx.execute(sql`
          update project_member set deleted_at = now()
           where project_id = ${projectR} and member_id = ${memberId('explicit')}
        `),
      );
      // `explicit` sigue teniendo asignada `taskOfExplicit`: solo esa.
      expect(await ids('explicit', sql`select id from task`)).toEqual([taskOfExplicit]);
      expect(await ids('explicit', sql`select id from project_member`)).toEqual([]);
    });

    it('pasar de reservado a abierto al sitio le da el proyecto al manager del sitio', async () => {
      expect(await ids('siteManager', sql`select id from project`)).toEqual([projectS]);
      await as('owner', (tx) =>
        tx.execute(sql`update project set visibility = 'site' where id = ${projectR}`),
      );
      expect(await ids('siteManager', sql`select id from project`)).toEqual(
        sorted(projectR, projectS),
      );
      await as('owner', (tx) =>
        tx.execute(sql`update project set visibility = 'reserved' where id = ${projectR}`),
      );
      expect(await ids('siteManager', sql`select id from project`)).toEqual([projectS]);
    });
  });

  describe('cobertura del catálogo', () => {
    // Una tabla nueva con `project_id` sin fixture registrada acá hace fallar
    // este test: es lo que obliga a escribir su caso de aislamiento.
    const tablesWithFixture = ['audit_log', 'project_member', 'task', 'task_update'];

    it('toda tabla con project_id tiene fixture y policies restrictivas por proyecto', async () => {
      const result = await harness.ownerDb.execute<{ table_name: string }>(sql`
        select c.relname as table_name
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
         where c.relkind in ('r', 'p') and not c.relispartition
           and exists (select 1 from pg_attribute a
                        where a.attrelid = c.oid and a.attname = 'project_id' and not a.attisdropped)
         order by 1
      `);
      const tables = result.rows.map((row) => row.table_name);
      expect(tables).toEqual(tablesWithFixture);

      for (const table of [...tables, 'project']) {
        const policies = await harness.ownerDb.execute<{ cmd: string }>(sql`
          select cmd from pg_policies
           where schemaname = 'public' and tablename = ${table} and permissive = 'RESTRICTIVE'
        `);
        expect(
          policies.rows.length,
          `${table} sin policy restrictiva por proyecto`,
        ).toBeGreaterThan(0);
      }
    });

    it('toda tabla con task_id tiene también project_id', async () => {
      const result = await harness.ownerDb.execute<{ table_name: string }>(sql`
        select c.relname as table_name
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
         where c.relkind = 'r' and not c.relispartition
           and exists (select 1 from pg_attribute a
                        where a.attrelid = c.oid and a.attname = 'task_id' and not a.attisdropped)
           and not exists (select 1 from pg_attribute a
                        where a.attrelid = c.oid and a.attname = 'project_id' and not a.attisdropped)
      `);
      expect(result.rows).toEqual([]);
    });

    it('cada partición de audit_log tiene su policy de lectura por proyecto', async () => {
      const result = await harness.ownerDb.execute<{ missing: string }>(sql`
        select c.relname as missing
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
         where c.relkind = 'r' and c.relispartition and c.relname like 'audit\_log\_%'
           and not exists (select 1 from pg_policies p
                            where p.tablename = c.relname and p.permissive = 'RESTRICTIVE')
      `);
      expect(result.rows).toEqual([]);
    });

    it('una partición nueva de audit_log nace con la policy (app_ensure_audit_partitions)', async () => {
      await harness.ownerDb.execute(sql`select app_ensure_audit_partitions('2099-03-01', 1)`);
      const result = await harness.ownerDb.execute<{ cmd: string }>(sql`
        select cmd from pg_policies
         where tablename = 'audit_log_2099_03' and permissive = 'RESTRICTIVE'
      `);
      expect(result.rows.map((row) => row.cmd)).toEqual(['SELECT']);
    });
  });
});
