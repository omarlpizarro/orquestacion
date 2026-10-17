import { blockedDedupeKey, newId } from '@orq/contracts';
import {
  insertAuthMember,
  insertAuthOrganization,
  type PostgresHarness,
  startPostgresHarness,
} from '@orq/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OUTBOX_MAX_ATTEMPTS, processNotificationOutbox } from './notifications-outbox.js';

/**
 * La bandeja de avisos (ADR-019) con la identidad de producción (`app_worker`) y Postgres real.
 * La carga se hace con el superusuario del contenedor (no está sujeto a RLS): lo que se prueba
 * es lo que el worker lee y escribe con sus propios permisos.
 */
describe('notification_outbox: audiencia de un bloqueo', () => {
  let harness: PostgresHarness;
  const suffix = newId().replaceAll('-', '');
  const org = `org_a_${suffix}`;
  const otherOrg = `org_b_${suffix}`;
  const member = (name: string) => `${name}_${suffix}`;

  const siteS1 = newId();
  const siteS2 = newId();
  const projectR = newId(); // reservado, sitio S1
  const projectT = newId(); // abierto al sitio S1
  const taskR = newId(); // en R, con responsable
  const taskR2 = newId(); // en R, sin responsable
  const taskT = newId(); // en T, sin responsable

  const q = (text: string, values: unknown[] = []) => harness.superuserPool.query(text, values);

  async function addMember(name: string, role: string, organizationId = org) {
    await insertAuthMember(harness.ownerDb, { organizationId, memberId: member(name), role });
  }

  async function addTask(id: string, projectId: string, assignee: string | null, title: string) {
    await q(
      `insert into task (id, organization_id, created_by_member_id, project_id, title, position, assignee_member_id)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [id, org, member('creator'), projectId, title, `a${id.slice(0, 8)}`, assignee],
    );
  }

  async function addUpdate(taskId: string, kind: string, by: string, body: string | null) {
    const id = newId();
    await q(
      `insert into task_update (id, organization_id, created_by_member_id, task_id, kind, body)
       values ($1, $2, $3, $4, $5, $6)`,
      [id, org, member(by), taskId, kind, body],
    );
    return id;
  }

  async function enqueue(entityId: string, kind = 'task.blocked') {
    const id = newId();
    await q(
      `insert into notification_outbox (id, organization_id, created_by_member_id, kind, entity_id)
       values ($1, $2, $3, $4, $5)`,
      [id, org, member('creator'), kind, entityId],
    );
    return id;
  }

  const run = () => processNotificationOutbox(harness.workerDb, newId());

  const recipientsOf = async (taskUpdateId: string): Promise<string[]> => {
    const { rows } = await q(
      `select recipient_member_id from notification
        where organization_id = $1 and dedupe_key like $2 order by 1`,
      [org, `task_update:${taskUpdateId}:blocked:%`],
    );
    return rows.map((row) => row.recipient_member_id as string).sort();
  };
  const names = (...values: string[]) => values.map(member).sort();

  const outboxRow = async (id: string) =>
    (
      await q(
        'select processed_at, attempts, last_attempt_at, last_error from notification_outbox where id = $1',
        [id],
      )
    ).rows[0] as {
      processed_at: string | null;
      attempts: number;
      last_attempt_at: string | null;
      last_error: string | null;
    };

  beforeAll(async () => {
    harness = await startPostgresHarness();
    await insertAuthOrganization(harness.ownerDb, { id: org });
    await insertAuthOrganization(harness.ownerDb, { id: otherOrg });

    await addMember('owner', 'owner'); // privilegiado, NO miembro explícito
    await addMember('director', 'director'); // idem
    await addMember('ownerMember', 'owner'); // privilegiado Y miembro explícito de R
    await addMember('creator', 'manager'); // miembro explícito de R y T
    await addMember('mgrSite', 'manager'); // manager con acceso al sitio S1
    await addMember('mgrOther', 'manager'); // manager con acceso a otro sitio (S2)
    await addMember('explicitOp', 'operator'); // miembro explícito de R
    await addMember('assignee', 'operator'); // responsable de taskR, no miembro
    await addMember('siteOp', 'operator'); // operario con acceso al sitio S1
    await addMember('outsider', 'operator'); // ajeno a todo
    await addMember('foreign', 'owner', otherOrg); // de otra organización

    for (const [id, name] of [
      [siteS1, 'S1'],
      [siteS2, 'S2'],
    ] as const) {
      await q(
        `insert into site (id, organization_id, name, timezone) values ($1, $2, $3, 'America/Argentina/Buenos_Aires')`,
        [id, org, name],
      );
    }
    for (const [name, site] of [
      ['mgrSite', siteS1],
      ['mgrOther', siteS2],
      ['siteOp', siteS1],
    ] as const) {
      await q(
        'insert into member_site_access (organization_id, member_id, site_id) values ($1, $2, $3)',
        [org, member(name), site],
      );
    }

    for (const [id, code, visibility] of [
      [projectR, 'PRY-R', 'reserved'],
      [projectT, 'PRY-T', 'site'],
    ] as const) {
      await q(
        `insert into project (id, organization_id, site_id, created_by_member_id, code, name, visibility)
         values ($1, $2, $3, $4, $5, $5, $6)`,
        [id, org, siteS1, member('creator'), code, visibility],
      );
    }
    const explicit: Array<[string, string]> = [
      [projectR, member('creator')],
      [projectR, member('explicitOp')],
      [projectR, member('ownerMember')],
      // Figura en `project_member` pero ya no es miembro de la organización.
      [projectR, `removed_${suffix}`],
      [projectT, member('creator')],
    ];
    for (const [projectId, memberId] of explicit) {
      await q(
        `insert into project_member (id, organization_id, created_by_member_id, project_id, member_id)
         values ($1, $2, $3, $4, $5)`,
        [newId(), org, member('owner'), projectId, memberId],
      );
    }

    await addTask(taskR, projectR, member('assignee'), 'Excavar');
    await addTask(taskR2, projectR, null, 'Hormigonar');
    await addTask(taskT, projectT, null, 'Revocar');
  });

  afterAll(async () => {
    await harness.stop();
  });

  describe('proyecto reservado: solo quien lo ve', () => {
    it('lo reporta el operario "solo asignado": avisa a los miembros explícitos y a nadie más', async () => {
      const update = await addUpdate(
        taskR,
        'block_report',
        'assignee',
        'Falta el permiso municipal',
      );
      const outbox = await enqueue(update);

      const summary = await run();

      expect(summary.failed).toBe(0);
      // Los miembros explícitos que siguen en la organización. NO: el manager del sitio, el
      // owner y el director que no son miembros, el operario del sitio, el ajeno, el miembro
      // que ya no es de la organización, y quien reportó.
      expect(await recipientsOf(update)).toEqual(names('creator', 'explicitOp', 'ownerMember'));
      expect((await outboxRow(outbox)).processed_at).not.toBeNull();
    });

    it('owner y director solo reciben si son miembros explícitos', async () => {
      const update = await addUpdate(taskR, 'block_report', 'assignee', 'Otro motivo');
      await enqueue(update);

      await run();

      const recipients = await recipientsOf(update);
      expect(recipients).toContain(member('ownerMember'));
      expect(recipients).not.toContain(member('owner'));
      expect(recipients).not.toContain(member('director'));
    });

    it('el manager del sitio, un owner no miembro y un operario ajeno NO reciben; un miembro explícito SÍ', async () => {
      const update = await addUpdate(taskR2, 'block_report', 'explicitOp', 'Sin acceso a la obra');
      await enqueue(update);

      await run();

      const recipients = await recipientsOf(update);
      for (const excluded of ['mgrSite', 'mgrOther', 'owner', 'director', 'siteOp', 'outsider']) {
        expect(recipients, excluded).not.toContain(member(excluded));
      }
      expect(recipients).toContain(member('creator'));
      // Quien reportó no se avisa a sí mismo.
      expect(recipients).not.toContain(member('explicitOp'));
    });

    it('avisa también al responsable de la tarea, si no es quien reportó', async () => {
      const update = await addUpdate(taskR, 'block_report', 'explicitOp', 'Se rompió la bomba');
      await enqueue(update);

      await run();

      expect(await recipientsOf(update)).toEqual(names('assignee', 'creator', 'ownerMember'));
    });
  });

  describe('proyecto abierto al sitio', () => {
    it('avisa a los managers de ese sitio y a los miembros explícitos; no a otros roles ni a otros sitios', async () => {
      const update = await addUpdate(taskT, 'block_report', 'siteOp', 'Falta andamio');
      await enqueue(update);

      await run();

      // Managers con acceso a S1 (mgrSite) y miembros explícitos (creator). NO: el manager de
      // S2, el operario del sitio que reportó (ni otros operarios), owner ni director.
      expect(await recipientsOf(update)).toEqual(names('creator', 'mgrSite'));
    });
  });

  describe('contenido del aviso', () => {
    it('lleva el título de la tarea, quién reportó y un extracto del motivo', async () => {
      const update = await addUpdate(
        taskR2,
        'block_report',
        'explicitOp',
        'Sin   acceso\na la obra',
      );
      await enqueue(update);

      await run();

      const { rows } = await q(
        `select payload, template_key, channel, status, created_by_member_id, task_id, project_id, sent_at
           from notification where organization_id = $1 and dedupe_key = $2`,
        [org, blockedDedupeKey({ taskUpdateId: update, recipientMemberId: member('creator') })],
      );
      expect(rows[0]).toMatchObject({
        payload: {
          task_title: 'Hormigonar',
          actor_member_id: member('explicitOp'),
          reason_preview: 'Sin acceso a la obra',
        },
        template_key: 'task.blocked',
        channel: 'inapp',
        status: 'delivered',
        created_by_member_id: member('explicitOp'),
        task_id: taskR2,
        project_id: projectR,
      });
      expect(rows[0]?.sent_at).not.toBeNull();
    });
  });

  describe('idempotencia', () => {
    it('procesar de nuevo no duplica avisos ni vuelve a tomar la fila', async () => {
      const update = await addUpdate(taskR2, 'block_report', 'explicitOp', 'Motivo');
      await enqueue(update);

      await run();
      const first = await recipientsOf(update);
      const again = await run();

      expect(again.found).toBe(0);
      expect(await recipientsOf(update)).toEqual(first);
    });

    it('si la API ya le avisó al responsable (misma dedupe_key), no recibe un segundo aviso', async () => {
      const update = await addUpdate(taskR, 'block_report', 'explicitOp', 'Motivo directo');
      await q(
        `insert into notification (id, organization_id, created_by_member_id, recipient_member_id,
                                   task_id, project_id, template_key, channel, payload, status, dedupe_key)
         values ($1, $2, $3, $4, $5, $6, 'task.blocked', 'inapp', '{}', 'delivered', $7)`,
        [
          newId(),
          org,
          member('explicitOp'),
          member('assignee'),
          taskR,
          projectR,
          blockedDedupeKey({ taskUpdateId: update, recipientMemberId: member('assignee') }),
        ],
      );
      await enqueue(update);

      await run();

      const { rows } = await q(
        'select count(*)::int as n from notification where organization_id = $1 and recipient_member_id = $2 and dedupe_key like $3',
        [org, member('assignee'), `task_update:${update}:blocked:%`],
      );
      expect(rows[0]?.n).toBe(1);
    });

    it('encolar dos veces la misma novedad deja una sola fila en la bandeja', async () => {
      const update = await addUpdate(taskR2, 'block_report', 'explicitOp', 'Motivo');
      await enqueue(update);
      await expect(enqueue(update)).rejects.toMatchObject({ code: '23505' });
    });
  });

  describe('no confía en la fila', () => {
    it('una fila que apunta a una novedad que no es un bloqueo se procesa sin avisar a nadie', async () => {
      const comment = await addUpdate(taskR, 'comment', 'explicitOp', 'solo un comentario');
      const outbox = await enqueue(comment);

      await run();

      expect(await recipientsOf(comment)).toEqual([]);
      expect((await outboxRow(outbox)).processed_at).not.toBeNull();
    });

    it('una novedad inexistente no avisa a nadie y no se reintenta para siempre', async () => {
      const outbox = await enqueue(newId());

      await run();

      expect((await outboxRow(outbox)).processed_at).not.toBeNull();
    });

    it('una tarea borrada no avisa a nadie', async () => {
      const task = newId();
      await addTask(task, projectR, null, 'Se borra');
      const update = await addUpdate(task, 'block_report', 'explicitOp', 'Motivo');
      await q('update task set deleted_at = now() where id = $1', [task]);
      const outbox = await enqueue(update);

      await run();

      expect(await recipientsOf(update)).toEqual([]);
      expect((await outboxRow(outbox)).processed_at).not.toBeNull();
    });
  });

  describe('fallas', () => {
    it('un tipo desconocido falla: deja registrado el intento y el error, y la fila queda pendiente', async () => {
      const outbox = await enqueue(newId(), 'task.inventado');

      const summary = await run();

      expect(summary.failed).toBeGreaterThanOrEqual(1);
      const row = await outboxRow(outbox);
      expect(row.processed_at).toBeNull();
      expect(row.attempts).toBe(1);
      expect(row.last_attempt_at).not.toBeNull();
      expect(row.last_error).toMatch(/task\.inventado/);
    });

    it('tras un fallo espera antes de reintentar (no a ritmo de sondeo)', async () => {
      const outbox = await enqueue(newId(), 'task.inventado');
      await run();

      await run();

      expect((await outboxRow(outbox)).attempts).toBe(1);
    });

    it('cuando vence la espera se reintenta, y suma otro intento', async () => {
      const outbox = await enqueue(newId(), 'task.inventado');
      await run();
      await q(
        `update notification_outbox set last_attempt_at = now() - interval '1 hour' where id = $1`,
        [outbox],
      );

      await run();

      expect((await outboxRow(outbox)).attempts).toBe(2);
    });

    it('agotados los intentos deja de reintentarse y sigue pendiente a la vista', async () => {
      const outbox = await enqueue(newId(), 'task.inventado');
      await q(
        `update notification_outbox set attempts = $2, last_attempt_at = now() - interval '1 day' where id = $1`,
        [outbox, OUTBOX_MAX_ATTEMPTS],
      );

      await run();

      const row = await outboxRow(outbox);
      expect(row.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
      expect(row.processed_at).toBeNull();
    });

    it('un fallo de una fila no frena a las demás', async () => {
      const failing = await enqueue(newId(), 'task.inventado');
      const update = await addUpdate(taskR2, 'block_report', 'explicitOp', 'Motivo');
      const good = await enqueue(update);

      await run();

      expect((await outboxRow(failing)).processed_at).toBeNull();
      expect((await outboxRow(good)).processed_at).not.toBeNull();
    });
  });

  describe('varios workers a la vez', () => {
    it('dos vueltas simultáneas procesan la fila una sola vez (SKIP LOCKED)', async () => {
      const update = await addUpdate(taskR2, 'block_report', 'explicitOp', 'Motivo concurrente');
      await enqueue(update);

      const [first, second] = await Promise.all([run(), run()]);

      expect(first.processed + second.processed).toBe(1);
      expect(first.notifications + second.notifications).toBe((await recipientsOf(update)).length);
    });
  });
});
