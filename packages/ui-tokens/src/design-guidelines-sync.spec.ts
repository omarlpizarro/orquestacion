import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { darkColors, lightColors } from './colors.js';
import { darkStatusColors, lightStatusColors, TASK_STATUSES, taskStatusLabels } from './status.js';

/**
 * docs/design-guidelines.md y este paquete dicen lo mismo, y los dos se pueden editar. Este test
 * lee las tablas de la guía (secciones 2.1 y 3) y las compara con los tokens: si alguien cambia un
 * color en un lado y no en el otro, falla acá, con el nombre del token.
 */
const guide = readFileSync(
  fileURLToPath(new URL('../../../docs/design-guidelines.md', import.meta.url)),
  'utf8',
);

/** `surface-2` → `surface2`, `on-primary` → `onPrimary`, `text-2` → `text2`. */
function toTokenKey(guideName: string): string {
  return guideName.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

/** Las filas de la tabla bajo un encabezado, como celdas ya sin las comillas invertidas. */
function tableRows(heading: string): string[][] {
  const start = guide.indexOf(heading);
  if (start < 0) throw new Error(`La guía ya no tiene la sección "${heading}"`);
  const rest = guide.slice(start + heading.length);
  const rows: string[][] = [];
  let started = false;
  for (const line of rest.split('\n')) {
    if (line.startsWith('|')) {
      started = true;
      rows.push(
        line
          .split('|')
          .slice(1, -1)
          .map((cell) => cell.trim().replaceAll('`', '')),
      );
    } else if (started) {
      break;
    }
  }
  // Fuera el encabezado y la línea de guiones.
  return rows.slice(2);
}

describe('la guía de diseño y los tokens dicen lo mismo', () => {
  it('colores base (sección 2.1)', () => {
    const rows = tableRows('### 2.1 Tokens base');
    expect(rows.length).toBeGreaterThanOrEqual(14);
    const guideKeys: string[] = [];
    for (const [name, light, dark] of rows) {
      const key = toTokenKey(name as string);
      guideKeys.push(key);
      expect(lightColors[key as keyof typeof lightColors], `claro · ${name}`).toBe(light);
      expect(darkColors[key as keyof typeof darkColors], `oscuro · ${name}`).toBe(dark);
    }
    // Y al revés: no hay un token que la guía no documente.
    expect(guideKeys.sort()).toEqual(Object.keys(lightColors).sort());
  });

  it('estados de tarea (sección 3)', () => {
    const rows = tableRows('## 3. Estados de tarea');
    const statusByLabel = Object.fromEntries(
      TASK_STATUSES.map((status) => [taskStatusLabels[status], status]),
    );
    expect(rows).toHaveLength(TASK_STATUSES.length);
    for (const [label, , light, dark] of rows) {
      const status = statusByLabel[label as string];
      expect(status, `La guía tiene un estado "${label}" que los tokens no conocen`).toBeDefined();
      if (!status) continue;
      const [lightText, lightBg] = (light as string).split(' / ');
      const [darkText, darkBg] = (dark as string).split(' / ');
      expect(lightStatusColors[status], `claro · ${label}`).toEqual({
        text: lightText,
        bg: lightBg,
      });
      expect(darkStatusColors[status], `oscuro · ${label}`).toEqual({ text: darkText, bg: darkBg });
    }
  });
});
