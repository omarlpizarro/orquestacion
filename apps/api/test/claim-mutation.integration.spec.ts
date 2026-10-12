import { randomUUID } from 'node:crypto';
import { newId } from '@orq/contracts';
import { type Tx, withTenantTransaction } from '@orq/db';
import type { PostgresHarness } from '@orq/db/testing';
import { insertAuthMember, insertAuthOrganization, startPostgresHarness } from '@orq/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimMutation } from '../src/shared/database/mutation-log.js';
import { MutationIdReusedError } from '../src/shared/errors/mutation-id-reused.error.js';

/**
 * ADR-007, "se reserva la mutación antes de leer": `claimMutation` contra
 * Postgres real. Lo que se prueba vive en la unicidad de `mutation_log` y en
 * que Postgres hace esperar al segundo `INSERT`, que un mock no ejecuta.
 */
describe('claimMutation (integración)', () => {
  let harness: PostgresHarness;
  const suffix = randomUUID().replaceAll('-', '');
  const orgA = `org_a_${suffix}`;
  const orgB = `org_b_${suffix}`;
  const memberA = `member_a_${suffix}`;
  const memberB = `member_b_${suffix}`;

  const inOrg = <T>(organizationId: string, memberId: string, run: (tx: Tx) => Promise<T>) =>
    withTenantTransaction(harness.db, { organizationId, memberId, requestId: newId() }, run);

  // La misma operación sobre la misma entidad: cada id de mutación apunta a una
  // entidad fija, para que un reintento sea de verdad el mismo pedido.
  const entityByMutation = new Map<string, string>();
  const entityFor = (clientMutationId: string) => {
    const known = entityByMutation.get(clientMutationId);
    if (known) return known;
    const created = newId();
    entityByMutation.set(clientMutationId, created);
    return created;
  };

  const claim = (tx: Tx, clientMutationId: string, organizationId = orgA, memberId = memberA) =>
    claimMutation(tx, {
      clientMutationId,
      organizationId,
      memberId,
      kind: 'test.claim',
      entityId: entityFor(clientMutationId),
    });

  const rowsFor = (clientMutationId: string) =>
    inOrg(orgA, memberA, (tx) =>
      tx.execute(sql`select 1 from mutation_log where client_mutation_id = ${clientMutationId}`),
    ).then((result) => result.rows.length);

  beforeAll(async () => {
    harness = await startPostgresHarness();
    await insertAuthOrganization(harness.ownerDb, { id: orgA });
    await insertAuthOrganization(harness.ownerDb, { id: orgB });
    await insertAuthMember(harness.ownerDb, {
      organizationId: orgA,
      memberId: memberA,
      role: 'owner',
    });
    await insertAuthMember(harness.ownerDb, {
      organizationId: orgB,
      memberId: memberB,
      role: 'owner',
    });
  });

  afterAll(async () => {
    await harness.stop();
  });

  it('la primera vez reserva; la segunda, ya confirmada, devuelve lo registrado sin error', async () => {
    const id = newId();

    const first = await inOrg(orgA, memberA, (tx) => claim(tx, id));
    const second = await inOrg(orgA, memberA, (tx) => claim(tx, id));

    expect(first).toEqual({ claimed: true });
    expect(second).toMatchObject({
      claimed: false,
      prior: { result: 'applied', rejectionReason: null },
    });
    expect(await rowsFor(id)).toBe(1);
  });

  it('si la transacción falla después, el rollback se lleva la reserva y un reintento empieza de cero', async () => {
    const id = newId();

    await expect(
      inOrg(orgA, memberA, async (tx) => {
        expect(await claim(tx, id)).toEqual({ claimed: true });
        throw new Error('una regla de dominio rechazó la mutación');
      }),
    ).rejects.toThrow('una regla de dominio');
    expect(await rowsFor(id)).toBe(0);

    const retry = await inOrg(orgA, memberA, (tx) => claim(tx, id));
    expect(retry).toEqual({ claimed: true });
  });

  it('dos transacciones a la vez: la segunda ESPERA a la primera y, cuando confirma, no reserva nada', async () => {
    const id = newId();
    let releaseFirst: () => void = () => undefined;
    const firstMayCommit = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstHasClaimed: () => void = () => undefined;
    const firstClaimed = new Promise<void>((resolve) => {
      firstHasClaimed = resolve;
    });

    const first = inOrg(orgA, memberA, async (tx) => {
      const result = await claim(tx, id);
      firstHasClaimed();
      await firstMayCommit;
      return result;
    });
    await firstClaimed;

    let secondDone = false;
    const second = inOrg(orgA, memberA, (tx) => claim(tx, id)).then((result) => {
      secondDone = true;
      return result;
    });
    // Si Postgres no la hiciera esperar, la segunda terminaría enseguida.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(secondDone).toBe(false);

    releaseFirst();
    expect(await first).toEqual({ claimed: true });
    expect(await second).toMatchObject({ claimed: false, prior: { result: 'applied' } });
    expect(await rowsFor(id)).toBe(1);
  });

  it('si la primera hace rollback mientras la segunda espera, la segunda reserva y sigue', async () => {
    const id = newId();
    let releaseFirst: () => void = () => undefined;
    const firstMayFail = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstHasClaimed: () => void = () => undefined;
    const firstClaimed = new Promise<void>((resolve) => {
      firstHasClaimed = resolve;
    });

    const first = inOrg(orgA, memberA, async (tx) => {
      await claim(tx, id);
      firstHasClaimed();
      await firstMayFail;
      throw new Error('rechazada por una regla de dominio');
    });
    const firstOutcome = first.then(
      () => 'ok',
      () => 'rolled back',
    );
    await firstClaimed;

    const second = inOrg(orgA, memberA, (tx) => claim(tx, id));
    await new Promise((resolve) => setTimeout(resolve, 300));
    releaseFirst();

    expect(await firstOutcome).toBe('rolled back');
    expect(await second).toEqual({ claimed: true });
    expect(await rowsFor(id)).toBe(1);
  });

  it('un id que ya usó otra organización se rechaza sin decir de quién era', async () => {
    const id = newId();
    await inOrg(orgB, memberB, (tx) => claim(tx, id, orgB, memberB));

    await expect(inOrg(orgA, memberA, (tx) => claim(tx, id))).rejects.toBeInstanceOf(
      MutationIdReusedError,
    );
    expect(await rowsFor(id)).toBe(0);
  });

  describe('mismo id, otra operación (mitigación parcial de CLAUDE.md §13 #6)', () => {
    const claimAs = (tx: Tx, clientMutationId: string, kind: string, entityId: string | null) =>
      claimMutation(tx, {
        clientMutationId,
        organizationId: orgA,
        memberId: memberA,
        kind,
        entityId,
      });

    it('mismo id con otro kind: se rechaza, no se devuelve la respuesta de la otra operación', async () => {
      const id = newId();
      const entity = newId();
      await inOrg(orgA, memberA, (tx) => claimAs(tx, id, 'task.create', entity));

      await expect(
        inOrg(orgA, memberA, (tx) => claimAs(tx, id, 'task.change-status', entity)),
      ).rejects.toBeInstanceOf(MutationIdReusedError);
    });

    it('mismo id y mismo kind pero otra entidad: se rechaza', async () => {
      const id = newId();
      await inOrg(orgA, memberA, (tx) => claimAs(tx, id, 'task.change-status', newId()));

      await expect(
        inOrg(orgA, memberA, (tx) => claimAs(tx, id, 'task.change-status', newId())),
      ).rejects.toBeInstanceOf(MutationIdReusedError);
    });

    it('mismo kind y misma entidad: es el reintento, se devuelve lo registrado (también si el id viaja en mayúsculas)', async () => {
      const id = newId();
      const entity = newId();
      await inOrg(orgA, memberA, (tx) => claimAs(tx, id, 'task.change-status', entity));

      const retry = await inOrg(orgA, memberA, (tx) =>
        claimAs(tx, id, 'task.change-status', entity.toUpperCase()),
      );

      expect(retry).toMatchObject({ claimed: false, prior: { kind: 'task.change-status' } });
    });

    it('la reserva rechazada no deja nada nuevo en mutation_log', async () => {
      const id = newId();
      await inOrg(orgA, memberA, (tx) => claimAs(tx, id, 'task.create', newId()));
      await expect(
        inOrg(orgA, memberA, (tx) => claimAs(tx, id, 'task.change-status', newId())),
      ).rejects.toBeInstanceOf(MutationIdReusedError);

      expect(await rowsFor(id)).toBe(1);
    });
  });
});
