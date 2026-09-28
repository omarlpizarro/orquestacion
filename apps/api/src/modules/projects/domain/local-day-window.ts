import { addDays, startOfDay } from 'date-fns';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';

export interface LocalDayWindow {
  /** Instante UTC en que arranca "hoy" en `timeZone` (inclusive). */
  startUtc: string;
  /** Instante UTC en que arranca mañana en `timeZone` (exclusivo). */
  endUtc: string;
}

/**
 * El reverso de `localDatetimeToUtc`: dado un instante (`now`) y una zona
 * horaria, devuelve el rango UTC de las 24hs del día local en esa zona.
 * Existe porque el día local y el día UTC pueden no coincidir — a las 22:00
 * en Buenos Aires (UTC-3) ya es "mañana" en UTC — así que "hoy" para Mi Día
 * nunca se puede resolver comparando contra `new Date().toISOString()`
 * cortado a fecha.
 */
export function localDayWindow(now: Date, timeZone: string): LocalDayWindow {
  const zonedNow = toZonedTime(now, timeZone);
  const zonedStartOfDay = startOfDay(zonedNow);
  return {
    startUtc: fromZonedTime(zonedStartOfDay, timeZone).toISOString(),
    endUtc: fromZonedTime(addDays(zonedStartOfDay, 1), timeZone).toISOString(),
  };
}
