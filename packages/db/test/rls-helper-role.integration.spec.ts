import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSystemTransaction } from '../src/system-transaction.js';
import { insertAuthMember, insertAuthOrganization } from '../src/testing/auth-fixtures.js';
import { type PostgresHarness, startPostgresHarness } from '../src/testing/postgres-harness.js';
import { type Tx, withTenantTransaction } from '../src/transaction.js';

/**
 * Metatest de ADR-017 §4 y §5: las condiciones bajo las que se aprobó un rol con
 * BYPASSRLS. Si alguna deja de cumplirse, la aprobación deja de valer. Verifica
 * el catálogo de Postgres, no el código: es lo único que no se puede maquillar.
 */
describe('rol auxiliar de RLS (ADR-017 §4)', () => {
  let harness: PostgresHarness;
  const suffix = randomUUID().replaceAll('-', '');
  const orgA = `org_a_${suffix}`;
  const orgB = `org_b_${suffix}`;
  const ownerA = `owner_a_${suffix}`;
  const ownerB = `owner_b_${suffix}`;
  const operatorA = `operator_a_${suffix}`;
  let projectA: string;

  const helperFunctions = [
    'app_assigned_project_ids()',
    'app_assigned_task_ids()',
    'app_full_access_project_ids()',
    'app_has_assigned_project_access(uuid)',
    'app_has_full_project_access(uuid)',
    'app_is_privileged()',
  ];

  beforeAll(async () => {
    harness = await startPostgresHarness();
    await insertAuthOrganization(harness.ownerDb, { id: orgA });
    await insertAuthOrganization(harness.ownerDb, { id: orgB });
    await insertAuthMember(harness.ownerDb, {
      organizationId: orgA,
      memberId: ownerA,
      role: 'owner',
    });
    await insertAuthMember(harness.ownerDb, {
      organizationId: orgB,
      memberId: ownerB,
      role: 'owner',
    });
    await insertAuthMember(harness.ownerDb, {
      organizationId: orgA,
      memberId: operatorA,
      role: 'operator',
    });
    const siteA = randomUUID();
    projectA = randomUUID();
    await withTenantTransaction(
      harness.db,
      { organizationId: orgA, memberId: ownerA, requestId: randomUUID() },
      async (tx) => {
        await tx.execute(sql`
          insert into site (id, organization_id, name, timezone)
          values (${siteA}, ${orgA}, 'Sitio A', 'America/Argentina/Buenos_Aires')
        `);
        await tx.execute(sql`
          insert into project (id, organization_id, site_id, created_by_member_id, code, name)
          values (${projectA}, ${orgA}, ${siteA}, ${ownerA}, 'PRY-A', 'PRY-A')
        `);
        await tx.execute(sql`
          insert into task (id, organization_id, created_by_member_id, project_id, title, position, assignee_member_id)
          values (${randomUUID()}, ${orgA}, ${ownerA}, ${projectA}, 'tarea', 'a0', ${operatorA})
        `);
      },
    );
  });

  afterAll(async () => {
    await harness.stop();
  });

  async function catalog<T extends Record<string, unknown>>(query: ReturnType<typeof sql>) {
    return (await harness.ownerDb.execute<T>(query)).rows;
  }

  describe('el rol', () => {
    it('es NOLOGIN, BYPASSRLS y no superusuario', async () => {
      const [role] = await catalog<{
        rolcanlogin: boolean;
        rolbypassrls: boolean;
        rolsuper: boolean;
      }>(
        sql`select rolcanlogin, rolbypassrls, rolsuper from pg_roles where rolname = 'app_rls_helper'`,
      );
      expect(role).toEqual({ rolcanlogin: false, rolbypassrls: true, rolsuper: false });
    });

    it('no tiene membresías en ningún sentido', async () => {
      const rows = await catalog(sql`
        select m.roleid::regrole::text as role, m.member::regrole::text as member
          from pg_auth_members m
         where m.roleid = 'app_rls_helper'::regrole or m.member = 'app_rls_helper'::regrole
      `);
      expect(rows).toEqual([]);
    });

    it('ningún otro rol tiene BYPASSRLS, y el único superusuario es el de arranque', async () => {
      const bypass = await catalog<{ rolname: string }>(
        sql`select rolname from pg_roles where rolbypassrls and not rolsuper order by 1`,
      );
      expect(bypass.map((row) => row.rolname)).toEqual(['app_rls_helper']);
      const superusers = await catalog<{ rolname: string }>(
        sql`select rolname from pg_roles where rolsuper order by 1`,
      );
      expect(superusers.map((row) => row.rolname)).toEqual(['test']);
    });

    it.each([
      ['app_login', () => harness.appPool],
      ['app_worker', () => harness.workerPool],
    ] as const)('%s no puede asumirlo con SET ROLE', async (_name, pool) => {
      await expect(pool().query('set role app_rls_helper')).rejects.toMatchObject({
        code: '42501',
      });
    });

    it('sus privilegios son exactamente SELECT sobre lo que leen las funciones', async () => {
      const grants = await catalog<{ privilege: string; object: string }>(sql`
        select privilege_type as privilege, table_schema || '.' || table_name as object
          from information_schema.role_table_grants
         where grantee = 'app_rls_helper'
         order by 2, 1
      `);
      expect(grants).toEqual([
        { privilege: 'SELECT', object: 'auth.member' },
        { privilege: 'SELECT', object: 'public.member_site_access' },
        { privilege: 'SELECT', object: 'public.project' },
        { privilege: 'SELECT', object: 'public.project_member' },
        { privilege: 'SELECT', object: 'public.task' },
      ]);
      const [schemas] = await catalog<{
        create_public: boolean;
        create_auth: boolean;
        usage: boolean;
      }>(sql`
        select has_schema_privilege('app_rls_helper', 'public', 'CREATE') as create_public,
               has_schema_privilege('app_rls_helper', 'auth', 'CREATE') as create_auth,
               has_schema_privilege('app_rls_helper', 'public', 'USAGE')
                 and has_schema_privilege('app_rls_helper', 'auth', 'USAGE') as usage
      `);
      expect(schemas).toEqual({ create_public: false, create_auth: false, usage: true });
    });

    it('no puede leer ninguna otra tabla (mínimo privilegio)', async () => {
      const rows = await catalog<{ relname: string }>(sql`
        select c.relname
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname in ('public', 'auth') and c.relkind in ('r', 'p')
           and has_table_privilege('app_rls_helper', c.oid, 'SELECT')
           and (n.nspname || '.' || c.relname) not in
               ('auth.member', 'public.member_site_access', 'public.project',
                'public.project_member', 'public.task')
      `);
      expect(rows).toEqual([]);
    });
  });

  describe('las funciones auxiliares', () => {
    it('son exactamente las de la tabla del ADR, y el rol no es dueño de nada más', async () => {
      const owned = await catalog<{ signature: string }>(sql`
        select p.oid::regprocedure::text as signature
          from pg_proc p
         where p.proowner = 'app_rls_helper'::regrole
         order by 1
      `);
      expect(owned.map((row) => row.signature)).toEqual(helperFunctions.map((f) => `${f}`));

      const otherObjects = await catalog<{ relname: string }>(
        sql`select relname from pg_class where relowner = 'app_rls_helper'::regrole`,
      );
      expect(otherObjects).toEqual([]);
    });

    it('son SECURITY DEFINER, STABLE y con search_path fijo', async () => {
      const rows = await catalog<{
        signature: string;
        prosecdef: boolean;
        provolatile: string;
        proconfig: string[];
      }>(sql`
        select p.oid::regprocedure::text as signature, prosecdef, provolatile, proconfig
          from pg_proc p where p.proowner = 'app_rls_helper'::regrole
      `);
      expect(rows).toHaveLength(helperFunctions.length);
      for (const row of rows) {
        expect(row.prosecdef, row.signature).toBe(true);
        expect(row.provolatile, row.signature).toBe('s');
        expect(row.proconfig, row.signature).toEqual(['search_path=pg_catalog, public, pg_temp']);
      }
    });

    it('devuelven solo boolean o setof uuid, nunca un tipo compuesto, text ni jsonb', async () => {
      const rows = await catalog<{ signature: string; returns: string; retset: boolean }>(sql`
        select p.oid::regprocedure::text as signature, p.prorettype::regtype::text as returns,
               p.proretset as retset
          from pg_proc p where p.proowner = 'app_rls_helper'::regrole
      `);
      for (const row of rows) {
        const ok = row.returns === 'boolean' || (row.returns === 'uuid' && row.retset);
        expect(ok, `${row.signature} devuelve ${row.returns}`).toBe(true);
      }
    });

    it('EXECUTE solo para app_user: ni PUBLIC, ni app_owner, ni los de login', async () => {
      const rows = await catalog<{ signature: string; grantee: string }>(sql`
        select p.oid::regprocedure::text as signature,
               case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as grantee
          from pg_proc p, aclexplode(p.proacl) a
         where p.proowner = 'app_rls_helper'::regrole and a.privilege_type = 'EXECUTE'
         order by 1, 2
      `);
      for (const signature of helperFunctions) {
        const grantees = rows
          .filter((row) => row.signature === signature)
          .map((row) => row.grantee);
        expect(grantees, signature).toEqual(['app_rls_helper', 'app_user']);
      }
    });
  });

  describe('search_path y tablas temporales', () => {
    it('toda función SECURITY DEFINER del esquema public fija exactamente pg_catalog, public, pg_temp', async () => {
      const rows = await catalog<{ signature: string; proconfig: string[] | null }>(sql`
        select p.oid::regprocedure::text as signature, p.proconfig
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
         where p.prosecdef
         order by 1
      `);
      // Las seis auxiliares, el puente y app_ensure_audit_partitions: ninguna más
      // sin revisar. Una función SECURITY DEFINER nueva tiene que cumplir esto (y
      // calificar sus tablas), o este test falla (CLAUDE.md §6).
      expect(rows.map((row) => row.signature).sort()).toEqual(
        [
          ...helperFunctions,
          'app_ensure_audit_partitions(date,integer)',
          'app_transfer_rls_helper_function(regprocedure,boolean)',
        ].sort(),
      );
      for (const row of rows) {
        expect(row.proconfig, row.signature).toEqual(['search_path=pg_catalog, public, pg_temp']);
      }
    });

    it('los roles de la aplicación no pueden crear tablas temporales (defensa adicional)', async () => {
      const rows = await catalog<{ rolname: string; can: boolean }>(sql`
        select r.rolname, has_database_privilege(r.rolname, current_database(), 'TEMPORARY') as can
          from pg_roles r
         where r.rolname in ('app_owner', 'app_user', 'app_login', 'app_worker', 'app_rls_helper')
         order by 1
      `);
      expect(rows.filter((row) => row.can)).toEqual([]);
    });
  });

  describe('no filtran entre organizaciones', () => {
    const call = <T extends Record<string, unknown>>(
      organizationId: string,
      memberId: string,
      query: ReturnType<typeof sql>,
    ) =>
      withTenantTransaction(
        harness.db,
        { organizationId, memberId, requestId: randomUUID() },
        async (tx: Tx) => (await tx.execute<T>(query)).rows,
      );

    it('con la organización B no devuelven ningún id de la A', async () => {
      // Un owner de B: ve todo lo suyo (nada), y nada de A.
      expect(await call(orgB, ownerB, sql`select * from app_full_access_project_ids()`)).toEqual(
        [],
      );
      expect(await call(orgB, ownerB, sql`select * from app_assigned_project_ids()`)).toEqual([]);
      expect(await call(orgB, ownerB, sql`select * from app_assigned_task_ids()`)).toEqual([]);
      const [full] = await call<{ ok: boolean }>(
        orgB,
        ownerB,
        sql`select app_has_full_project_access(${projectA}) as ok`,
      );
      expect(full?.ok).toBe(false);
    });

    it('un miembro de A con el contexto de B no es nadie en B', async () => {
      const [privileged] = await call<{ ok: boolean }>(
        orgB,
        ownerA,
        sql`select app_is_privileged() as ok`,
      );
      expect(privileged?.ok).toBe(false);
      expect(await call(orgB, ownerA, sql`select * from app_full_access_project_ids()`)).toEqual(
        [],
      );
    });

    it('sin organización en el contexto no devuelven nada', async () => {
      const result = await harness.db.execute(sql`select * from app_full_access_project_ids()`);
      expect(result.rows).toEqual([]);
    });

    it('con la organización correcta sí: owner ve el proyecto, el asignado lo ve como asignado', async () => {
      const full = await call<{ app_full_access_project_ids: string }>(
        orgA,
        ownerA,
        sql`select * from app_full_access_project_ids()`,
      );
      expect(full.map((row) => row.app_full_access_project_ids)).toEqual([projectA]);
      const [assigned] = await call<{ full: boolean; assigned: boolean }>(
        orgA,
        operatorA,
        sql`select app_has_full_project_access(${projectA}) as full,
                   app_has_assigned_project_access(${projectA}) as assigned`,
      );
      expect(assigned).toEqual({ full: false, assigned: true });
    });
  });

  describe('contexto de sistema (ADR-017 §5)', () => {
    const inSystem = (db: typeof harness.db, run: (tx: Tx) => Promise<unknown[]>) =>
      withSystemTransaction(
        db,
        { organizationId: orgA, job: 'metatest', requestId: randomUUID() },
        run,
      );
    const visibleProjects = async (tx: Tx) =>
      (await tx.execute<{ id: string }>(sql`select id from project`)).rows;

    it('con app_worker, fijar el contexto de sistema ve toda la organización', async () => {
      const rows = await inSystem(harness.workerDb, visibleProjects);
      expect(rows).toHaveLength(1);
    });

    it('con app_login, el mismo contexto NO amplía nada: la API no puede declararse sistema', async () => {
      const rows = await inSystem(harness.db, visibleProjects);
      expect(rows).toEqual([]);
    });

    it('con app_worker y sin el GUC de sistema tampoco hay privilegio (sin miembro, no es nadie)', async () => {
      const rows = await withTenantTransaction(
        harness.workerDb,
        { organizationId: orgA, memberId: 'nadie', requestId: randomUUID() },
        visibleProjects,
      );
      expect(rows).toEqual([]);
    });

    it('el sistema sigue acotado a la organización fijada', async () => {
      const rows = await withSystemTransaction(
        harness.workerDb,
        { organizationId: orgB, job: 'metatest', requestId: randomUUID() },
        visibleProjects,
      );
      expect(rows).toEqual([]);
    });

    it('la bitácora registra el trabajo de sistema con actor_kind system y el prefijo del job', async () => {
      await inSystem(harness.workerDb, async (tx) => {
        await tx.execute(sql`update project set name = 'renombrado' where id = ${projectA}`);
        return [];
      });
      const rows = await withSystemTransaction(
        harness.workerDb,
        { organizationId: orgA, job: 'lectura', requestId: randomUUID() },
        async (tx) =>
          (
            await tx.execute<{ actor_kind: string; request_id: string }>(sql`
              select actor_kind, request_id from audit_log
               where entity_type = 'project' and action = 'update' and entity_id = ${projectA}
            `)
          ).rows,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actor_kind).toBe('system');
      expect(rows[0]?.request_id).toMatch(/^system:metatest:/);
    });
  });

  describe('puente de dueño (ensure-roles.sql)', () => {
    const bridge = 'public.app_transfer_rls_helper_function(regprocedure, boolean)';

    /** El mensaje de Postgres viaja en `cause`; el de Drizzle solo trae la consulta. */
    async function expectBridgeError(promise: Promise<unknown>, message: RegExp, label?: string) {
      const error = (await promise.then(
        () => null,
        (rejected: unknown) => rejected,
      )) as { cause?: { message?: string }; message?: string } | null;
      expect(error, label ?? 'debía rechazar').not.toBeNull();
      expect(error?.cause?.message ?? error?.message ?? '', label).toMatch(message);
    }

    async function saveDefinition(signature: string) {
      const [definition] = await catalog<{ def: string }>(
        sql`select pg_get_functiondef(${signature}::regprocedure) as def`,
      );
      const acl = await catalog<{ grantee: string }>(sql`
        select a.grantee::regrole::text as grantee
          from pg_proc p, aclexplode(p.proacl) a
         where p.oid = ${signature}::regprocedure and a.privilege_type = 'EXECUTE'
           and a.grantee <> p.proowner
      `);
      return { def: definition?.def ?? '', grantees: acl.map((row) => row.grantee) };
    }

    const give = (signature: string, toHelper: boolean) =>
      harness.ownerDb.execute(
        sql`select app_transfer_rls_helper_function(${signature}::regprocedure, ${toHelper})`,
      );

    it('es del superusuario, sin EXECUTE para PUBLIC, y solo app_owner puede llamarlo', async () => {
      const [owner] = await catalog<{ rolname: string; rolsuper: boolean }>(sql`
        select r.rolname, r.rolsuper from pg_proc p join pg_roles r on r.oid = p.proowner
         where p.oid = ${bridge}::regprocedure
      `);
      expect(owner?.rolsuper).toBe(true);
      const grantees = await catalog<{ grantee: string }>(sql`
        select case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as grantee
          from pg_proc p, aclexplode(p.proacl) a
         where p.oid = ${bridge}::regprocedure and a.privilege_type = 'EXECUTE'
           and a.grantee <> p.proowner
      `);
      expect(grantees.map((row) => row.grantee)).toEqual(['app_owner']);
      const [config] = await catalog<{ prosecdef: boolean; proconfig: string[] }>(
        sql`select prosecdef, proconfig from pg_proc where oid = ${bridge}::regprocedure`,
      );
      expect(config).toEqual({
        prosecdef: true,
        proconfig: ['search_path=pg_catalog, public, pg_temp'],
      });
    });

    it.each([
      ['app_login', () => harness.appPool],
      ['app_worker', () => harness.workerPool],
    ] as const)('%s no puede llamarlo', async (_name, pool) => {
      await expect(
        pool().query(
          "select app_transfer_rls_helper_function('app_is_privileged()'::regprocedure, false)",
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });

    it('rechaza una función fuera de la lista fija, aunque cumpla todo lo demás', async () => {
      await harness.ownerDb.execute(sql`
        create function public.app_extra() returns boolean
        language sql stable security definer set search_path = pg_catalog, public, pg_temp
        as 'select true'
      `);
      await harness.ownerDb.execute(sql`revoke all on function public.app_extra() from public`);
      await harness.ownerDb.execute(sql`grant execute on function public.app_extra() to app_user`);
      await expectBridgeError(give('public.app_extra()', true), /lista fija/);
      // Una variante de firma de una función de la lista tampoco pasa.
      await harness.ownerDb.execute(sql`
        create function public.app_is_privileged(extra text) returns boolean
        language sql stable security definer set search_path = pg_catalog, public, pg_temp
        as 'select true'
      `);
      await expectBridgeError(give('public.app_is_privileged(text)', true), /lista fija/);
      await harness.ownerDb.execute(sql`drop function public.app_extra()`);
      await harness.ownerDb.execute(sql`drop function public.app_is_privileged(text)`);
    });

    it('rechaza una función de la lista que no cumple cada condición del ADR, y la acepta cuando sí', async () => {
      // Se usa la que ninguna policy referencia: las demás no se pueden dropear
      // (y no hace falta: el cuerpo se corrige con CREATE OR REPLACE).
      const signature = 'public.app_has_assigned_project_access(uuid)';
      const header = 'create function public.app_has_assigned_project_access(p_project_id uuid)';
      const original = await saveDefinition(signature);
      // Devolverla a app_owner es el camino para corregir un cuerpo.
      await give(signature, false);

      const run = (statement: string) => harness.ownerDb.execute(sql.raw(statement));
      const redefine = async (body: string, extra: string | null = null) => {
        await run(`drop function ${signature}`);
        await run(body);
        await run(`revoke all on function ${signature} from public`);
        await run(`grant execute on function ${signature} to app_user`);
        if (extra) await run(extra);
      };
      const secdef = 'security definer set search_path = pg_catalog, public, pg_temp';

      const defects: Array<[string, string, RegExp]> = [
        [
          'sin SECURITY DEFINER',
          `${header} returns boolean language sql stable set search_path = pg_catalog, public, pg_temp as 'select true'`,
          /SECURITY DEFINER/,
        ],
        [
          'VOLATILE',
          `${header} returns boolean language sql volatile ${secdef} as 'select true'`,
          /STABLE/,
        ],
        [
          'sin search_path fijo',
          `${header} returns boolean language sql stable security definer as 'select true'`,
          /search_path/,
        ],
        [
          'el search_path anterior, sin pg_temp explícito',
          `${header} returns boolean language sql stable security definer set search_path = public, pg_catalog as 'select true'`,
          /search_path/,
        ],
        [
          'search_path con pg_temp pero en otro orden',
          `${header} returns boolean language sql stable security definer set search_path = public, pg_catalog, pg_temp as 'select true'`,
          /search_path/,
        ],
        [
          'search_path distinto',
          `${header} returns boolean language sql stable security definer set search_path = public as 'select true'`,
          /search_path/,
        ],
        [
          'devuelve text',
          `${header} returns text language sql stable ${secdef} as 'select ''x''::text'`,
          /boolean o setof uuid/,
        ],
        [
          'devuelve jsonb',
          `${header} returns jsonb language sql stable ${secdef} as 'select ''{}''::jsonb'`,
          /boolean o setof uuid/,
        ],
      ];
      for (const [label, body, message] of defects) {
        await redefine(body);
        await expectBridgeError(give(signature, true), message, label);
      }

      // PUBLIC con EXECUTE.
      await redefine(
        `${header} returns boolean language sql stable ${secdef} as 'select true'`,
        `grant execute on function ${signature} to public`,
      );
      await expectBridgeError(give(signature, true), /PUBLIC/, 'EXECUTE a PUBLIC');

      // Restaurada la definición real, el traspaso vuelve a andar.
      await run(`drop function ${signature}`);
      await run(original.def);
      await run(`revoke all on function ${signature} from public`);
      await run(`grant execute on function ${signature} to app_user`);
      await give(signature, true);
      const [owner] = await catalog<{ proowner: string }>(
        sql`select proowner::regrole::text as proowner from pg_proc where oid = ${signature}::regprocedure`,
      );
      expect(owner?.proowner).toBe('app_rls_helper');
      const restored = await saveDefinition(signature);
      expect(restored.grantees).toEqual(original.grantees);
    });

    it('no traspasa una función que ya no es de app_owner, ni devuelve una que no es del helper', async () => {
      await expectBridgeError(give('public.app_is_privileged()', true), /debe ser de app_owner/);
      await give('public.app_is_privileged()', false);
      await expectBridgeError(give('public.app_is_privileged()', false), /no es de app_rls_helper/);
      await give('public.app_is_privileged()', true);
    });

    it('una función que las policies referencian no se puede dropear: se corrige con CREATE OR REPLACE', async () => {
      await expect(
        harness.ownerDb.execute(sql`drop function public.app_is_privileged()`),
      ).rejects.toMatchObject({ cause: { code: '2BP01' } });
    });

    it('rechaza una función con el cuerpo en un lenguaje distinto de sql/plpgsql', async () => {
      // `c` no se puede crear sin superusuario; basta con verificar que la lista de
      // lenguajes está en el cuerpo del puente (la condición no se puede violar
      // desde app_owner, pero no debe desaparecer).
      const [bridgeBody] = await catalog<{ prosrc: string }>(
        sql`select prosrc from pg_proc where oid = ${bridge}::regprocedure`,
      );
      expect(bridgeBody?.prosrc).toContain("language_name not in ('sql', 'plpgsql')");
    });
  });
});
