/**
 * Tipografía de docs/design-guidelines.md, sección 4. Manrope, una sola familia, cuatro pesos.
 * La fuente se empaqueta con la app y con la web: nunca se carga de Google Fonts en ejecución.
 *
 * Tamaños en px; `lineHeight` es un múltiplo del tamaño (sin unidad). Nada por debajo de 13 px.
 * Horas, fechas y cantidades llevan cifras tabulares (`tabularNumbers`).
 */
export const FONT_FAMILY = 'Manrope';
/** Pila de respaldo mientras carga la fuente empaquetada. Una sola familia de marca. */
export const FONT_STACK = `${FONT_FAMILY}, system-ui, sans-serif`;
export const FONT_WEIGHTS = [400, 500, 600, 700] as const;
export type FontWeight = (typeof FONT_WEIGHTS)[number];

export const MIN_FONT_SIZE = 13;

export interface TextRole {
  size: number;
  weight: FontWeight;
  lineHeight: number;
  /** En `em`. Solo la etiqueta lo usa. */
  letterSpacingEm?: number;
  uppercase?: boolean;
}

export const typography = {
  /** Uno por pantalla ("Mi Día"). */
  screenTitle: { size: 28, weight: 700, lineHeight: 1.15 },
  /** Encabezados dentro de una pantalla. */
  sectionTitle: { size: 20, weight: 600, lineHeight: 1.25 },
  /** Nombre de una tarea o proyecto en una tarjeta. */
  taskTitle: { size: 17, weight: 600, lineHeight: 1.3 },
  /** Texto general, descripciones. */
  body: { size: 16, weight: 400, lineHeight: 1.45 },
  /** Texto de botones. */
  button: { size: 16, weight: 600, lineHeight: 1 },
  /** Metadatos, horas, ayudas. */
  secondary: { size: 14, weight: 400, lineHeight: 1.35 },
  /** El mismo rol secundario en peso 500 (la guía admite 400 o 500). */
  secondaryMedium: { size: 14, weight: 500, lineHeight: 1.35 },
  /** Rótulos de sección ("VENCIDAS"). */
  label: { size: 13, weight: 700, lineHeight: 1, letterSpacingEm: 0.06, uppercase: true },
} as const satisfies Record<string, TextRole>;

export type TextRoleName = keyof typeof typography;

/** `font-variant-numeric: tabular-nums` para horas, fechas y cantidades. */
export const tabularNumbers = 'tabular-nums';
