import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertAuthMember, insertAuthOrganization } from '../src/testing/auth-fixtures.js';
import { type PostgresHarness, startPostgresHarness } from '../src/testing/postgres-harness.js';
import { type Tx, withTenantTransaction } from '../src/transaction.js';

/**
 * ADR-017, adenda "El creador entra como miembro" (migración 0016): el creador
 * de un proyecto reservado tiene acceso completo SOLO durante la transacción
 * que lo creó, lo justo para insertar su fila de `project_member`. Lo que
 * persiste es esa fila; quitarla le saca el acceso.
 */
describe('el creador entra como miembro (ADR-017, adenda)', () => {
  let harness: PostgresHarness;
  const suffix = randomUUID().replaceAll('-', '');
  const orgA = `org_a_${suffix}`;
  const creator = `creator_${suffix}`;
  const owner = `owner_${suffix}`;
  const outsider = `outsider_${suffix}`;
  const assigned = `assigned_${suffix}`;
  let siteId: string;

  const as = <T>(memberId: string, run: (tx: Tx) => Promise<T>) =>
    withTenantTransaction(
      harness.db,
      { organizationId: orgA, memberId, requestId: randomUUID() },
      run,
    );

  async function insertProject(tx: Tx, id: string, createdBy: string) {
    // Sin created_at ni version: vienen del default de la base (la rama de la
    // función depende de eso).
    await tx.execute(sql`
      insert into project (id, organization_id, site_id, created_by_member_id, code, name)
      values (${id}, ${orgA}, ${siteId}, ${createdBy}, ${`PRY-${id.slice(0, 8)}`}, 'Proyecto')
    `);
  }

  async function insertProjectMember(tx: Tx, projectId: string, memberId: string, by: string) {
    await tx.execute(sql`
      insert into project_member (id, organization_id, created_by_member_id, project_id, member_id)
      values (${randomUUID()}, ${orgA}, ${by}, ${projectId}, ${memberId})
    `);
  }

  const visibleProjects = async (memberId: string) =>
    (await as(memberId, (tx) => tx.execute<{ id: string }>(sql`select id from project`))).rows.map(
      (row) => row.id,
    );

  async function expectRlsViolation(promise: Promise<unknown>) {
    await expect(promise).rejects.toMatchObject({ cause: { code: '42501' } });
  }

  beforeAll(async () => {
    harness = await startPostgresHarness();
    await insertAuthOrganization(harness.ownerDb, { id: orgA });
    for (const [memberId, role] of [
      [creator, 'owner'],
      [owner, 'owner'],
      [outsider, 'operator'],
      [assigned, 'operator'],
    ] as const) {
      await insertAuthMember(harness.ownerDb, { organizationId: orgA, memberId, role });
    }
    // El "creador" de la mayoría de las pruebas tiene que ser un rol no
    // privilegiado: un owner ve todo y no probaría nada.
    await harness.ownerDb.execute(sql`
      update auth.member set role = 'manager' where id = ${creator}
    `);
    siteId = randomUUID();
    await as(owner, async (tx) => {
      await tx.execute(sql`
        insert into site (id, organization_id, name, timezone)
        values (${siteId}, ${orgA}, 'Sitio A', 'America/Argentina/Buenos_Aires')
      `);
    });
  });

  afterAll(async () => {
    await harness.stop();
  });

  it('crea el proyecto reservado y se agrega como miembro; después lo ve por esa fila', async () => {
    const projectId = randomUUID();
    await as(creator, async (tx) => {
      await insertProject(tx, projectId, creator);
      await insertProjectMember(tx, projectId, creator, creator);
    });

    expect(await visibleProjects(creator)).toContain(projectId);
    expect(await visibleProjects(outsider)).not.toContain(projectId);
  });

  it('el INSERT ... RETURNING del proyecto sigue rechazado (la función no ve la fila de su propia sentencia); un SELECT aparte sí', async () => {
    const withReturning = randomUUID();
    await expectRlsViolation(
      as(creator, (tx) =>
        tx.execute(sql`
          insert into project (id, organization_id, site_id, created_by_member_id, code, name)
          values (${withReturning}, ${orgA}, ${siteId}, ${creator}, ${`PRY-${withReturning.slice(0, 8)}`}, 'P')
          returning id
        `),
      ),
    );

    const separate = randomUUID();
    const seen = await as(creator, async (tx) => {
      await insertProject(tx, separate, creator);
      const rows = await tx.execute<{ id: string }>(
        sql`select id from project where id = ${separate}`,
      );
      await insertProjectMember(tx, separate, creator, creator);
      return rows.rows;
    });
    expect(seen).toEqual([{ id: separate }]);
  });

  it('el acceso derivado no sobrevive al COMMIT: sin fila de miembro, el creador no ve el proyecto', async () => {
    const projectId = randomUUID();
    await as(creator, (tx) => insertProject(tx, projectId, creator));

    expect(await visibleProjects(creator)).not.toContain(projectId);
  });

  it('quitar al creador (deleted_at de su fila) le saca el acceso', async () => {
    const projectId = randomUUID();
    await as(creator, async (tx) => {
      await insertProject(tx, projectId, creator);
      await insertProjectMember(tx, projectId, creator, creator);
    });
    expect(await visibleProjects(creator)).toContain(projectId);

    await as(owner, (tx) =>
      tx.execute(sql`
        update project_member set deleted_at = now()
         where project_id = ${projectId} and member_id = ${creator}
      `),
    );

    expect(await visibleProjects(creator)).not.toContain(projectId);
  });

  it('solo sirve para el creador: otro miembro no puede agregarse a un proyecto ajeno', async () => {
    const projectId = randomUUID();
    await as(creator, async (tx) => {
      await insertProject(tx, projectId, creator);
      await insertProjectMember(tx, projectId, creator, creator);
    });

    await expectRlsViolation(
      as(outsider, (tx) => insertProjectMember(tx, projectId, outsider, outsider)),
    );
  });

  it('el creador tampoco puede agregar miembros a un proyecto que no creó en esta transacción', async () => {
    const projectId = randomUUID();
    await as(owner, (tx) => insertProject(tx, projectId, owner));

    await expectRlsViolation(
      as(creator, (tx) => insertProjectMember(tx, projectId, creator, creator)),
    );
  });

  it('un UPDATE del proyecto antes del INSERT del miembro sube version a 2 y corta el acceso', async () => {
    const projectId = randomUUID();
    await expectRlsViolation(
      as(creator, async (tx) => {
        await insertProject(tx, projectId, creator);
        await tx.execute(sql`update project set name = 'Otro' where id = ${projectId}`);
        await insertProjectMember(tx, projectId, creator, creator);
      }),
    );
    expect(await visibleProjects(owner)).not.toContain(projectId);
  });

  it('un asignado no puede reescribir created_by_member_id y created_at para darse acceso completo', async () => {
    const projectId = randomUUID();
    await as(owner, async (tx) => {
      await insertProject(tx, projectId, owner);
      await tx.execute(sql`
        insert into task (id, organization_id, created_by_member_id, project_id, title, position,
                          assignee_member_id)
        values (${randomUUID()}, ${orgA}, ${owner}, ${projectId}, 'tarea', 'a0', ${assigned})
      `);
    });
    // El asignado ve el proyecto (nivel "solo asignado") y la policy le deja
    // hacer UPDATE; el trigger de version cierra el atajo.
    await expectRlsViolation(
      as(assigned, async (tx) => {
        await tx.execute(sql`
          update project set created_by_member_id = ${assigned}, created_at = now()
           where id = ${projectId}
        `);
        await insertProjectMember(tx, projectId, assigned, assigned);
      }),
    );
  });

  it('dentro de un savepoint también anda (transaction_timestamp no depende del xid)', async () => {
    const projectId = randomUUID();
    await as(creator, async (tx) => {
      await tx.transaction(async (savepoint) => {
        await insertProject(savepoint, projectId, creator);
        await insertProjectMember(savepoint, projectId, creator, creator);
      });
    });

    expect(await visibleProjects(creator)).toContain(projectId);
  });

  describe('reintento del mismo client_mutation_id', () => {
    const memberTxn = async (clientMutationId: string, projectId: string) =>
      as(creator, async (tx) => {
        const prior = await tx.execute(sql`
          select entity_id from mutation_log where client_mutation_id = ${clientMutationId}
        `);
        if (prior.rows.length > 0) return 'duplicate' as const;
        await insertProject(tx, projectId, creator);
        await insertProjectMember(tx, projectId, creator, creator);
        await tx.execute(sql`
          insert into mutation_log
            (client_mutation_id, organization_id, member_id, kind, entity_id, result)
          values (${clientMutationId}, ${orgA}, ${creator}, 'create-project', ${projectId}, 'applied')
        `);
        return 'applied' as const;
      });

    const countFor = async (projectId: string) => {
      const result = await as(creator, (tx) =>
        tx.execute<{ projects: number; members: number }>(sql`
          select (select count(*)::int from project where id = ${projectId}) as projects,
                 (select count(*)::int from project_member where project_id = ${projectId}) as members
        `),
      );
      return result.rows[0];
    };

    it('reintento secuencial: un solo proyecto y una sola fila de miembro', async () => {
      const clientMutationId = randomUUID();
      const projectId = randomUUID();

      expect(await memberTxn(clientMutationId, projectId)).toBe('applied');
      expect(await memberTxn(clientMutationId, randomUUID())).toBe('duplicate');

      expect(await countFor(projectId)).toEqual({ projects: 1, members: 1 });
    });

    it('reintento concurrente: gana uno, el otro revienta por la clave y no deja nada', async () => {
      const clientMutationId = randomUUID();
      const first = randomUUID();
      const second = randomUUID();

      const results = await Promise.allSettled([
        memberTxn(clientMutationId, first),
        memberTxn(clientMutationId, second),
      ]);

      expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
      const totals = [await countFor(first), await countFor(second)];
      expect(totals.reduce((sum, row) => sum + (row?.projects ?? 0), 0)).toBe(1);
      expect(totals.reduce((sum, row) => sum + (row?.members ?? 0), 0)).toBe(1);
    });
  });
});
