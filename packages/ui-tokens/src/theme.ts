import { type ColorTokens, darkColors, lightColors } from './colors.js';
import {
  darkStatusColors,
  lightStatusColors,
  type StatusColors,
  type TaskStatus,
} from './status.js';

export type ColorScheme = 'light' | 'dark';

/** Lo que cambia entre el modo claro y el oscuro. Misma estructura en los dos (sección 9). */
export interface Theme {
  colors: ColorTokens;
  status: Record<TaskStatus, StatusColors>;
}

export const lightTheme: Theme = { colors: lightColors, status: lightStatusColors };
export const darkTheme: Theme = { colors: darkColors, status: darkStatusColors };

export const themes: Record<ColorScheme, Theme> = { light: lightTheme, dark: darkTheme };

/** Para el tema de React Native (`useColorScheme()` devuelve `null` si el sistema no informa). */
export function getTheme(scheme: ColorScheme | null | undefined): Theme {
  return scheme === 'dark' ? darkTheme : lightTheme;
}
