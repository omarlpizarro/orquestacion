import { describe, expect, it } from 'vitest';
import type { OrgRole } from '../../../shared/auth/org-role.js';
import { InvalidTaskStatusTransitionError } from './errors/invalid-task-status-transition.error.js';
import { ReasonRequiredError } from './errors/reason-required.error.js';
import { TaskStatusTransitionForbiddenError } from './errors/task-status-transition-forbidden.error.js';
import { TaskStatusTransitionRequiresAssigneeError } from './errors/task-status-transition-requires-assignee.error.js';
import {
  findTaskStatusTransition,
  isExcludedFromComplianceKpis,
  isTerminalTaskStatus,
  type ReasonKind,
  resolveTaskStatusTransition as resolveStrict,
  type TaskStatus,
  type TaskStatusTransitionRequest,
} from './task-status-transitions.js';

/**
 * `hasFullProjectAccess` e `isUnassigned` son obligatorios en la firma real (un
 * llamador que los olvide no compila). Las matrices de roles/estados de
 * abajo no hablan del acceso al proyecto, así que los fijan en el caso neutro:
 * con acceso completo y con alguien asignado. Se prueba en su propia matriz.
 */
function resolveTaskStatusTransition(
  request: Omit<TaskStatusTransitionRequest, 'hasFullProjectAccess' | 'isUnassigned'> &
    Partial<Pick<TaskStatusTransitionRequest, 'hasFullProjectAccess' | 'isUnassigned'>>,
) {
  return resolveStrict({ hasFullProjectAccess: true, isUnassigned: false, ...request });
}

const ALL_STATUSES: readonly TaskStatus[] = [
  'pending',
  'in_progress',
  'blocked',
  'in_review',
  'done',
  'cancelled',
];
const ALL_ROLES: readonly OrgRole[] = ['owner', 'director', 'manager', 'operator'];
const MANAGEMENT_ROLES: readonly OrgRole[] = ['owner', 'director', 'manager'];

interface ExpectedTransition {
  readonly roles: readonly OrgRole[];
  readonly reason?: ReasonKind;
}

/**
 * Fuente de verdad independiente de `TASK_STATUS_TRANSITIONS`: si el test
 * solo comparara contra la tabla que exporta el propio módulo, un error de
 * tipeo en la tabla pasaría siempre — el test tiene que conocer la matriz de
 * memoria, no leerla del código que valida.
 */
const EXPECTED_TRANSITIONS: Record<TaskStatus, Partial<Record<TaskStatus, ExpectedTransition>>> = {
  pending: {
    in_progress: { roles: ALL_ROLES },
    blocked: { roles: ALL_ROLES, reason: 'block_report' },
    cancelled: { roles: MANAGEMENT_ROLES },
  },
  in_progress: {
    blocked: { roles: ALL_ROLES, reason: 'block_report' },
    in_review: { roles: ALL_ROLES },
    done: { roles: ALL_ROLES },
    cancelled: { roles: MANAGEMENT_ROLES },
  },
  blocked: {
    in_progress: { roles: ALL_ROLES },
    cancelled: { roles: MANAGEMENT_ROLES },
  },
  in_review: {
    in_progress: { roles: MANAGEMENT_ROLES },
    done: { roles: MANAGEMENT_ROLES },
    cancelled: { roles: MANAGEMENT_ROLES },
  },
  done: {
    in_progress: { roles: MANAGEMENT_ROLES, reason: 'reopen' },
  },
  cancelled: {},
};

function expectedTransitionFor(from: TaskStatus, to: TaskStatus): ExpectedTransition | undefined {
  return EXPECTED_TRANSITIONS[from][to];
}

describe('resolveTaskStatusTransition — matriz completa', () => {
  for (const from of ALL_STATUSES) {
    for (const to of ALL_STATUSES) {
      for (const role of ALL_ROLES) {
        const expected = expectedTransitionFor(from, to);
        const roleIsAllowed = expected?.roles.includes(role) ?? false;
        // `operator` siempre viaja asignado en esta matriz: la restricción
        // de asignación se prueba aparte, no acá — mezclarla obligaría a
        // duplicar cada caso de `operator` una vez con y otra sin
        // asignación.
        const isAssignee = role === 'operator' ? true : undefined;
        const reason = expected?.reason ? 'Motivo de prueba' : undefined;

        it(`${from} -> ${to} con rol ${role}${expected ? (roleIsAllowed ? ' permite' : ' rechaza por rol') : ' rechaza por transición inexistente'}`, () => {
          if (!expected) {
            expect(() =>
              resolveTaskStatusTransition({ from, to, role, isAssignee, reason }),
            ).toThrow(InvalidTaskStatusTransitionError);
            return;
          }
          if (!roleIsAllowed) {
            expect(() =>
              resolveTaskStatusTransition({ from, to, role, isAssignee, reason }),
            ).toThrow(TaskStatusTransitionForbiddenError);
            return;
          }
          const transition = resolveTaskStatusTransition({ from, to, role, isAssignee, reason });
          expect(transition.from).toBe(from);
          expect(transition.to).toBe(to);
        });
      }
    }
  }
});

