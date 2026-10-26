import { describe, expect, it } from 'vitest';
import { staticVariables, themeVariables, toCssVariables, toKebab } from './css.js';
import { darkTheme, lightTheme } from './theme.js';

describe('toKebab', () => {
  it.each([
    ['surface2', 'surface-2'],
    ['textDisabled', 'text-disabled'],
    ['borderStrong', 'border-strong'],
    ['onPrimary', 'on-primary'],
    ['in_progress', 'in-progress'],
    ['screenMarginMobile', 'screen-margin-mobile'],
    ['bg', 'bg'],
  ])('%s → %s', (input, expected) => {
    expect(toKebab(input)).toBe(expected);
  });
});

/** El cuerpo de un bloque `selector { ... }` como `{ nombre: valor }`. */
function variablesOf(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`No hay un bloque ${selector}`);
  const end = css.indexOf('}', start);
  const body = css.slice(start + selector.length + 2, end);
  const out: Record<string, string> = {};
  for (const match of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
    out[match[1] as string] = (match[2] as string).trim();
  }
  return out;
}

describe('toCssVariables', () => {
  const css = toCssVariables();

  it('el modo claro es el de :root y trae los colores de la guía', () => {
    const root = variablesOf(css, ':root');
    expect(root['--color-bg']).toBe('#F5F5F6');
    expect(root['--color-primary']).toBe('#1F4FD1');
    expect(root['--color-border-strong']).toBe('#80848E');
    expect(root['--color-surface-2']).toBe('#EEEFF1');
  });

  it('el oscuro sigue al sistema, salvo que el ajuste manual fuerce el claro', () => {
    expect(css).toContain('@media (prefers-color-scheme: dark) {');
    expect(css).toContain(':root:not([data-theme="light"]) {');
    const auto = variablesOf(css, ':root:not([data-theme="light"])');
    expect(auto['--color-bg']).toBe('#101114');
  });

  it('el ajuste manual a oscuro fija los mismos valores que el automático', () => {
    expect(variablesOf(css, ':root[data-theme="dark"]')).toEqual(
      variablesOf(css, ':root:not([data-theme="light"])'),
    );
  });

  it('cada variable de color que cambia con el modo existe en el claro y en el oscuro', () => {
    const lightNames = themeVariables(lightTheme)
      .map(([name]) => name)
      .sort();
    const darkNames = themeVariables(darkTheme)
      .map(([name]) => name)
      .sort();
    expect(darkNames).toEqual(lightNames);
    const dark = variablesOf(css, ':root[data-theme="dark"]');
    const root = variablesOf(css, ':root');
    for (const name of lightNames) {
      expect(root[name], name).toBeDefined();
      expect(dark[name], name).toBeDefined();
    }
  });

  it('el bloque oscuro solo redefine lo que depende del modo; el resto es estático', () => {
    const dark = variablesOf(css, ':root[data-theme="dark"]');
    const staticNames = new Set(staticVariables().map(([name]) => name));
    for (const name of Object.keys(dark)) expect(staticNames.has(name), name).toBe(false);
  });

  it('los seis estados tienen texto y fondo en cada modo', () => {
    const root = variablesOf(css, ':root');
    for (const status of ['pending', 'in-progress', 'blocked', 'in-review', 'done', 'cancelled']) {
      expect(root[`--status-${status}-text`], status).toMatch(/^#[0-9A-F]{6}$/);
      expect(root[`--status-${status}-bg`], status).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  it('las variables estáticas traen espaciado, radios, táctil y tipografía en px', () => {
    const root = variablesOf(css, ':root');
    expect(root['--space-16']).toBe('16px');
    expect(root['--space-48']).toBe('48px');
    expect(root['--radius-card']).toBe('14px');
    expect(root['--touch-min-target']).toBe('44px');
    expect(root['--text-screen-title-size']).toBe('28px');
    expect(root['--text-label-tracking']).toBe('0.06em');
    expect(root['--font-sans']).toMatch(/^Manrope,/);
  });

  it('no hay dos variables con el mismo nombre dentro de un bloque', () => {
    for (const entries of [
      staticVariables(),
      themeVariables(lightTheme),
      themeVariables(darkTheme),
    ]) {
      const names = entries.map(([name]) => name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('es determinista (el archivo de dist/ sale de esta misma función)', () => {
    expect(toCssVariables()).toBe(css);
  });
});
