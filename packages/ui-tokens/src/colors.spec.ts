import { describe, expect, it } from 'vitest';
import { darkColors, lightColors } from './colors.js';
import {
  contrastRatio,
  isHexColor,
  MIN_COMPONENT_CONTRAST,
  MIN_TEXT_CONTRAST,
} from './contrast.js';

const themes = { claro: lightColors, oscuro: darkColors } as const;

describe('contrastRatio', () => {
  it('negro sobre blanco es 21:1 y un color sobre sí mismo, 1:1', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#1F4FD1', '#1F4FD1')).toBeCloseTo(1, 5);
  });

  it('es simétrico', () => {
    expect(contrastRatio('#1F4FD1', '#FFFFFF')).toBeCloseTo(
      contrastRatio('#FFFFFF', '#1F4FD1'),
      10,
    );
  });

  it('rechaza un color que no es #RRGGBB en mayúsculas', () => {
    expect(() => contrastRatio('#fff', '#000000')).toThrow(/Color inválido/);
    expect(() => contrastRatio('#1f4fd1', '#000000')).toThrow(/Color inválido/);
  });
});

describe('colores base', () => {
  it('los dos modos tienen exactamente las mismas claves (misma estructura, solo cambian los valores)', () => {
    expect(Object.keys(darkColors).sort()).toEqual(Object.keys(lightColors).sort());
  });

  it.each(Object.entries(themes))(
    'todo valor del modo %s es #RRGGBB en mayúsculas',
    (_modo, colors) => {
      for (const [name, value] of Object.entries(colors)) {
        expect(isHexColor(value), `${name}: ${value}`).toBe(true);
      }
    },
  );

  it('nunca negro puro de fondo en modo oscuro (sección 9)', () => {
    expect(darkColors.bg).toBe('#101114');
    expect(darkColors.bg).not.toBe('#000000');
  });

  describe.each(Object.entries(themes))('contraste del modo %s', (_modo, c) => {
    const textOn: Array<[keyof typeof c, keyof typeof c]> = [
      ['text', 'bg'],
      ['text', 'surface'],
      ['text', 'surface2'],
      ['text2', 'bg'],
      ['text2', 'surface'],
      ['text2', 'surface2'],
      // Enlaces y elemento activo.
      ['primary', 'bg'],
      ['primary', 'surface'],
      ['primary', 'surface2'],
      ['onPrimary', 'primary'],
      ['onPrimary', 'primaryPressed'],
      ['danger', 'bg'],
      ['danger', 'surface'],
      ['onDanger', 'danger'],
    ];

    it.each(textOn)('%s sobre %s cumple 4.5:1 (texto)', (fg, bg) => {
      expect(contrastRatio(c[fg], c[bg]), `${fg} sobre ${bg}`).toBeGreaterThanOrEqual(
        MIN_TEXT_CONTRAST,
      );
    });

    it.each(['bg', 'surface', 'surface2'] as const)(
      'border-strong cumple 3:1 contra %s (WCAG 1.4.11: es lo único que delimita un campo)',
      (bg) => {
        expect(contrastRatio(c.borderStrong, c[bg])).toBeGreaterThanOrEqual(MIN_COMPONENT_CONTRAST);
      },
    );

    it.each(['bg', 'surface'] as const)('el anillo de foco cumple 3:1 contra %s', (bg) => {
      expect(contrastRatio(c.focus, c[bg])).toBeGreaterThanOrEqual(MIN_COMPONENT_CONTRAST);
    });

    it('`border` es decorativo: NO cumple 3:1, por eso no se usa para delimitar campos', () => {
      // Si algún día cumpliera, `border-strong` sobraría. Mientras no, este test documenta por qué existe.
      expect(contrastRatio(c.border, c.surface)).toBeLessThan(MIN_COMPONENT_CONTRAST);
    });

    it('text-disabled queda FUERA de la exigencia de 4.5:1 a propósito (WCAG exime lo deshabilitado) pero se distingue del fondo', () => {
      expect(contrastRatio(c.textDisabled, c.surface2)).toBeLessThan(MIN_TEXT_CONTRAST);
      expect(contrastRatio(c.textDisabled, c.surface2)).toBeGreaterThan(1.5);
    });
  });
});
