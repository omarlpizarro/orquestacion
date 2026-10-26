/**
 * Contraste WCAG 2.x entre dos colores `#RRGGBB`. Lo usan los tests del paquete para exigir lo que
 * dice docs/design-guidelines.md (4.5:1 para texto, 3:1 para componentes de interfaz); está
 * exportado para que cualquier herramienta o test de otra app verifique un color nuevo igual.
 */
const HEX = /^#[0-9A-F]{6}$/;

export function isHexColor(value: string): boolean {
  return HEX.test(value);
}

function channel(hex: string, start: number): number {
  const c = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  if (!isHexColor(hex)) throw new Error(`Color inválido (se espera #RRGGBB en mayúsculas): ${hex}`);
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

export function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
}

/** Texto: 4.5:1. Texto de 24 px o más e íconos con significado: 3:1. Componentes de interfaz: 3:1. */
export const MIN_TEXT_CONTRAST = 4.5;
export const MIN_COMPONENT_CONTRAST = 3;
