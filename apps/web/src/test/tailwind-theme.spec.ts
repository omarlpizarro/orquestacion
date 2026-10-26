import { describe, expect, it } from 'vitest';
import { compileWithClasses, selectorFor } from './tailwind';

/**
 * Tailwind sin su tema por defecto (ADR-020): solo existen las clases de la escala de la guía. Estos tests
 * compilan el CSS real de la web y prueban las dos mitades: lo permitido genera una regla, lo que se
 * saltearía la guía no genera nada.
 */
/** Sin espacios y en minúsculas: el CSS de los tests no sale minificado, y los hex salen como están escritos. */
const squash = (css: string) => css.replace(/\s+/g, '').toLowerCase();

describe('el tema de la web son los tokens, no la paleta de Tailwind', () => {
  const allowed = [
    'bg-bg',
    'bg-surface',
    'bg-surface-2',
    'text-text',
    'text-text-2',
    'text-text-disabled',
    'bg-primary',
    'bg-primary-pressed',
    'text-on-primary',
    'bg-danger',
    'bg-danger-pressed',
    'text-on-danger',
    'border-border',
    'border-border-strong',
    'bg-status-blocked-bg',
    'text-status-done-text',
    'p-4',
    'p-16',
    'px-12',
    'gap-8',
    'gap-24',
    'm-48',
    'rounded-control',
    'rounded-card',
    'rounded-pill',
    'text-screen-title',
    'text-section-title',
    'text-task-title',
    'text-body',
    'text-button',
    'text-secondary',
    'text-label',
    'font-normal',
    'font-medium',
    'font-semibold',
    'font-bold',
    'min-h-control',
    'size-touch',
    'size-icon-chip',
    'size-icon-button',
    'size-icon-nav',
    'h-nav',
  ];

  // Cada una se saltea la guía: valores que no están en la escala, la paleta por defecto, sombras,
  // desenfoques, animaciones.
  const forbidden = [
    'p-7',
    'p-5',
    'p-10',
    'gap-3',
    'm-13',
    'bg-blue-500',
    'text-red-600',
    'bg-white',
    'bg-black',
    'border-gray-200',
    'shadow-md',
    'shadow-lg',
    'rounded-lg',
    'rounded-xl',
    'text-lg',
    'text-sm',
    'text-xs',
    'text-2xl',
    'font-extrabold',
    'font-light',
    'font-black',
    'animate-spin',
    'animate-pulse',
    'blur-sm',
    'leading-tight',
    'tracking-wide',
  ];

  it('toda clase del vocabulario genera una regla', async () => {
    const css = await compileWithClasses(allowed);
    const missing = allowed.filter((name) => !css.includes(selectorFor(name)));
    expect(missing).toEqual([]);
  });

  it('ninguna clase que se saltee la guía genera una regla', async () => {
    const css = await compileWithClasses(forbidden);
    const generated = forbidden.filter((name) => css.includes(selectorFor(name)));
    expect(generated).toEqual([]);
  });

  it('las clases de tipografía llevan tamaño, peso e interlineado del rol', async () => {
    const css = squash(await compileWithClasses(['text-task-title', 'text-label']));
    expect(css).toMatch(/\.text-task-title\{[^}]*font-size:var\(--text-task-title\)/);
    expect(css).toMatch(/\.text-task-title\{[^}]*font-weight:[^;}]*--text-task-title--font-weight/);
    expect(css).toMatch(/\.text-label\{[^}]*letter-spacing:[^;}]*--text-label--letter-spacing/);
  });

  it('el CSS trae el modo oscuro, automático y manual, y las cuatro fuentes empaquetadas', async () => {
    const css = await compileWithClasses(['bg-surface']);
    expect(css).toMatch(/prefers-color-scheme:\s*dark/);
    expect(css).toContain(':root[data-theme="dark"]');
    expect(css).toContain(':root:not([data-theme="light"])');
    // Fuentes: el @font-face de cada peso, apuntando a archivos del paquete (no a Google).
    for (const weight of [400, 500, 600, 700]) {
      expect(css, `peso ${weight}`).toMatch(new RegExp(`font-weight:\\s*${weight}`));
    }
    expect(css).not.toContain('fonts.googleapis.com');
    expect(css).not.toContain('fonts.gstatic.com');
  });

  it('las variables del modo oscuro tienen los valores de la guía', async () => {
    const css = squash(await compileWithClasses(['bg-surface']));
    const manual = css.slice(css.indexOf(':root[data-theme="dark"]'));
    expect(manual).toContain('--color-bg:#101114');
    expect(manual).toContain('--color-border-strong:#6b7080');
  });
});
