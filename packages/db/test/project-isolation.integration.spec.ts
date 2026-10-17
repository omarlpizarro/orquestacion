import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSystemScanTransaction } from '../src/system-transaction.js';
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

  describe('avisos (notification, ADR-019)', () => {
    /**
     * Sin RETURNING a propósito: quien asigna o bloquea crea el aviso de OTRO, y un
     * RETURNING evaluaría la policy de lectura por destinatario sobre una fila que no es suya.
     */
    async function insertNotification(
      tx: Tx,
      params: { recipient: ActorName; by: ActorName; taskId: string; projectId: string },
    ): Promise<string> {
      const id = randomUUID();
      await tx.execute(sql`
        insert into notification (id, organization_id, created_by_member_id, recipient_member_id,
                                  task_id, project_id, template_key, channel, status)
        values (${id}, ${orgA}, ${memberId(params.by)}, ${memberId(params.recipient)},
                ${params.taskId}, ${params.projectId}, 'task.assigned', 'inapp', 'delivered')
        on conflict do nothing
      `);
      return id;
    }
    const notificationsQuery = sql`select id from notification`;
    let forAssigned: string;

    beforeAll(async () => {
      // El creador (manager, miembro explícito de R) crea el aviso del operario asignado.
      forAssigned = await as('creator', (tx) =>
        insertNotification(tx, {
          recipient: 'assigned',
          by: 'creator',
          taskId: taskAssigned,
          projectId: projectR,
        }),
      );
    });

    it('el operario "solo asignado" ve su aviso y no ve ningún otro', async () => {
      expect(await ids('assigned', notificationsQuery)).toEqual([forAssigned]);
    });

    it('un manager crea el aviso de un operario; otro operario no lo ve, ni quien lo creó, ni el owner', async () => {
      // 'explicit' es operario con acceso completo a R; 'creator' lo creó y tiene acceso
      // completo; 'owner' es privilegiado. Ninguno es el destinatario.
      for (const actor of ['explicit', 'creator', 'owner', 'director', 'outsider'] as const) {
        expect(await ids(actor, notificationsQuery), actor).toEqual([]);
      }
    });

    it('el destinatario lo marca como leído; nadie más puede tocarlo', async () => {
      const mark = (actor: ActorName) =>
        as(actor, (tx) =>
          tx.execute<{ id: string }>(
            sql`update notification set read_at = now() where id = ${forAssigned} returning id`,
          ),
        );
      for (const actor of ['explicit', 'creator', 'owner', 'outsider'] as const) {
        expect((await mark(actor)).rows, actor).toEqual([]);
      }
      expect((await mark('assigned')).rows.map((row) => row.id)).toEqual([forAssigned]);
      const read = await as('assigned', (tx) =>
        tx.execute<{ read_at: string | null }>(
          sql`select read_at from notification where id = ${forAssigned}`,
        ),
      );
      expect(read.rows[0]?.read_at).not.toBeNull();
    });

    it('un INSERT ... RETURNING del aviso de otro falla: por eso se inserta sin RETURNING', async () => {
      await expectPgError(
        as('creator', (tx) =>
          tx.execute(sql`
            insert into notification (id, organization_id, created_by_member_id, recipient_member_id,
                                      task_id, project_id, template_key, channel, status)
            values (${randomUUID()}, ${orgA}, ${memberId('creator')}, ${memberId('assigned')},
                    ${taskAssigned}, ${projectR}, 'task.assigned', 'inapp', 'delivered')
            returning id
          `),
        ),
        '42501',
      );
    });

    it('quien no ve la tarea ni el proyecto no puede crear avisos sobre ellos', async () => {
      await expectPgError(
        as('outsider', (tx) =>
          insertNotification(tx, {
            recipient: 'creator',
            by: 'outsider',
            taskId: taskAssigned,
            projectId: projectR,
          }),
        ),
        '42501',
      );
    });

    it('quien pierde el acceso al proyecto deja de ver sus avisos de él', async () => {
      const setMembership = (deletedAt: 'now()' | 'null') =>
        as('owner', (tx) =>
          tx.execute(
            sql`update project_member set deleted_at = ${sql.raw(deletedAt)}
                 where project_id = ${projectR} and member_id = ${memberId('explicit')}`,
          ),
        );
      // Un test anterior dejó a `explicit` fuera del proyecto: se lo vuelve a sumar para
      // este caso y se restaura el estado anterior al terminar.
      await setMembership('null');
      try {
        const forExplicit = await as('owner', (tx) =>
          insertNotification(tx, {
            recipient: 'explicit',
            by: 'owner',
            taskId: taskUnassigned,
            projectId: projectR,
          }),
        );
        expect(await ids('explicit', notificationsQuery)).toEqual([forExplicit]);

        await setMembership('now()');
        expect(await ids('explicit', notificationsQuery)).toEqual([]);
      } finally {
        await setMembership('now()');
      }
    });

    it('la tarea borrada saca el aviso de quien solo la tenía asignada', async () => {
      const task = await as('owner', (tx) =>
        insertTask(tx, { projectId: projectR, assignee: 'assigned', by: 'owner' }),
      );
      const notice = await as('owner', (tx) =>
        insertNotification(tx, {
          recipient: 'assigned',
          by: 'owner',
          taskId: task,
          projectId: projectR,
        }),
      );
      expect(await ids('assigned', notificationsQuery)).toContain(notice);

      await as('owner', (tx) =>
        tx.execute(sql`update task set deleted_at = now() where id = ${task}`),
      );

      expect(await ids('assigned', notificationsQuery)).not.toContain(notice);
    });

    it('otra organización no ve avisos ajenos', async () => {
      const result = await withTenantTransaction(
        harness.db,
        { organizationId: orgB, memberId: `ownerb_${suffix}`, requestId: randomUUID() },
        (tx) => tx.execute<{ id: string }>(notificationsQuery),
      );
      expect(result.rows).toEqual([]);
    });
  });

  describe('bandeja de pendientes (notification_outbox, ADR-019)', () => {
    const entityId = randomUUID();
    const outboxIds = (rows: Array<{ id: string }>) => rows.map((row) => row.id);
    let outboxA: string;
    let outboxB: string;
    const asOwnerOfB = <T>(run: (tx: Tx) => Promise<T>) =>
      withTenantTransaction(
        harness.db,
        { organizationId: orgB, memberId: `ownerb_${suffix}`, requestId: randomUUID() },
        run,
      );

    beforeAll(async () => {
      outboxA = randomUUID();
      outboxB = randomUUID();
      await as('outsider', (tx) =>
        tx.execute(sql`
          insert into notification_outbox (id, organization_id, created_by_member_id, kind, entity_id)
          values (${outboxA}, ${orgA}, ${memberId('outsider')}, 'task.blocked', ${entityId})
        `),
      );
      await asOwnerOfB((tx) =>
        tx.execute(sql`
          insert into notification_outbox (id, organization_id, created_by_member_id, kind, entity_id)
          values (${outboxB}, ${orgB}, ${`ownerb_${suffix}`}, 'task.blocked', ${entityId})
        `),
      );
    });

    it('la API (con su identidad de siempre) encola y lee solo lo de su organización', async () => {
      const mine = await as('owner', (tx) =>
        tx.execute<{ id: string }>(sql`select id from notification_outbox`),
      );
      expect(outboxIds(mine.rows)).toEqual([outboxA]);
    });

    it('encolar dos veces lo mismo no duplica la fila', async () => {
      await as('outsider', (tx) =>
        tx.execute(sql`
          insert into notification_outbox (id, organization_id, created_by_member_id, kind, entity_id)
          values (${randomUUID()}, ${orgA}, ${memberId('outsider')}, 'task.blocked', ${entityId})
          on conflict do nothing
        `),
      );
      const count = await as('owner', (tx) =>
        tx.execute<{ n: number }>(sql`select count(*)::int as n from notification_outbox`),
      );
      expect(count.rows[0]?.n).toBe(1);
    });

    it('declarar alcance "sistema" desde la API (app_login) no abre la lectura transversal', async () => {
      const result = await harness.db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.scope', 'system', true)`);
        return tx.execute<{ id: string }>(sql`select id from notification_outbox`);
      });
      expect(result.rows).toEqual([]);
    });

    it('un owner de una organización no lee la bandeja de otra', async () => {
      const result = await asOwnerOfB((tx) =>
        tx.execute<{ id: string }>(sql`select id from notification_outbox`),
      );
      expect(outboxIds(result.rows)).toEqual([outboxB]);
    });

    it('app_worker con alcance de sistema y sin organización ve la bandeja de todas', async () => {
      const result = await withSystemScanTransaction(
        harness.workerDb,
        { job: 'test', requestId: randomUUID() },
        (tx) => tx.execute<{ id: string }>(sql`select id from notification_outbox`),
      );
      expect(outboxIds(result.rows).sort()).toEqual(sorted(outboxA, outboxB));
    });

    it('el mismo alcance no abre ninguna otra tabla', async () => {
      const result = await withSystemScanTransaction(
        harness.workerDb,
        { job: 'test', requestId: randomUUID() },
        (tx) => tx.execute<{ id: string }>(sql`select id from task`),
      );
      expect(result.rows).toEqual([]);
    });

    it('app_worker sin alcance de sistema tampoco ve nada', async () => {
      const result = await harness.workerDb.transaction((tx) =>
        tx.execute<{ id: string }>(sql`select id from notification_outbox`),
      );
      expect(result.rows).toEqual([]);
    });
  });

  describe('cobertura del catálogo', () => {
    // Una tabla nueva con `project_id` sin fixture registrada acá hace fallar
    // este test: es lo que obliga a escribir su caso de aislamiento.
    const tablesWithFixture = [
      'audit_log',
      'notification',
      'project_member',
      'task',
      'task_update',
    ];

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
      // 24 meses desde hoy: llega más allá de los 13 que crea la 0012, así que hay una nueva.
      await harness.ownerDb.execute(sql`select app_ensure_audit_partitions(current_date, 24)`);
      const result = await harness.ownerDb.execute<{ cmd: string }>(sql`
        select cmd from pg_policies
         where tablename = 'audit_log_' || to_char(date_trunc('month', now() at time zone 'UTC') + interval '23 months', 'YYYY_MM')
           and permissive = 'RESTRICTIVE'
      `);
      expect(result.rows.map((row) => row.cmd)).toEqual(['SELECT']);
    });
  });
});