describe('findTaskStatusTransition', () => {
  it('devuelve undefined para cualquier transición que no está en la tabla', () => {
    expect(findTaskStatusTransition('cancelled', 'pending')).toBeUndefined();
    expect(findTaskStatusTransition('pending', 'pending')).toBeUndefined();
    expect(findTaskStatusTransition('pending', 'done')).toBeUndefined();
    expect(findTaskStatusTransition('done', 'blocked')).toBeUndefined();
  });
});

describe('estados terminales', () => {
  it('solo cancelled es terminal (ADR-012: done se puede reabrir)', () => {
    expect(isTerminalTaskStatus('cancelled')).toBe(true);
    expect(isTerminalTaskStatus('done')).toBe(false);
  });

  it('pending, in_progress, blocked e in_review no son terminales', () => {
    expect(isTerminalTaskStatus('pending')).toBe(false);
    expect(isTerminalTaskStatus('in_progress')).toBe(false);
    expect(isTerminalTaskStatus('blocked')).toBe(false);
    expect(isTerminalTaskStatus('in_review')).toBe(false);
  });

  it('ningún estado terminal tiene transiciones salientes en la matriz esperada', () => {
    for (const status of ALL_STATUSES) {
      if (!isTerminalTaskStatus(status)) continue;
      expect(Object.keys(EXPECTED_TRANSITIONS[status])).toHaveLength(0);
    }
  });
});

describe('regla fija: cancelled queda fuera de los KPIs de cumplimiento', () => {
  it('cancelled está excluido', () => {
    expect(isExcludedFromComplianceKpis('cancelled')).toBe(true);
  });

  it('ningún otro estado está excluido, ni siquiera done', () => {
    for (const status of ALL_STATUSES) {
      if (status === 'cancelled') continue;
      expect(isExcludedFromComplianceKpis(status)).toBe(false);
    }
  });
});

describe('permiso por asignación: operator solo transiciona sus propias tareas', () => {
  it('rechaza a operator sin isAssignee, aunque el rol tenga permiso para la transición', () => {
    expect(() =>
      resolveTaskStatusTransition({ from: 'pending', to: 'in_progress', role: 'operator' }),
    ).toThrow(TaskStatusTransitionRequiresAssigneeError);
  });

  it('rechaza a operator con isAssignee explícitamente false', () => {
    expect(() =>
      resolveTaskStatusTransition({
        from: 'pending',
        to: 'in_progress',
        role: 'operator',
        isAssignee: false,
      }),
    ).toThrow(TaskStatusTransitionRequiresAssigneeError);
  });

  it('acepta a operator asignado', () => {
    const transition = resolveTaskStatusTransition({
      from: 'pending',
      to: 'in_progress',
      role: 'operator',
      isAssignee: true,
    });
    expect(transition.to).toBe('in_progress');
  });

  it('no le aplica a los roles de gerencia: no están limitados a "sus" tareas', () => {
    for (const role of MANAGEMENT_ROLES) {
      const transition = resolveTaskStatusTransition({ from: 'pending', to: 'in_progress', role });
      expect(transition.to).toBe('in_progress');
    }
  });

  it('la transición inexistente rechaza antes que la falta de asignación', () => {
    // pending -> done no existe: un operator sin isAssignee tiene que ver
    // el error de transición inválida, no el de "no sos el asignado" (que
    // implicaría, incorrectamente, que la transición sí existe).
    expect(() =>
      resolveTaskStatusTransition({ from: 'pending', to: 'done', role: 'operator' }),
    ).toThrow(InvalidTaskStatusTransitionError);
  });

  it('el rol se valida antes que la asignación: in_review -> done rechaza a operator por rol, no por asignación', () => {
    // operator no está en `allowedRoles` de in_review -> done en absoluto:
    // tiene que rechazar por rol (403 distinto), no confundirse con "no es
    // el asignado" aunque el resultado HTTP sea el mismo 403.
    expect(() =>
      resolveTaskStatusTransition({
        from: 'in_review',
        to: 'done',
        role: 'operator',
        isAssignee: true,
      }),
    ).toThrow(TaskStatusTransitionForbiddenError);
  });
});

