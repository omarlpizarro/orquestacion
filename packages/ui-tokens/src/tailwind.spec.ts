import { describe, expect, it } from 'vitest';
import { darkColors, lightColors } from './colors.js';
import { toKebab } from './css.js';
import { SPACING_SCALE } from './scale.js';
import { darkStatusColors, lightStatusColors } from './status.js';
import { toTailwindTheme } from './tailwind.js';
import { FONT_WEIGHTS, typography } from './typography.js';

const css = toTailwindTheme();

/** Las declaraciones `--nombre: valor;` de un bloque que empieza en `header {`. */
function variablesOf(header: string): Record<string, string> {
  const start = css.indexOf(`${header} {`);
  if (start < 0) throw new Error(`No hay un bloque ${header}`);
  // Los bloques no se anidan salvo el @media, que se lee entero.
  let depth = 0;
  let end = start;
  for (let i = css.indexOf('{', start); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') depth -= 1;
    if (depth === 0) {
      end = i;
      break;
    }
  }
  const out: Record<string, string> = {};
  for (const match of css.slice(start, end).matchAll(/(--[a-z0-9*-]+):\s*([^;]+);/g)) {
    out[match[1] as string] = (match[2] as string).trim();
  }
  return out;
}

describe('toTailwindTheme', () => {
  const theme = variablesOf('@theme static');

  it('anula el tema por defecto de Tailwind en lo que la guía define, ANTES de declarar los tokens', () => {
    const resets = [
      '--color-*',
      '--spacing',
      '--spacing-*',
      '--radius-*',
      '--text-*',
      '--font-*',
      '--font-weight-*',
      '--leading-*',
      '--tracking-*',
      '--shadow-*',
      '--blur-*',
      '--animate-*',
    ];
    for (const namespace of resets) {
      expect(theme[namespace], namespace).toBe('initial');
      // Un reset después de una declaración la borraría.
      expect(css.indexOf(`${namespace}: initial`), namespace).toBeLessThan(
        css.indexOf('--font-sans:'),
      );
    }
  });

  it('no tiene ninguna referencia var(): sin ciclos, todo son valores literales', () => {
    expect(css).not.toContain('var(');
  });

  it('los colores del modo claro son los del tema, con los nombres de las clases de Tailwind', () => {
    for (const [name, value] of Object.entries(lightColors)) {
      expect(theme[`--color-${toKebab(name)}`], name).toBe(value);
    }
    for (const [status, colors] of Object.entries(lightStatusColors)) {
      expect(theme[`--color-status-${toKebab(status)}-text`], status).toBe(colors.text);
      expect(theme[`--color-status-${toKebab(status)}-bg`], status).toBe(colors.bg);
    }
  });

  it.each([':root:not([data-theme="light"])', ':root[data-theme="dark"]'])(
    'el modo oscuro sobreescribe las MISMAS variables (%s)',
    (selector) => {
      const block = variablesOf(selector);
      for (const [name, value] of Object.entries(darkColors)) {
        expect(block[`--color-${toKebab(name)}`], name).toBe(value);
      }
      for (const [status, colors] of Object.entries(darkStatusColors)) {
        expect(block[`--color-status-${toKebab(status)}-text`], status).toBe(colors.text);
        expect(block[`--color-status-${toKebab(status)}-bg`], status).toBe(colors.bg);
      }
      const lightNames = Object.keys(theme).filter(
        (n) => n.startsWith('--color-') && n !== '--color-*',
      );
      expect(
        Object.keys(block)
          .filter((n) => n.startsWith('--color-'))
          .sort(),
      ).toEqual(lightNames.sort());
    },
  );

  it('el modo oscuro sigue al sistema, salvo que el ajuste manual fuerce el claro', () => {
    expect(css).toContain('@media (prefers-color-scheme: dark) {');
    expect(css).toContain(':root:not([data-theme="light"]) {');
    expect(css).toContain(':root[data-theme="dark"] {');
  });

  it('espaciado: solo la escala (el número es el valor en px) y las medidas con nombre', () => {
    const spacingKeys = Object.keys(theme).filter((n) => /^--spacing-[a-z0-9-]+$/.test(n));
    const numeric = spacingKeys
      .filter((n) => /^--spacing-\d+$/.test(n))
      .map((n) => Number(n.slice(10)));
    expect(numeric.sort((a, b) => a - b)).toEqual([...SPACING_SCALE]);
    for (const step of SPACING_SCALE) expect(theme[`--spacing-${step}`]).toBe(`${step}px`);
    expect(theme['--spacing-touch']).toBe('44px');
    expect(theme['--spacing-control']).toBe('48px');
    expect(theme['--spacing-nav']).toBe('64px');
    expect(theme['--spacing-icon-chip']).toBe('15px');
  });

  it('tipografía: un tamaño, un peso y un interlineado por rol', () => {
    for (const [role, spec] of Object.entries(typography)) {
      const base = `--text-${toKebab(role)}`;
      expect(theme[base], role).toBe(`${spec.size}px`);
      expect(theme[`${base}--font-weight`], role).toBe(String(spec.weight));
      expect(theme[`${base}--line-height`], role).toBe(String(spec.lineHeight));
    }
    expect(theme['--text-label--letter-spacing']).toBe('0.06em');
  });

  it('solo los cuatro pesos de la familia empaquetada', () => {
    const weights = Object.entries(theme)
      .filter(([name]) => /^--font-weight-[a-z]+$/.test(name))
      .map(([, value]) => Number(value));
    expect(weights.sort()).toEqual([...FONT_WEIGHTS]);
  });

  it('las animaciones por defecto duran lo que la guía permite como máximo', () => {
    expect(theme['--default-transition-duration']).toBe('200ms');
  });

  it('es determinista (el archivo de dist/ sale de esta misma función)', () => {
    expect(toTailwindTheme()).toBe(css);
  });
});
