/**
 * Colores base de docs/design-guidelines.md, sección 2.1. Es la ÚNICA fuente: ningún componente
 * de la web ni del móvil escribe un hexadecimal; los toma de acá (por variable CSS o por el objeto).
 *
 * Una paleta casi monocroma de grises pizarra con el cobalto como único color de marca. Las claves
 * son iguales en los dos modos (lo verifica un test): solo cambian los valores.
 */
export interface ColorTokens {
  /** Fondo de pantalla. */
  bg: string;
  /** Tarjetas, barras, hojas. */
  surface: string;
  /** Fondos sutiles, filas alternas, presionado. */
  surface2: string;
  /** Bordes decorativos de 1 px (tarjetas, separadores). NO delimita campos de formulario. */
  border: string;
  /**
   * Borde de los campos de formulario. Es el único modo de verlos, así que cumple 3:1 contra
   * `surface`, `bg` y `surface2` (WCAG 1.4.11, componentes de interfaz), cosa que `border` no.
   */
  borderStrong: string;
  /** Texto principal. */
  text: string;
  /** Texto secundario, metadatos. */
  text2: string;
  /** Solo elementos deshabilitados (WCAG exime el contraste de lo deshabilitado). */
  textDisabled: string;
  /** Acción principal, enlaces, elemento activo. */
  primary: string;
  /** Estado presionado de `primary`. */
  primaryPressed: string;
  /** Texto e íconos sobre `primary`. */
  onPrimary: string;
  /** Acciones destructivas. No es un estado de tarea. */
  danger: string;
  /** Estado presionado de `danger`. */
  dangerPressed: string;
  /** Texto sobre `danger` y `danger-pressed`. */
  onDanger: string;
  /** Anillo de foco. */
  focus: string;
}

export const lightColors: ColorTokens = {
  bg: '#F5F5F6',
  surface: '#FFFFFF',
  surface2: '#EEEFF1',
  border: '#DCDDE1',
  borderStrong: '#80848E',
  text: '#16181D',
  text2: '#50545E',
  textDisabled: '#9A9DA6',
  primary: '#1F4FD1',
  primaryPressed: '#173DA6',
  onPrimary: '#FFFFFF',
  danger: '#B42318',
  dangerPressed: '#8E1B12',
  onDanger: '#FFFFFF',
  focus: '#1F4FD1',
};

export const darkColors: ColorTokens = {
  bg: '#101114',
  surface: '#191B20',
  surface2: '#22252B',
  border: '#2B2E36',
  borderStrong: '#6B7080',
  text: '#ECEDF0',
  text2: '#A3A7B1',
  textDisabled: '#5C606B',
  primary: '#7C9DF5',
  primaryPressed: '#9BB4F8',
  onPrimary: '#0B0D12',
  danger: '#FF8A7A',
  dangerPressed: '#FFB3A8',
  onDanger: '#0B0D12',
  focus: '#7C9DF5',
};
