import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { newId } from '@orq/contracts';
import { type Db, withTenantTransaction } from '@orq/db';
import { type PostgresHarness, startPostgresHarness } from '@orq/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { localDayWindow } from '../src/modules/projects/domain/local-day-window.js';
import { AUTH } from '../src/shared/auth/auth.tokens.js';
import type { Auth } from '../src/shared/auth/build-auth.js';
import { mountBetterAuth } from '../src/shared/auth/mount-better-auth.js';
import { DB } from '../src/shared/database/database.tokens.js';
import { resolveTenantIdentity } from '../src/shared/request-context/request-context.middleware.js';
import { addMemberWithRole } from './helpers/add-member-with-role.js';
import { signUpAndCreateOrg } from './helpers/sign-up-and-create-org.js';

/**
 * "Mi Día" (docs/phase-2-brief.md): las tareas se insertan directo por SQL,
 * no vía POST /projects/tasks — necesitamos control total sobre
 * planned_start_at/planned_end_at en UTC y sobre status (`blocked`, `done`)
 * sin pasar por la máquina de estados, que no es lo que este slice ejercita.
 */
describe('GET /projects/tasks/my-day (integración)', () => {
  let harness: PostgresHarness;
  let app: NestFastifyApplication;
  let auth: Auth;
  let db: Db;
  let organizationId: string;
  let memberId: string;
  let cookie: string;
  let projectId: string;

  beforeAll(async () => {
    harness = await startPostgresHarness();
    process.env.DATABASE_URL = harness.appConnectionUri;
    process.env.DATABASE_APP_ROLE = 'app_login';
    process.env.BETTER_AUTH_SECRET = 'test_secret_'.padEnd(32, 'x');
    process.env.BETTER_AUTH_URL = 'http://localhost:3000';

    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
      logger: false,
    });
    auth = app.get<Auth>(AUTH);
    db = app.get<Db>(DB);
    mountBetterAuth(app, auth);
    await app.init();

    const org = await signUpAndCreateOrg(app, 'Frigorífico del Sur');
    cookie = org.cookie;
    organizationId = org.organizationId;
    const tenant = await resolveTenantIdentity(auth, { cookie });
    if (!tenant) throw new Error('esperaba tenant resuelto tras crear la organización');
    memberId = tenant.memberId;

    // organization_profile.timezone default: America/Argentina/Buenos_Aires
    // (UTC-3) — mismo default que usa create-task.integration.spec.ts.
    await withTenantTransaction(db, { organizationId, memberId, requestId: newId() }, (tx) =>
      tx.execute(sql`
        insert into organization_profile (organization_id, industry)
        values (${organizationId}, 'agro')
      `),
    );

    projectId = newId();
    await withTenantTransaction(db, { organizationId, memberId, requestId: newId() }, (tx) =>
      tx.execute(sql`
        insert into project (id, organization_id, created_by_member_id, code, name)
        values (${projectId}, ${organizationId}, ${memberId}, 'PRY-1', 'Planta Norte')
      `),
    );
  });

  afterAll(async () => {
    await app.close();
    await harness.stop();
  });

  interface TaskFixture {
    assigneeMemberId: string;
    title: string;
    status?: string;
    criticality?: string;
    plannedStartAt?: string | null;
    plannedEndAt?: string | null;
  }

  async function insertTask(fixture: TaskFixture): Promise<string> {
    const id = newId();
    await withTenantTransaction(db, { organizationId, memberId, requestId: newId() }, (tx) =>
      tx.execute(sql`
        insert into task (
          id, organization_id, created_by_member_id, project_id,
          title, status, criticality, assignee_member_id,
          planned_start_at, planned_end_at, position
        ) values (
          ${id}, ${organizationId}, ${memberId}, ${projectId},
          ${fixture.title}, ${fixture.status ?? 'pending'}, ${fixture.criticality ?? 'normal'},
          ${fixture.assigneeMemberId}, ${fixture.plannedStartAt ?? null},
          ${fixture.plannedEndAt ?? null}, ${`a${id.slice(0, 8)}`}
        )
      `),
    );
    return id;
  }

  /** Filtra la respuesta a solo los IDs de este test, para no depender del estado que dejaron otros. */
  function pickTasks<T extends { id: string }>(tasks: T[], ids: readonly string[]): T[] {
    return tasks.filter((task) => ids.includes(task.id));
  }

  function getMyDay(requestCookie: string, timeZone?: string) {
    const query = timeZone ? `?time_zone=${encodeURIComponent(timeZone)}` : '';
    return app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: `/projects/tasks/my-day${query}`,
        headers: { cookie: requestCookie },
      });
  }

  it('trae vencidas, bloqueadas, de hoy y sin fecha; deja afuera futuras y done/cancelled', async () => {
    const overdue = await insertTask({
      assigneeMemberId: memberId,
      title: 'Vencida',
      status: 'in_progress',
      plannedEndAt: '2020-01-01T00:00:00.000Z',
    });
    const blockedAndOverdue = await insertTask({
      assigneeMemberId: memberId,
      title: 'Bloqueada y vencida',
      status: 'blocked',
      plannedEndAt: '2020-01-01T00:00:00.000Z',
    });
    const inProgressNoDates = await insertTask({
      assigneeMemberId: memberId,
      title: 'En curso sin fecha',
      status: 'in_progress',
    });
    const pendingNoDates = await insertTask({
      assigneeMemberId: memberId,
      title: 'Sin fecha',
      status: 'pending',
    });
    await insertTask({
      assigneeMemberId: memberId,
      title: 'Futura, no debería aparecer',
      status: 'pending',
      plannedStartAt: '2030-01-01T00:00:00.000Z',
    });
    await insertTask({
      assigneeMemberId: memberId,
      title: 'Terminada, no debería aparecer',
      status: 'done',
      plannedEndAt: '2020-01-01T00:00:00.000Z',
    });
    await insertTask({
      assigneeMemberId: memberId,
      title: 'Cancelada, no debería aparecer',
      status: 'cancelled',
      plannedEndAt: '2020-01-01T00:00:00.000Z',
    });

    const response = await getMyDay(cookie);

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{
      tasks: Array<{ id: string; section: string; is_overdue: boolean }>;
    }>();
    const byId = new Map(body.tasks.map((task) => [task.id, task]));

    expect(body.tasks).toHaveLength(4);
    expect(byId.get(overdue)).toMatchObject({ section: 'overdue', is_overdue: true });
    expect(byId.get(blockedAndOverdue)).toMatchObject({ section: 'blocked', is_overdue: true });
    expect(byId.get(inProgressNoDates)).toMatchObject({ section: 'today', is_overdue: false });
    expect(byId.get(pendingNoDates)).toMatchObject({ section: 'undated', is_overdue: false });

    // Orden de secciones: vencidas, hoy, bloqueadas, sin fecha.
    expect(body.tasks.map((task) => task.section)).toEqual([
      'overdue',
      'today',
      'blocked',
      'undated',
    ]);
  });

  it('usa la zona horaria del request en vez de la de la organización cuando viene', async () => {
    // organization_profile.timezone es America/Argentina/Buenos_Aires
    // (UTC-3) y ninguna de las dos zonas usa horario de verano, así que la
    // diferencia entre ellas es siempre exactamente 12hs — pero cuál mitad
    // del día de una cae afuera del día de la otra depende de en qué
    // momento exacto corre el test, así que se calcula acá con la misma
    // función de dominio en vez de asumir una fecha de calendario fija
    // (una fecha fija solo sería "hoy" el día en que alguien corriera esto).
    const otherTimeZone = 'Asia/Tokyo';
    const now = new Date();
    const orgWindow = localDayWindow(now, 'America/Argentina/Buenos_Aires');
    const otherWindow = localDayWindow(now, otherTimeZone);
    const orgStartMs = new Date(orgWindow.startUtc).getTime();
    const otherStartMs = new Date(otherWindow.startUtc).getTime();
    const otherEndMs = new Date(otherWindow.endUtc).getTime();
    // Instante dentro de la ventana de la organización pero fuera de la de
    // otherTimeZone: si la ventana ajena empieza después que la propia, el
    // borde de arranque de la propia ya queda afuera de la ajena; si empieza
    // antes, es el borde de cierre de la ajena el que todavía cae dentro de
    // la propia. Va en planned_start_at, no planned_end_at: ese borde puede
    // caer en el pasado según en qué mitad del día corra el test, y si
    // fuera planned_end_at, "en el pasado" la marcaría vencida — vencida no
    // depende de zona horaria (`planned_end_at < now()` a secas), así que
    // aparecería en las dos respuestas sin que eso probara nada sobre
    // time_zone.
    const targetMs = (otherStartMs > orgStartMs ? orgStartMs : otherEndMs) + 60_000;
    const plannedStartAt = new Date(targetMs).toISOString();

    const taskId = await insertTask({
      assigneeMemberId: memberId,
      title: 'Depende de la zona horaria de quien consulta',
      status: 'pending',
      plannedStartAt,
    });

    const withOrgTimezone = await getMyDay(cookie);
    const withTokyoTimezone = await getMyDay(cookie, otherTimeZone);

    const inOrgResult = withOrgTimezone
      .json<{ tasks: Array<{ id: string; section: string }> }>()
      .tasks.some((task) => task.id === taskId);
    const inTokyoResult = withTokyoTimezone
      .json<{ tasks: Array<{ id: string; section: string }> }>()
      .tasks.some((task) => task.id === taskId);

    expect(withOrgTimezone.statusCode, withOrgTimezone.body).toBe(200);
    expect(withTokyoTimezone.statusCode, withTokyoTimezone.body).toBe(200);
    expect(inOrgResult).toBe(true);
    expect(inTokyoResult).toBe(false);
  });

  it('responde BAD_REQUEST si time_zone no es una zona IANA válida', async () => {
    const response = await getMyDay(cookie, 'UTC-3');
    expect(response.statusCode).toBe(400);
  });

  it('no devuelve tareas asignadas a otro miembro de la misma organización', async () => {
    const other = await addMemberWithRole(app, auth, {
      organizationId,
      role: 'operator',
      label: 'Capataz Sur',
    });

    const onlyForOther = await insertTask({
      assigneeMemberId: other.memberId,
      title: 'Solo para el otro miembro',
      status: 'blocked',
    });

    const mine = await getMyDay(cookie);
    const theirs = await getMyDay(other.cookie);

    expect(mine.statusCode, mine.body).toBe(200);
    expect(theirs.statusCode, theirs.body).toBe(200);
    expect(
      mine.json<{ tasks: Array<{ id: string }> }>().tasks.some((t) => t.id === onlyForOther),
    ).toBe(false);
    expect(
      theirs.json<{ tasks: Array<{ id: string }> }>().tasks.some((t) => t.id === onlyForOther),
    ).toBe(true);
  });

  it('una tarea que vence en dos horas es "today" y no vencida; una con solo planned_start_at hoy también', async () => {
    // "En dos horas" acotado a lo que quede de hoy (zona de la
    // organización): si el test corriera a menos de dos horas de
    // medianoche, now + 2h ya sería mañana, y dejaría de probar lo mismo.
    const orgWindow = localDayWindow(new Date(), 'America/Argentina/Buenos_Aires');
    const twoHoursFromNow = Date.now() + 2 * 60 * 60 * 1000;
    const beforeTodayEnds = new Date(orgWindow.endUtc).getTime() - 60_000;
    const dueSoonAt = new Date(Math.min(twoHoursFromNow, beforeTodayEnds)).toISOString();

    const dueSoon = await insertTask({
      assigneeMemberId: memberId,
      title: 'Vence en dos horas',
      status: 'in_progress',
      plannedEndAt: dueSoonAt,
    });
    const startsToday = await insertTask({
      assigneeMemberId: memberId,
      title: 'Empieza hoy, sin fecha de fin',
      status: 'pending',
      plannedStartAt: new Date().toISOString(),
    });

    const response = await getMyDay(cookie);
    expect(response.statusCode, response.body).toBe(200);
    const byId = new Map(
      response
        .json<{ tasks: Array<{ id: string; section: string; is_overdue: boolean }> }>()
        .tasks.map((task) => [task.id, task]),
    );

    expect(byId.get(dueSoon)).toMatchObject({ section: 'today', is_overdue: false });
    expect(byId.get(startsToday)).toMatchObject({ section: 'today', is_overdue: false });
  });

  it('dentro de vencidas, ordena por criticidad descendente y después por planned_end_at', async () => {
    const lowLate = await insertTask({
      assigneeMemberId: memberId,
      title: 'Vencida, baja, más tarde',
      status: 'in_progress',
      criticality: 'low',
      plannedEndAt: '2020-01-25T00:00:00.000Z',
    });
    const criticalEarly = await insertTask({
      assigneeMemberId: memberId,
      title: 'Vencida, crítica, antes',
      status: 'in_progress',
      criticality: 'critical',
      plannedEndAt: '2020-01-20T00:00:00.000Z',
    });
    const criticalEarlier = await insertTask({
      assigneeMemberId: memberId,
      title: 'Vencida, crítica, mucho antes',
      status: 'in_progress',
      criticality: 'critical',
      plannedEndAt: '2020-01-10T00:00:00.000Z',
    });

    const response = await getMyDay(cookie);
    expect(response.statusCode, response.body).toBe(200);
    const ordered = pickTasks(response.json<{ tasks: Array<{ id: string }> }>().tasks, [
      lowLate,
      criticalEarly,
      criticalEarlier,
    ]);

    expect(ordered.map((task) => task.id)).toEqual([criticalEarlier, criticalEarly, lowLate]);
  });

  it('dentro de hoy, ordena por planned_start_at con nulls al final', async () => {
    // Mismo cuidado que en el test de "vence en dos horas": acotado a lo
    // que quede de hoy en la zona de la organización.
    const orgWindow = localDayWindow(new Date(), 'America/Argentina/Buenos_Aires');
    const oneHourFromNow = Date.now() + 60 * 60 * 1000;
    const beforeTodayEnds = new Date(orgWindow.endUtc).getTime() - 60_000;
    const laterAt = new Date(Math.min(oneHourFromNow, beforeTodayEnds)).toISOString();

    const noStart = await insertTask({
      assigneeMemberId: memberId,
      title: 'Hoy, en curso, sin ninguna fecha',
      status: 'in_progress',
    });
    const later = await insertTask({
      assigneeMemberId: memberId,
      title: 'Hoy, empieza más tarde',
      status: 'pending',
      plannedStartAt: laterAt,
    });
    const earlier = await insertTask({
      assigneeMemberId: memberId,
      title: 'Hoy, empieza antes',
      status: 'pending',
      plannedStartAt: new Date().toISOString(),
    });

    const response = await getMyDay(cookie);
    expect(response.statusCode, response.body).toBe(200);
    const ordered = pickTasks(response.json<{ tasks: Array<{ id: string }> }>().tasks, [
      noStart,
      later,
      earlier,
    ]);

    expect(ordered.map((task) => task.id)).toEqual([earlier, later, noStart]);
  });
});
