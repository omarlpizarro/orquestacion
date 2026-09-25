import { describe, expect, it } from 'vitest';
import { BlockReasonRequiredError } from './errors/block-reason-required.error.js';
import { InvalidTaskStatusTransitionError } from './errors/invalid-task-status-transition.error.js';
import { TaskStatusTransitionForbiddenError } from './errors/task-status-transition-forbidden.error.js';
import {
  findTaskStatusTransition,
  isExcludedFromComplianceKpis,
  isTerminalTaskStatus,
  type OrgRole,
  resolveTaskStatusTransition,
  type TaskStatus,
} from './task-status-transitions.js';

const ALL_STATUSES: readonly TaskStatus[] = [
  'pending',
  'in_progress',
  'blocked',
  'in_review',
  'done',
  'cancelled',
];
const ALL_ROLES: readonly OrgRole[] = ['owner', 'director', 'manager', 'operator'];

/**
 * Fuente de verdad independiente de `TASK_STATUS_TRANSITIONS`: si el test
 * solo comparara contra la tabla que exporta el propio módulo, un error de
 * tipeo en la tabla pasaría siempre — el test tiene que conocer la matriz de
 * memoria, no leerla del código que valida.
 */
const EXPECTED_TRANSITIONS: Record<TaskStatus, Partial<Record<TaskStatus, readonly OrgRole[]>>> = {
  pending: {
    in_progress: ALL_ROLES,
    cancelled: ['owner', 'director', 'manager'],
  },
  in_progress: {
    blocked: ALL_ROLES,
    in_review: ALL_ROLES,
    done: ALL_ROLES,
    cancelled: ['owner', 'director', 'manager'],
  },
  blocked: {
    in_progress: ALL_ROLES,
    cancelled: ['owner', 'director', 'manager'],
  },
  in_review: {
    in_progress: ['owner', 'director', 'manager'],
    done: ['owner', 'director', 'manager'],
    cancelled: ['owner', 'director', 'manager'],
  },
  done: {},
  cancelled: {},
};

function allowedRolesFor(from: TaskStatus, to: TaskStatus): readonly OrgRole[] | undefined {
  return EXPECTED_TRANSITIONS[from][to];
}

describe('resolveTaskStatusTransition — matriz completa', () => {
  for (const from of ALL_STATUSES) {
    for (const to of ALL_STATUSES) {
      for (const role of ALL_ROLES) {
        const allowedRoles = allowedRolesFor(from, to);
        const roleIsAllowed = allowedRoles?.includes(role) ?? false;
        const blockReason = to === 'blocked' ? 'Falta un insumo' : undefined;

        it(`${from} -> ${to} con rol ${role}${allowedRoles ? (roleIsAllowed ? ' permite' : ' rechaza por rol') : ' rechaza por transición inexistente'}`, () => {
          if (!allowedRoles) {
            expect(() => resolveTaskStatusTransition({ from, to, role, blockReason })).toThrow(
              InvalidTaskStatusTransitionError,
            );
            return;
          }
          if (!roleIsAllowed) {
            expect(() => resolveTaskStatusTransition({ from, to, role, blockReason })).toThrow(
              TaskStatusTransitionForbiddenError,
            );
            return;
          }
          const transition = resolveTaskStatusTransition({ from, to, role, blockReason });
          expect(transition.from).toBe(from);
          expect(transition.to).toBe(to);
        });
      }
    }
  }
});

describe('findTaskStatusTransition', () => {
  it('devuelve undefined para cualquier transición que no está en la tabla', () => {
    expect(findTaskStatusTransition('done', 'in_progress')).toBeUndefined();
    expect(findTaskStatusTransition('cancelled', 'pending')).toBeUndefined();
    expect(findTaskStatusTransition('pending', 'pending')).toBeUndefined();
    expect(findTaskStatusTransition('pending', 'done')).toBeUndefined();
  });
});

describe('estados terminales', () => {
  it('done y cancelled son terminales', () => {
    expect(isTerminalTaskStatus('done')).toBe(true);
    expect(isTerminalTaskStatus('cancelled')).toBe(true);
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

describe('regla fija: pasar a blocked exige motivo', () => {
  it('rechaza sin blockReason', () => {
    expect(() =>
      resolveTaskStatusTransition({ from: 'in_progress', to: 'blocked', role: 'operator' }),
    ).toThrow(BlockReasonRequiredError);
  });

  it('rechaza con blockReason vacío o solo espacios', () => {
    expect(() =>
      resolveTaskStatusTransition({
        from: 'in_progress',
        to: 'blocked',
        role: 'operator',
        blockReason: '   ',
      }),
    ).toThrow(BlockReasonRequiredError);
  });

  it('acepta con un motivo real', () => {
    const transition = resolveTaskStatusTransition({
      from: 'in_progress',
      to: 'blocked',
      role: 'operator',
      blockReason: 'Falta el permiso municipal',
    });
    expect(transition.requiresBlockReport).toBe(true);
  });

  it('una transición inexistente hacia blocked rechaza por transición inválida, no por motivo faltante', () => {
    // pending -> blocked no está en la tabla (bloquear supone haber
    // arrancado). Sin blockReason, el orden de validación de
    // `resolveTaskStatusTransition` (transición existe → rol → motivo)
    // tiene que devolver el error de transición inválida, no el de motivo
    // faltante, aunque las dos condiciones de rechazo estén presentes.
    expect(() =>
      resolveTaskStatusTransition({ from: 'pending', to: 'blocked', role: 'operator' }),
    ).toThrow(InvalidTaskStatusTransitionError);
  });

  it('ninguna otra transición exige motivo', () => {
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        if (to === 'blocked') continue;
        const transition = findTaskStatusTransition(from, to);
        if (!transition) continue;
        expect(transition.requiresBlockReport).toBe(false);
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
    });
    expect(transition.setsActualEndAt).toBe(true);
  });
});
