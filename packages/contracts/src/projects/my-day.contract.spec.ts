import { describe, expect, it } from 'vitest';
import { myDayInputSchema, myDaySectionSchema, myDayTaskOutputSchema } from './my-day.contract.js';

describe('myDayInputSchema', () => {
  it('acepta sin time_zone', () => {
    expect(myDayInputSchema.safeParse({}).success).toBe(true);
  });

  it('acepta una zona IANA válida', () => {
    expect(
      myDayInputSchema.safeParse({ time_zone: 'America/Argentina/Buenos_Aires' }).success,
    ).toBe(true);
  });

  it('rechaza una zona horaria que no existe', () => {
    expect(myDayInputSchema.safeParse({ time_zone: 'No/Existe' }).success).toBe(false);
  });

  it('rechaza un offset en vez de una zona IANA', () => {
    expect(myDayInputSchema.safeParse({ time_zone: 'UTC-3' }).success).toBe(false);
  });
});

describe('myDayTaskOutputSchema', () => {
  const base = {
    id: '01945f4e-0000-7000-8000-000000000002',
    project_id: '01945f4e-0000-7000-8000-000000000001',
    parent_task_id: null,
    depth: 1,
    title: 'Excavar cimientos',
    description: null,
    status: 'blocked' as const,
    criticality: 'normal' as const,
    assignee_member_id: '01945f4e-0000-7000-8000-000000000003',
    planned_start_at: null,
    planned_end_at: null,
    is_milestone: false,
    ack_required: false,
    position: 'a0',
    version: 1,
    created_at: '2026-09-20T00:00:00.000Z',
  };

  it('acepta una tarea bloqueada y vencida a la vez', () => {
    const result = myDayTaskOutputSchema.safeParse({
      ...base,
      section: 'blocked',
      is_overdue: true,
    });
    expect(result.success).toBe(true);
  });

  it('acepta cada valor del enum de sección', () => {
    for (const section of myDaySectionSchema.options) {
      expect(myDayTaskOutputSchema.safeParse({ ...base, section, is_overdue: false }).success).toBe(
        true,
      );
    }
  });

  it('rechaza una sección que no existe', () => {
    const result = myDayTaskOutputSchema.safeParse({
      ...base,
      section: 'overdue_and_blocked',
      is_overdue: true,
    });
    expect(result.success).toBe(false);
  });
});
