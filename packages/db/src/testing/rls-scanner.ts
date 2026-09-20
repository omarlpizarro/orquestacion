import { sql } from 'drizzle-orm';
import type { Db } from '../client.js';
import type { Tx } from '../transaction.js';

export type ScannerExecutor = Pick<Db | Tx, 'execute'>;

export type TenantIsolationViolationCode =
  | 'RLS_NOT_ENABLED'
  | 'RLS_NOT_FORCED'
  | 'NO_USING_CLAUSE'
  | 'NO_WITH_CHECK_CLAUSE'
  | 'OWNED_BY_APP_ROLE';

export interface TenantIsolationViolation {
  table: string;
  code: TenantIsolationViolationCode;
}

interface TableRow extends Record<string, unknown> {
  table_name: string;
  rls_enabled: boolean;
  rls_forced: boolean;
  owner: string;
  has_using_clause: boolean;
  has_with_check_clause: boolean;
}

/**
 * Recorre `public` buscando toda tabla con `organization_id` y verifica que
 * el aislamiento de tenant esté completo. Recibe un ejecutor de Drizzle
 * (db o tx) en vez de abrir su propia conexión, para poder ver tablas de
 * prueba creadas dentro de una transacción todavía sin commitear
 * (CLAUDE.md §10, meta-test de `rls-scanner.integration.spec.ts`).
 */
export async function scanTenantTables(
  executor: ScannerExecutor,
): Promise<TenantIsolationViolation[]> {
  const result = await executor.execute<TableRow>(sql`
    select
      c.relname as table_name,
      c.relrowsecurity as rls_enabled,
      c.relforcerowsecurity as rls_forced,
      pg_get_userbyid(c.relowner) as owner,
      exists (
        select 1 from pg_policies p
        where p.schemaname = 'public' and p.tablename = c.relname
          and p.qual ilike '%app.current_org%'
      ) as has_using_clause,
      exists (
        select 1 from pg_policies p
        where p.schemaname = 'public' and p.tablename = c.relname
          and p.with_check ilike '%app.current_org%'
      ) as has_with_check_clause
    from information_schema.columns col
    join pg_class c
      on c.relname = col.table_name and c.relkind = 'r'
    join pg_namespace n
      on n.oid = c.relnamespace and n.nspname = col.table_schema
    where col.table_schema = 'public'
      and col.column_name = 'organization_id'
  `);

  const violations: TenantIsolationViolation[] = [];

  for (const row of result.rows) {
    const table = row.table_name;

    if (!row.rls_enabled) {
      violations.push({ table, code: 'RLS_NOT_ENABLED' });
      // Sin RLS habilitado el resto de las verificaciones no aplica.
      continue;
    }
    if (!row.rls_forced) {
      violations.push({ table, code: 'RLS_NOT_FORCED' });
    }
    if (!row.has_using_clause) {
      violations.push({ table, code: 'NO_USING_CLAUSE' });
    }
    if (!row.has_with_check_clause) {
      violations.push({ table, code: 'NO_WITH_CHECK_CLAUSE' });
    }
    if (row.owner === 'app_user' || row.owner === 'app_login') {
      violations.push({ table, code: 'OWNED_BY_APP_ROLE' });
    }
  }

  return violations;
}
