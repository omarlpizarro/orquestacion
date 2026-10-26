/**
 * Espaciado, forma, interacción táctil, movimiento e íconos de docs/design-guidelines.md,
 * secciones 5, 6, 7 y 11.2. Valores en px (números), para que los consuma igual la web y React Native.
 */

/** Escala de espaciado: ningún otro valor. */
export const SPACING_SCALE = [4, 8, 12, 16, 20, 24, 32, 48] as const;
export type SpacingStep = (typeof SPACING_SCALE)[number];

/** Radios: 10 para botones y campos, 14 para tarjetas, totalmente redondeado para chips. */
export const radii = {
  control: 10,
  card: 14,
  /** "Totalmente redondeado": un radio mayor que cualquier altura. */
  pill: 9999,
} as const;

/** Bordes de 1 px; el anillo de foco es la única excepción. */
export const borderWidth = 1;

export const focusRing = {
  width: 2,
  /** Separado 2 px del elemento. */
  offset: 2,
} as const;

/** Interacción táctil (sección 6) y alturas de campos y navegación (7.1, 7.4, 7.5). */
export const touch = {
  /** Toda zona tocable mide al menos esto, también los íconos. */
  minTarget: 44,
  /** Botones principales y campos. */
  controlHeight: 48,
  /** Entre dos zonas tocables, como mínimo. */
  minGap: 8,
} as const;

export const layout = {
  /** Márgenes de pantalla en móvil. */
  screenMarginMobile: 16,
  bottomNavHeight: 64,
} as const;

/** Animaciones de 200 ms como máximo, y solo de opacidad o posición (sección 11.2). */
export const motion = {
  maxDurationMs: 200,
} as const;

/** Lucide, trazo de 2 px sobre grilla de 24 (sección 7.7). */
export const iconSizes = {
  chip: 15,
  button: 20,
  nav: 22,
} as const;

export const ICON_STROKE_WIDTH = 2;
