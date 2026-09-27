import { z } from 'zod';

function isValidTimeZone(value: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Zona horaria IANA real (`America/Argentina/Buenos_Aires`), no un offset
 * (`UTC-3`) ni una abreviatura (`ART`): valida contra la base ICU de Node en
 * vez de mantener una lista propia que quedaría desactualizada.
 */
export const ianaTimeZoneSchema = z
  .string()
  .refine(isValidTimeZone, { message: 'No es una zona horaria IANA válida.' });
