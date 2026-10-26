import { describe, expect, it } from 'vitest';
import { iconSizes, layout, motion, radii, SPACING_SCALE, touch } from './scale.js';
import { FONT_FAMILY, FONT_WEIGHTS, MIN_FONT_SIZE, typography } from './typography.js';

describe('escalas de docs/design-guidelines.md', () => {
  it('espaciado: 4, 8, 12, 16, 20, 24, 32, 48 y ningún otro valor', () => {
    expect([...SPACING_SCALE]).toEqual([4, 8, 12, 16, 20, 24, 32, 48]);
  });

  it('radios: 10 controles, 14 tarjetas, totalmente redondeado para chips', () => {
    expect(radii.control).toBe(10);
    expect(radii.card).toBe(14);
    expect(radii.pill).toBeGreaterThan(1000);
  });

  it('táctil: zonas de 44 px como mínimo, controles de 48, 8 px entre zonas', () => {
    expect(touch.minTarget).toBe(44);
    expect(touch.controlHeight).toBe(48);
    expect(touch.minGap).toBe(8);
    expect(touch.controlHeight).toBeGreaterThanOrEqual(touch.minTarget);
  });

  it('márgenes de pantalla de 16 en móvil y navegación inferior de 64', () => {
    expect(layout.screenMarginMobile).toBe(16);
    expect(layout.bottomNavHeight).toBe(64);
  });

  it('animaciones de 200 ms como máximo', () => {
    expect(motion.maxDurationMs).toBe(200);
  });

  it('íconos: 15 en chips, 20 en botones, 22 en la navegación', () => {
    expect(iconSizes).toEqual({ chip: 15, button: 20, nav: 22 });
  });
});

describe('tipografía', () => {
  it('una sola familia (Manrope) y cuatro pesos', () => {
    expect(FONT_FAMILY).toBe('Manrope');
    expect([...FONT_WEIGHTS]).toEqual([400, 500, 600, 700]);
  });

  it('los siete roles de la guía con sus tamaños, pesos e interlineados', () => {
    expect(typography.screenTitle).toEqual({ size: 28, weight: 700, lineHeight: 1.15 });
    expect(typography.sectionTitle).toEqual({ size: 20, weight: 600, lineHeight: 1.25 });
    expect(typography.taskTitle).toEqual({ size: 17, weight: 600, lineHeight: 1.3 });
    expect(typography.body).toEqual({ size: 16, weight: 400, lineHeight: 1.45 });
    expect(typography.button).toEqual({ size: 16, weight: 600, lineHeight: 1 });
    expect(typography.secondary).toEqual({ size: 14, weight: 400, lineHeight: 1.35 });
    expect(typography.secondaryMedium).toEqual({ size: 14, weight: 500, lineHeight: 1.35 });
    expect(typography.label).toEqual({
      size: 13,
      weight: 700,
      lineHeight: 1,
      letterSpacingEm: 0.06,
      uppercase: true,
    });
  });

  it('nada por debajo de 13 px, y solo pesos de la familia empaquetada', () => {
    for (const [name, role] of Object.entries(typography)) {
      expect(role.size, name).toBeGreaterThanOrEqual(MIN_FONT_SIZE);
      expect(FONT_WEIGHTS as readonly number[], name).toContain(role.weight);
    }
  });
});