/**
 * Matriz rol × acceso completo al proyecto × estado de la asignación × destino.
 * Cada fila es una decisión de negocio escrita a mano (CLAUDE.md §7, ADR-017),
 * no derivada de la implementación: `pending → in_progress` y
 * `pending → blocked` existen para todos los roles, así que lo único que puede
 * rechazar es la asignación. Quien no ve la tarea ni llega acá: recibe 404.
 */
type Assignment = 'assigned_to_requester' | 'unassigned' | 'assigned_to_other';
type Outcome = 'allowed' | 'requires_assignee';

const SCOPE_MATRIX: ReadonlyArray<{
  role: OrgRole;
  fullAccess: boolean;
  assignment: Assignment;
  toInProgress: Outcome;
  toBlocked: Outcome;
}> = [
  // owner y director: acceso completo siempre (app_is_privileged).
  ...('owner director'.split(' ') as OrgRole[]).flatMap((role) =>
    ('assigned_to_requester unassigned assigned_to_other'.split(' ') as Assignment[]).map(
      (assignment) => ({
        role,
        fullAccess: true,
        assignment,
        toInProgress: 'allowed' as const,
        toBlocked: 'allowed' as const,
      }),
    ),
  ),
  // manager con acceso completo: sin restricción de asignación.
  {
    role: 'manager',
    fullAccess: true,
    assignment: 'assigned_to_requester',
    toInProgress: 'allowed',
    toBlocked: 'allowed',
  },
  {
    role: 'manager',
    fullAccess: true,
    assignment: 'unassigned',
    toInProgress: 'allowed',
    toBlocked: 'allowed',
  },
  {
    role: 'manager',
    fullAccess: true,
    assignment: 'assigned_to_other',
    toInProgress: 'allowed',
    toBlocked: 'allowed',
  },
  // manager solo asignado: el dominio no lo limita más (la base ya le oculta lo que no es suyo).
  {
    role: 'manager',
    fullAccess: false,
    assignment: 'assigned_to_requester',
    toInProgress: 'allowed',
    toBlocked: 'allowed',
  },
  {
    role: 'manager',
    fullAccess: false,
    assignment: 'unassigned',
    toInProgress: 'allowed',
    toBlocked: 'allowed',
  },
  {
    role: 'manager',
    fullAccess: false,
    assignment: 'assigned_to_other',
    toInProgress: 'allowed',
    toBlocked: 'allowed',
  },
  // operator con acceso completo: la propia sí; sin asignar solo → blocked; ajena nada.
  {
    role: 'operator',
    fullAccess: true,
    assignment: 'assigned_to_requester',
    toInProgress: 'allowed',
    toBlocked: 'allowed',
  },
  {
    role: 'operator',
    fullAccess: true,
    assignment: 'unassigned',
    toInProgress: 'requires_assignee',
    toBlocked: 'allowed',
  },
  {
    role: 'operator',
    fullAccess: true,
    assignment: 'assigned_to_other',
    toInProgress: 'requires_assignee',
    toBlocked: 'requires_assignee',
  },
  // operator solo asignado: únicamente la tarea que tiene asignada (ser el asignado alcanza).
  {
    role: 'operator',
    fullAccess: false,
    assignment: 'assigned_to_requester',
    toInProgress: 'allowed',
    toBlocked: 'allowed',
  },
  {
    role: 'operator',
    fullAccess: false,
    assignment: 'unassigned',
    toInProgress: 'requires_assignee',
    toBlocked: 'requires_assignee',
  },
  {
    role: 'operator',
    fullAccess: false,
    assignment: 'assigned_to_other',
    toInProgress: 'requires_assignee',
    toBlocked: 'requires_assignee',
  },
];

const OUTCOME_ERROR = {
  requires_assignee: TaskStatusTransitionRequiresAssigneeError,
} as const;

