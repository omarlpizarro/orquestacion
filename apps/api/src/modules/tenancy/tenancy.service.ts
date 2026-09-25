import { Injectable } from '@nestjs/common';
import type { Tx } from '@orq/db';
import { sql } from 'drizzle-orm';

export interface ResolveTimezoneParams {
  organizationId: string;
  siteId: string | null;
}

/**
 * Único punto por el que otro módulo llega a `site`/`organization_profile`
 * (CLAUDE.md §5): `projects` necesita la zona horaria del sitio de una
 * tarea para convertir fechas planificadas a UTC (ADR-008), pero no puede
 * tocar el esquema de `tenancy` directamente. SQL crudo, no el query
 * builder de Drizzle: ningún módulo importa `packages/db/src/schema/` de
 * otro módulo (regla dura 5), y las tablas de Drizzle son la fuente para
 * generar migraciones, no para armar consultas cruzando módulos.
 */
@Injectable()
export class TenancyService {
  async resolveTimezone(tx: Tx, params: ResolveTimezoneParams): Promise<string> {
    if (params.siteId) {
      const result = await tx.execute<{ timezone: string }>(sql`
        select timezone from site
        where id = ${params.siteId} and organization_id = ${params.organizationId}
      `);
      if (result.rows[0]) return result.rows[0].timezone;
    }

    const result = await tx.execute<{ timezone: string }>(sql`
      select timezone from organization_profile where organization_id = ${params.organizationId}
    `);
    // `organization_profile.timezone` tiene default de columna: si la fila
    // existe (siempre debería, se crea junto con la organización), esto no
    // es null. Si no existe la fila, es un dato de setup faltante, no un
    // caso de negocio a modelar acá.
    if (!result.rows[0]) {
      throw new Error(
        `organization_profile inexistente para organización ${params.organizationId}`,
      );
    }
    return result.rows[0].timezone;
  }
}
