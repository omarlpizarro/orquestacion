import { describe, expect, it } from 'vitest';
import { localDatetimeToUtc } from './local-datetime-to-utc.js';

describe('localDatetimeToUtc', () => {
  it('convierte una hora de Buenos Aires (UTC-3, sin horario de verano) a UTC', () => {
    expect(localDatetimeToUtc('2026-09-29T08:00:00', 'America/Argentina/Buenos_Aires')).toBe(
      '2026-09-29T11:00:00.000Z',
    );
  });

  it('resuelve el offset correcto en invierno del hemisferio norte (EST, UTC-5)', () => {
    expect(localDatetimeToUtc('2026-01-15T08:00', 'America/New_York')).toBe(
      '2026-01-15T13:00:00.000Z',
    );
  });

  it('resuelve el offset correcto en horario de verano (EDT, UTC-4) — misma zona, offset distinto', () => {
    expect(localDatetimeToUtc('2026-07-15T08:00', 'America/New_York')).toBe(
      '2026-07-15T12:00:00.000Z',
    );
  });
});
