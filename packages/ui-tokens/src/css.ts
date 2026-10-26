import {
  borderWidth,
  focusRing,
  iconSizes,
  layout,
  motion,
  radii,
  SPACING_SCALE,
  touch,
} from './scale.js';
import { darkTheme, lightTheme, type Theme } from './theme.js';
import { FONT_STACK, typography } from './typography.js';

/**
 * Genera `tokens.css`: los tokens como variables CSS, que consumen la web (Tailwind las lee con
 * `@theme`) y, si hace falta, cualquier CSS. Es una función pura: el archivo de `dist/` y los tests
 * salen de acá, y nunca se edita a mano.
 *
 * Modo oscuro (docs/design-guidelines.md, sección 9): por defecto sigue la configuración del sistema
 * (`prefers-color-scheme`) y el atributo `data-theme` en `<html>` lo fuerza, para el ajuste manual
 * de Perfil. `data-theme="light"` fuerza el claro aunque el sistema esté en oscuro.
 */

/** `surface2` → `surface-2`, `textDisabled` → `text-disabled`, `in_progress` → `in-progress`. */
export function toKebab(name: string): string {
  return name
    .replace(/([a-z])([A-Z0-9])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase();
}

type Entries = Array<readonly [name: string, value: string]>;

/** Las variables que cambian con el modo: colores base y colores de estado. */
export function themeVariables(theme: Theme): Entries {
  const entries: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(theme.colors)) {
    entries.push([`--color-${toKebab(name)}`, value]);
  }
  for (const [status, colors] of Object.entries(theme.status)) {
    entries.push([`--status-${toKebab(status)}-text`, colors.text]);
    entries.push([`--status-${toKebab(status)}-bg`, colors.bg]);
  }
  return entries;
}

const px = (n: number) => `${n}px`;

/** Las variables que no dependen del modo. */
export function staticVariables(): Entries {
  const entries: Array<[string, string]> = [['--font-sans', FONT_STACK]];

  for (const step of SPACING_SCALE) entries.push([`--space-${step}`, px(step)]);
  for (const [name, value] of Object.entries(radii))
    entries.push([`--radius-${toKebab(name)}`, px(value)]);
  entries.push(['--border-width', px(borderWidth)]);
  entries.push(['--focus-ring-width', px(focusRing.width)]);
  entries.push(['--focus-ring-offset', px(focusRing.offset)]);
  for (const [name, value] of Object.entries(touch))
    entries.push([`--touch-${toKebab(name)}`, px(value)]);
  for (const [name, value] of Object.entries(layout))
    entries.push([`--layout-${toKebab(name)}`, px(value)]);
  entries.push(['--motion-max-duration', `${motion.maxDurationMs}ms`]);
  for (const [name, value] of Object.entries(iconSizes))
    entries.push([`--icon-${toKebab(name)}`, px(value)]);

  for (const [role, spec] of Object.entries(typography)) {
    const base = `--text-${toKebab(role)}`;
    entries.push([`${base}-size`, px(spec.size)]);
    entries.push([`${base}-weight`, String(spec.weight)]);
    entries.push([`${base}-leading`, String(spec.lineHeight)]);
    if ('letterSpacingEm' in spec) entries.push([`${base}-tracking`, `${spec.letterSpacingEm}em`]);
  }
  return entries;
}

const block = (selector: string, entries: Entries, extra: string[] = [], indent = ''): string =>
  [
    `${indent}${selector} {`,
    ...extra.map((line) => `${indent}  ${line}`),
    ...entries.map(([name, value]) => `${indent}  ${name}: ${value};`),
    `${indent}}`,
  ].join('\n');

export function toCssVariables(): string {
  const light = themeVariables(lightTheme);
  const dark = themeVariables(darkTheme);

  return [
    '/* Generado por packages/ui-tokens (`pnpm --filter @orq/ui-tokens build`). No se edita a mano. */',
    block(':root', [...staticVariables(), ...light], ['color-scheme: light;']),
    '/* Modo oscuro: sigue al sistema, salvo que el ajuste manual fuerce el claro. */',
    '@media (prefers-color-scheme: dark) {',
    block(':root:not([data-theme="light"])', dark, ['color-scheme: dark;'], '  '),
    '}',
    '/* Ajuste manual: oscuro. */',
    block(':root[data-theme="dark"]', dark, ['color-scheme: dark;']),
    '',
  ].join('\n');
}
