import { fromZonedTime } from 'date-fns-tz';

/**
 * ADR-008: "martes a las 8" en la hora del sitio, convertido al instante
 * UTC real. `localDatetime` no lleva zona horaria (ver
 * `localDateTimeSchema` en `packages/contracts`) — es la hora de pared que
 * el usuario eligió, en la zona que se le pasa acá.
 */
export function localDatetimeToUtc(localDatetime: string, timeZone: string): string {
  return fromZonedTime(localDatetime, timeZone).toISOString();
}
