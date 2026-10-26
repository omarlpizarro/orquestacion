import { toKebab } from './css.js';
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
import { FONT_STACK, FONT_WEIGHTS, typography } from './typography.js';

/**
 * Genera `tailwind.css`: los tokens como TEMA de Tailwind 4 (docs/design-guidelines.md, §11.1, y
 * ADR-020). Es lo único que la web importa para estilos: `@import "@orq/ui-tokens/tailwind.css"` después
 * de `@import "tailwindcss"`.
 *
 * **Anula el tema por defecto de Tailwind** en todo lo que la guía define (colores, espaciado, radios,
 * tamaños y pesos de texto, interlineados, sombras, desenfoques, animaciones): sin esto `p-7`,
 * `bg-blue-500` o `shadow-md` compilarían igual y se saltearían la guía. Lo que no se anula (puntos de
 * corte, contenedores, curvas de easing) no es un valor de diseño de un componente.
 *
 * **Valores literales con `@theme static`, no `@theme inline` con `var(--color-x)`:** mapear un token a una
 * variable CSS del MISMO nombre se referencia a sí mismo (`--color-bg: var(--color-bg)`), un ciclo que solo
 * anda porque otra declaración lo pisa. Acá el modo claro son los valores del tema y el oscuro una
 * sobreescritura de esas mismas variables (`prefers-color-scheme`, o `data-theme` en `<html>`), igual que
 * `tokens.css`. `static` hace que se emitan todas aunque ninguna clase las use todavía.
 *
 * Nombres de las clases: el número de `p-16` o `gap-8` ES el valor en px; los colores son `bg-surface`,
 * `text-text-2`, `border-border-strong`, `bg-status-blocked-bg`; los tamaños de texto son los roles de la guía
 * (`text-body`, `text-task-title`, `text-label`), con su peso e interlineado.
 */

type Entries = Array<readonly [name: string, value: string]>;

const px = (n: number) => `${n}px`;

/** Lo que cambia con el modo, con los nombres del tema de Tailwind (`--color-*`). */
function colorEntries(theme: Theme): Entries {
  const entries: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(theme.colors)) {
    entries.push([`--color-${toKebab(name)}`, value]);
  }
  for (const [status, colors] of Object.entries(theme.status)) {
    entries.push([`--color-status-${toKebab(status)}-text`, colors.text]);
    entries.push([`--color-status-${toKebab(status)}-bg`, colors.bg]);
  }
  return entries;
}

/** Lo que NO cambia con el modo. */
function staticEntries(): Entries {
  const entries: Array<[string, string]> = [['--font-sans', FONT_STACK]];

  // Pesos: los cuatro de la familia empaquetada, con los nombres que Tailwind ya usa.
  const weightNames: Record<(typeof FONT_WEIGHTS)[number], string> = {
    400: 'normal',
    500: 'medium',
    600: 'semibold',
    700: 'bold',
  };
  for (const weight of FONT_WEIGHTS)
    entries.push([`--font-weight-${weightNames[weight]}`, String(weight)]);

  // Roles de tipografía: tamaño, peso e interlineado (y espaciado de letras, solo la etiqueta).
  for (const [role, spec] of Object.entries(typography)) {
    const name = `--text-${toKebab(role)}`;
    entries.push([name, px(spec.size)]);
    entries.push([`${name}--font-weight`, String(spec.weight)]);
    entries.push([`${name}--line-height`, String(spec.lineHeight)]);
    if ('letterSpacingEm' in spec)
      entries.push([`${name}--letter-spacing`, `${spec.letterSpacingEm}em`]);
  }

  // Espaciado: `p-16` = 16 px. Más las medidas con nombre (zona táctil, control, navegación, íconos).
  for (const step of SPACING_SCALE) entries.push([`--spacing-${step}`, px(step)]);
  entries.push(['--spacing-touch', px(touch.minTarget)]);
  entries.push(['--spacing-control', px(touch.controlHeight)]);
  entries.push(['--spacing-nav', px(layout.bottomNavHeight)]);
  for (const [name, value] of Object.entries(iconSizes)) {
    entries.push([`--spacing-icon-${toKebab(name)}`, px(value)]);
  }

  for (const [name, value] of Object.entries(radii))
    entries.push([`--radius-${toKebab(name)}`, px(value)]);

  // Las animaciones por defecto duran lo que la guía permite como máximo (§11.2).
  entries.push(['--default-transition-duration', `${motion.maxDurationMs}ms`]);

  // No son clases, son valores que usa el CSS base (anillo de foco, borde de 1 px).
  entries.push(['--border-width', px(borderWidth)]);
  entries.push(['--focus-ring-width', px(focusRing.width)]);
  entries.push(['--focus-ring-offset', px(focusRing.offset)]);
  return entries;
}

/** Vaciar un espacio de nombres del tema por defecto de Tailwind. */
const RESETS = [
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
  '--inset-shadow-*',
  '--drop-shadow-*',
  '--text-shadow-*',
  '--blur-*',
  '--animate-*',
] as const;

const declarations = (entries: Entries, indent: string) =>
  entries.map(([name, value]) => `${indent}${name}: ${value};`);

export function toTailwindTheme(): string {
  const dark = declarations(colorEntries(darkTheme), '  ');
  const darkAuto = declarations(colorEntries(darkTheme), '    ');
  return [
    '/* Generado por packages/ui-tokens (`pnpm --filter @orq/ui-tokens build`). No se edita a mano. */',
    '@theme static {',
    ...RESETS.map((namespace) => `  ${namespace}: initial;`),
    ...declarations(staticEntries(), '  '),
    '  /* Modo claro. */',
    ...declarations(colorEntries(lightTheme), '  '),
    '}',
    '',
    'html {',
    '  color-scheme: light;',
    '}',
    '',
    '/* Modo oscuro: sigue al sistema, salvo que el ajuste manual fuerce el claro. */',
    '@media (prefers-color-scheme: dark) {',
    '  :root:not([data-theme="light"]) {',
    '    color-scheme: dark;',
    ...darkAuto,
    '  }',
    '}',
    '',
    '/* Ajuste manual: oscuro. */',
    ':root[data-theme="dark"] {',
    '  color-scheme: dark;',
    ...dark,
    '}',
    '',
  ].join('\n');
}
