import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type PostgresHarness, startPostgresHarness } from '../src/testing/postgres-harness.js';

/**
 * `app_bump_version()` (0005_projects.sql) solo avanzaba `version`;
 * `updated_at` quedaba pegado al valor de `created_at` para siempre en
 * cualquier tabla que use `app_apply_version_triggers()` (todas las que
 * declaran `version`). El fix agrega `NEW.updated_at := now()`.
 *
 * Se prueba acá con una tabla de prueba, no contra `task`/`project`: esas
 * tienen FK a `auth.organization`, y este mecanismo es genérico — no hace
 * falta una organización real de Better Auth para probarlo.
 *
 * Usa `harness.ownerDb`, no `app_login` (CLAUDE.md §7 exige `app_login` para
 * todo acceso a datos): necesita correr el `CREATE TABLE` de la tabla de
 * prueba, DDL que `app_login` no tiene permiso de ejecutar, y esa tabla no
 * lleva `organization_id`, así que no hay ninguna policy de RLS en juego acá.
 * Es la excepción por lo que se está probando (un trigger genérico, no una
 * tabla de negocio), no el patrón a copiar: cualquier test que ejercite datos
 * de una tabla real de negocio va con `app_login`.
 */
describe('app_bump_version', () => {
  let harness: PostgresHarness;
  const rowId = randomUUID();

  beforeAll(async () => {
    harness = await startPostgresHarness();

    await harness.ownerDb.execute(sql`
      create table version_trigger_probe (
        id uuid primary key,
        version integer default 1 not null,
        updated_at timestamptz default now() not null,
        label text not null
      )
    `);
    // Idempotente (0005_projects.sql): re-escanea todas las tablas con
    // columna `version` y le crea el trigger a las que todavía no lo
    // tienen — cubre esta tabla de prueba sin tocar las reales.
    await harness.ownerDb.execute(sql`select app_apply_version_triggers()`);
    await harness.ownerDb.execute(
      sql`insert into version_trigger_probe (id, label) values (${rowId}, 'inicial')`,
    );
  });

  afterAll(async () => {
    await harness.stop();
  });

  it('un UPDATE avanza version y updated_at', async () => {
    const before = await harness.ownerDb.execute<{ version: number; updated_at: string }>(
      sql`select version, updated_at from version_trigger_probe where id = ${rowId}`,
    );

    await harness.ownerDb.execute(
      sql`update version_trigger_probe set label = 'modificado' where id = ${rowId}`,
    );

    const after = await harness.ownerDb.execute<{ version: number; updated_at: string }>(
      sql`select version, updated_at from version_trigger_probe where id = ${rowId}`,
    );

    const beforeRow = before.rows[0];
    const afterRow = after.rows[0];
    if (!beforeRow || !afterRow) throw new Error('esperaba una fila antes y después del UPDATE');

    expect(afterRow.version).toBe(beforeRow.version + 1);
    expect(new Date(afterRow.updated_at).getTime()).toBeGreaterThan(
      new Date(beforeRow.updated_at).getTime(),
    );
  });
});