describe('acceso al proyecto: rol × acceso × asignación', () => {
  for (const row of SCOPE_MATRIX) {
    for (const [to, outcome] of [
      ['in_progress', row.toInProgress],
      ['blocked', row.toBlocked],
    ] as const) {
      it(`${row.role}, ${row.fullAccess ? 'con acceso completo' : 'solo asignado'}, tarea ${row.assignment}, pending -> ${to}: ${outcome}`, () => {
        const request = {
          from: 'pending',
          to,
          role: row.role,
          hasFullProjectAccess: row.fullAccess,
          isAssignee: row.assignment === 'assigned_to_requester',
          isUnassigned: row.assignment === 'unassigned',
          reason: 'Motivo de prueba',
        } as const;

        if (outcome === 'allowed') {
          expect(resolveStrict(request).to).toBe(to);
          return;
        }
        expect(() => resolveStrict(request)).toThrow(OUTCOME_ERROR[outcome]);
      });
    }
  }

  it('operator sin asignar con acceso: la excepción vale solo hacia blocked, desde in_progress también', () => {
    const base = { role: 'operator', hasFullProjectAccess: true, isUnassigned: true } as const;
    expect(
      resolveStrict({ ...base, from: 'in_progress', to: 'blocked', reason: 'Sin material' }).to,
    ).toBe('blocked');
    expect(() => resolveStrict({ ...base, from: 'in_progress', to: 'done' })).toThrow(
      TaskStatusTransitionRequiresAssigneeError,
    );
    expect(() => resolveStrict({ ...base, from: 'in_progress', to: 'in_review' })).toThrow(
      TaskStatusTransitionRequiresAssigneeError,
    );
  });

  it('operator sin asignar bloqueando sigue necesitando motivo', () => {
    expect(() =>
      resolveStrict({
        from: 'pending',
        to: 'blocked',
        role: 'operator',
        hasFullProjectAccess: true,
        isUnassigned: true,
      }),
    ).toThrow(ReasonRequiredError);
  });

  it('el dominio ya no corta por sitio: un manager sin acceso completo pasa a la matriz de roles', () => {
    const base = { role: 'manager', hasFullProjectAccess: false, isUnassigned: false } as const;
    expect(resolveStrict({ ...base, from: 'pending', to: 'in_progress' }).to).toBe('in_progress');
    // Y la matriz sigue mandando: una transición inexistente se rechaza igual.
    expect(() => resolveStrict({ ...base, from: 'pending', to: 'done' })).toThrow(
      InvalidTaskStatusTransitionError,
    );
  });
});

describe('regla fija: pasar a blocked exige motivo', () => {
  it('rechaza sin reason', () => {
    expect(() =>
      resolveTaskStatusTransition({
        from: 'in_progress',
        to: 'blocked',
        role: 'operator',
        isAssignee: true,
      }),
    ).toThrow(ReasonRequiredError);
  });

  it('rechaza con reason vacío o solo espacios', () => {
    expect(() =>
      resolveTaskStatusTransition({
        from: 'in_progress',
        to: 'blocked',
        role: 'operator',
        isAssignee: true,
        reason: '   ',
      }),
    ).toThrow(ReasonRequiredError);
  });

  it('acepta con un motivo real', () => {
    const transition = resolveTaskStatusTransition({
      from: 'in_progress',
      to: 'blocked',
      role: 'operator',
      isAssignee: true,
      reason: 'Falta el permiso municipal',
    });
    expect(transition.requiresReason).toBe('block_report');
  });

  it('devuelve el motivo recortado de espacios al borde, no el que mandó el caller tal cual', () => {
    const transition = resolveTaskStatusTransition({
      from: 'in_progress',
      to: 'blocked',
      role: 'operator',
      isAssignee: true,
      reason: '  Falta el permiso municipal  ',
    });
    expect(transition.reason).toBe('Falta el permiso municipal');
  });

  it('reason es null cuando la transición no exige motivo, aunque el caller mande uno', () => {
    const transition = resolveTaskStatusTransition({
      from: 'pending',
      to: 'in_progress',
      role: 'operator',
      isAssignee: true,
      reason: 'Un motivo que esta transición no pidió',
    });
    expect(transition.reason).toBeNull();
  });

  it('pending -> blocked (no se pudo ni empezar) también exige motivo', () => {
    expect(() =>
      resolveTaskStatusTransition({
        from: 'pending',
        to: 'blocked',
        role: 'operator',
        isAssignee: true,
      }),
    ).toThrow(ReasonRequiredError);

    const transition = resolveTaskStatusTransition({
      from: 'pending',
      to: 'blocked',
      role: 'operator',
      isAssignee: true,
      reason: 'No llegó el material',
    });
    expect(transition.requiresReason).toBe('block_report');
  });

  it('una transición inexistente hacia blocked rechaza por transición inválida, no por motivo faltante', () => {
    // in_review -> blocked no está en la tabla. Sin reason, el orden de
    // validación de `resolveTaskStatusTransition` (transición existe → rol
    // → asignación → motivo) tiene que devolver el error de transición
    // inválida, no el de motivo faltante, aunque las dos condiciones de
    // rechazo estén presentes.
    expect(() =>
      resolveTaskStatusTransition({ from: 'in_review', to: 'blocked', role: 'manager' }),
    ).toThrow(InvalidTaskStatusTransitionError);
  });
});

