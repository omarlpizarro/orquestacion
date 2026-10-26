import { describe, expect, it } from 'vitest';
import { darkColors, lightColors } from './colors.js';
import { contrastRatio, isHexColor, MIN_TEXT_CONTRAST } from './contrast.js';
import {
  darkStatusColors,
  lightStatusColors,
  overdue,
  TASK_STATUSES,
  taskStatusIcons,
  taskStatusLabels,
} from './status.js';

const modes = [
  ['claro', lightStatusColors, lightColors],
  ['oscuro', darkStatusColors, darkColors],
] as const;

describe('estados de tarea', () => {
  it('son los seis de la API, y cada uno tiene color en los dos modos, ícono y texto', () => {
    expect(TASK_STATUSES).toEqual([
      'pending',
      'in_progress',
      'blocked',
      'in_review',
      'done',
      'cancelled',
    ]);
    for (const status of TASK_STATUSES) {
      expect(lightStatusColors[status], status).toBeDefined();
      expect(darkStatusColors[status], status).toBeDefined();
      expect(taskStatusIcons[status], status).toBeTruthy();
      expect(taskStatusLabels[status], status).toBeTruthy();
    }
  });

  it('un estado se muestra siempre con ícono y texto: no hay dos estados con el mismo ícono ni el mismo texto', () => {
    expect(new Set(Object.values(taskStatusIcons)).size).toBe(TASK_STATUSES.length);
    expect(new Set(Object.values(taskStatusLabels)).size).toBe(TASK_STATUSES.length);
  });

  it.each(modes)('todo color del modo %s es #RRGGBB en mayúsculas', (_modo, status) => {
    for (const colors of Object.values(status)) {
      expect(isHexColor(colors.text)).toBe(true);
      expect(isHexColor(colors.bg)).toBe(true);
    }
  });

  describe.each(modes)('contraste del modo %s', (_modo, status, base) => {
    it.each(TASK_STATUSES)('%s: el texto cumple 4.5:1 sobre el fondo de su chip', (name) => {
      expect(contrastRatio(status[name].text, status[name].bg)).toBeGreaterThanOrEqual(
        MIN_TEXT_CONTRAST,
      );
    });

    it.each(TASK_STATUSES)(
      '%s: el texto cumple 4.5:1 también sobre `surface` (hora y motivo fuera del chip)',
      (name) => {
        expect(contrastRatio(status[name].text, base.surface)).toBeGreaterThanOrEqual(
          MIN_TEXT_CONTRAST,
        );
      },
    );
  });

  it('"vencida" no es un estado: usa el color de Bloqueada con ícono de reloj', () => {
    expect(TASK_STATUSES).not.toContain('overdue');
    expect(overdue.colorFrom).toBe('blocked');
    expect(overdue.icon).toBe('clock');
  });
});
