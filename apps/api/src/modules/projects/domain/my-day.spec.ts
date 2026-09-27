import { describe, expect, it } from 'vitest';
import { classifyMyDayTask, sortMyDayTasks } from './my-day.js';

const dayWindow = { startUtc: '2026-09-29T03:00:00.000Z', endUtc: '2026-09-30T03:00:00.000Z' };
const nowUtc = '2026-09-29T12:00:00.000Z';

function task(overrides: {
  status: string;
  plannedStartAt?: string | null;
  plannedEndAt?: string | null;
}) {
  return {
    status: overrides.status,
    plannedStartAt: overrides.plannedStartAt ?? null,
    plannedEndAt: overrides.plannedEndAt ?? null,
  };
}

describe('classifyMyDayTask', () => {
  it('bloqueada y vencida a la vez cae en blocked, con isOverdue true', () => {
    const result = classifyMyDayTask(
      task({ status: 'blocked', plannedEndAt: '2026-09-20T00:00:00.000Z' }),
      { nowUtc, dayWindow },
    );
    expect(result).toEqual({ section: 'blocked', isOverdue: true });
  });

  it('bloqueada sin vencer cae en blocked con isOverdue false', () => {
    const result = classifyMyDayTask(task({ status: 'blocked' }), { nowUtc, dayWindow });
    expect(result).toEqual({ section: 'blocked', isOverdue: false });
  });

  it('vencida (no bloqueada) cae en overdue', () => {
    const result = classifyMyDayTask(
      task({ status: 'in_progress', plannedEndAt: '2026-09-20T00:00:00.000Z' }),
      { nowUtc, dayWindow },
    );
    expect(result).toEqual({ section: 'overdue', isOverdue: true });
  });

  it('in_progress sin ninguna fecha entra en today', () => {
    const result = classifyMyDayTask(task({ status: 'in_progress' }), { nowUtc, dayWindow });
    expect(result).toEqual({ section: 'today', isOverdue: false });
  });

  it('pending sin ninguna fecha entra en undated', () => {
    const result = classifyMyDayTask(task({ status: 'pending' }), { nowUtc, dayWindow });
    expect(result).toEqual({ section: 'undated', isOverdue: false });
  });

  it('toca hoy solo con planned_start_at (sin planned_end_at)', () => {
    const result = classifyMyDayTask(
      task({ status: 'pending', plannedStartAt: '2026-09-29T10:00:00.000Z' }),
      { nowUtc, dayWindow },
    );
    expect(result).toEqual({ section: 'today', isOverdue: false });
  });

  it('toca hoy solo con planned_end_at (sin planned_start_at), y no está vencida', () => {
    const result = classifyMyDayTask(
      task({ status: 'pending', plannedEndAt: '2026-09-29T20:00:00.000Z' }),
      { nowUtc, dayWindow },
    );
    expect(result).toEqual({ section: 'today', isOverdue: false });
  });

  it('un rango que cruza hoy sin empezar ni terminar hoy también toca hoy', () => {
    const result = classifyMyDayTask(
      task({
        status: 'in_progress',
        plannedStartAt: '2026-09-28T00:00:00.000Z',
        plannedEndAt: '2026-10-01T00:00:00.000Z',
      }),
      { nowUtc, dayWindow },
    );
    expect(result).toEqual({ section: 'today', isOverdue: false });
  });

  it('in_review con fecha futura que no toca hoy no cumple ninguna condición y explota', () => {
    expect(() =>
      classifyMyDayTask(task({ status: 'in_review', plannedStartAt: '2026-10-05T00:00:00.000Z' }), {
        nowUtc,
        dayWindow,
      }),
    ).toThrow(/desincronizaron/);
  });
});

describe('sortMyDayTasks', () => {
  function classified(
    section: 'overdue' | 'today' | 'blocked' | 'undated',
    fields: Partial<{
      criticality: string;
      plannedStartAt: string | null;
      plannedEndAt: string | null;
      createdAt: string;
      isOverdue: boolean;
    }> = {},
  ) {
    return {
      section,
      isOverdue: fields.isOverdue ?? false,
      criticality: fields.criticality ?? 'normal',
      plannedStartAt: fields.plannedStartAt ?? null,
      plannedEndAt: fields.plannedEndAt ?? null,
      createdAt: fields.createdAt ?? '2026-09-01T00:00:00.000Z',
    };
  }

  it('agrupa por sección en orden vencidas, hoy, bloqueadas, sin fecha', () => {
    const undated = { ...classified('undated'), id: 'undated' };
    const blocked = { ...classified('blocked'), id: 'blocked' };
    const today = { ...classified('today'), id: 'today' };
    const overdue = { ...classified('overdue'), id: 'overdue' };

    const result = sortMyDayTasks([undated, blocked, today, overdue]);

    expect(result.map((t) => t.id)).toEqual(['overdue', 'today', 'blocked', 'undated']);
  });

  it('dentro de vencidas, ordena por criticidad descendente y después planned_end_at', () => {
    const lowLate = {
      ...classified('overdue', { criticality: 'low', plannedEndAt: '2026-09-25T00:00:00.000Z' }),
      id: 'low-late',
    };
    const criticalEarly = {
      ...classified('overdue', {
        criticality: 'critical',
        plannedEndAt: '2026-09-27T00:00:00.000Z',
      }),
      id: 'critical-early',
    };
    const criticalEarlier = {
      ...classified('overdue', {
        criticality: 'critical',
        plannedEndAt: '2026-09-20T00:00:00.000Z',
      }),
      id: 'critical-earlier',
    };

    const result = sortMyDayTasks([lowLate, criticalEarly, criticalEarlier]);

    expect(result.map((t) => t.id)).toEqual(['critical-earlier', 'critical-early', 'low-late']);
  });

  it('dentro de hoy, ordena por planned_start_at con nulls al final', () => {
    const noStart = { ...classified('today', { plannedStartAt: null }), id: 'no-start' };
    const later = {
      ...classified('today', { plannedStartAt: '2026-09-29T18:00:00.000Z' }),
      id: 'later',
    };
    const earlier = {
      ...classified('today', { plannedStartAt: '2026-09-29T08:00:00.000Z' }),
      id: 'earlier',
    };

    const result = sortMyDayTasks([noStart, later, earlier]);

    expect(result.map((t) => t.id)).toEqual(['earlier', 'later', 'no-start']);
  });
});