describe('regla fija: reabrir una tarea (done -> in_progress) exige motivo', () => {
  it('rechaza sin reason', () => {
    expect(() =>
      resolveTaskStatusTransition({ from: 'done', to: 'in_progress', role: 'manager' }),
    ).toThrow(ReasonRequiredError);
  });

  it('rechaza con reason vacío o solo espacios', () => {
    expect(() =>
      resolveTaskStatusTransition({
        from: 'done',
        to: 'in_progress',
        role: 'manager',
        reason: '   ',
      }),
    ).toThrow(ReasonRequiredError);
  });

  it('rechaza a operator, tenga o no motivo: solo MANAGEMENT_ROLES reabre', () => {
    expect(() =>
      resolveTaskStatusTransition({
        from: 'done',
        to: 'in_progress',
        role: 'operator',
        isAssignee: true,
        reason: 'Se cerró por error',
      }),
    ).toThrow(TaskStatusTransitionForbiddenError);
  });

  it('acepta con un motivo real, para cualquier rol de gerencia', () => {
    for (const role of MANAGEMENT_ROLES) {
      const transition = resolveTaskStatusTransition({
        from: 'done',
        to: 'in_progress',
        role,
        reason: 'Se cerró por error, falta terminar una parte',
      });
      expect(transition.requiresReason).toBe('reopen');
    }
  });
});

describe('quién exige motivo, y de qué tipo', () => {
  it('exactamente pending/in_progress -> blocked piden block_report', () => {
    for (const from of ALL_STATUSES) {
      const transition = findTaskStatusTransition(from, 'blocked');
      if (!transition) continue;
      expect(transition.requiresReason).toBe('block_report');
    }
  });

  it('exactamente done -> in_progress pide reopen', () => {
    expect(findTaskStatusTransition('done', 'in_progress')?.requiresReason).toBe('reopen');
  });

  it('ninguna otra transición exige motivo', () => {
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        if (to === 'blocked' || (from === 'done' && to === 'in_progress')) continue;
        const transition = findTaskStatusTransition(from, to);
        if (!transition) continue;
        expect(transition.requiresReason).toBeNull();
      }
    }
  });
});

describe('regla fija: pasar a done fija actual_end_at', () => {
  it('in_progress -> done y in_review -> done marcan setsActualEndAt', () => {
    expect(findTaskStatusTransition('in_progress', 'done')?.setsActualEndAt).toBe(true);
    expect(findTaskStatusTransition('in_review', 'done')?.setsActualEndAt).toBe(true);
  });

  it('ninguna transición que no sea hacia done marca setsActualEndAt', () => {
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        if (to === 'done') continue;
        const transition = findTaskStatusTransition(from, to);
        if (!transition) continue;
        expect(transition.setsActualEndAt).toBe(false);
      }
    }
  });

  it('resolveTaskStatusTransition no acepta actual_end_at del cliente: la firma de la request no tiene ese campo', () => {
    // Documenta la regla a nivel de tipos: `TaskStatusTransitionRequest` no
    // declara `actualEndAt`, así que no hay forma de que un handler que arme
    // la request a partir del body del cliente termine pasándolo de largo
    // hacia el dominio. Quien setea la hora real es el handler (PR
    // siguiente), leyendo `setsActualEndAt` y usando el reloj del servidor.
    const transition = resolveTaskStatusTransition({
      from: 'in_progress',
      to: 'done',
      role: 'operator',
      isAssignee: true,
    });
    expect(transition.setsActualEndAt).toBe(true);
  });
});

describe('regla nueva (ADR-012): reabrir limpia actual_end_at', () => {
  it('solo done -> in_progress marca clearsActualEndAt', () => {
    expect(findTaskStatusTransition('done', 'in_progress')?.clearsActualEndAt).toBe(true);
  });

  it('ninguna otra transición marca clearsActualEndAt, incluida in_progress -> done', () => {
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        if (from === 'done' && to === 'in_progress') continue;
        const transition = findTaskStatusTransition(from, to);
        if (!transition) continue;
        expect(transition.clearsActualEndAt).toBe(false);
      }
    }
  });
});
