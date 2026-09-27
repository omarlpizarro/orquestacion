import { describe, expect, it } from 'vitest';
import { ianaTimeZoneSchema } from './time-zone.js';

describe('ianaTimeZoneSchema', () => {
  it('acepta una zona IANA real', () => {
    expect(ianaTimeZoneSchema.safeParse('America/Argentina/Buenos_Aires').success).toBe(true);
  });

  it('acepta UTC', () => {
    expect(ianaTimeZoneSchema.safeParse('UTC').success).toBe(true);
  });

  it('rechaza un offset en vez de una zona', () => {
    expect(ianaTimeZoneSchema.safeParse('UTC-3').success).toBe(false);
  });

  it('rechaza una cadena que no es ninguna zona conocida', () => {
    expect(ianaTimeZoneSchema.safeParse('No/Existe').success).toBe(false);
  });
});
