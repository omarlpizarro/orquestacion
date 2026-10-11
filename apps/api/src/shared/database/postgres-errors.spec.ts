import { describe, expect, it } from 'vitest';
import {
  hasPostgresErrorCode,
  postgresErrorConstraint,
  UNIQUE_VIOLATION,
} from './postgres-errors.js';

describe('hasPostgresErrorCode', () => {
  it('reconoce el código en el propio error', () => {
    expect(hasPostgresErrorCode({ code: UNIQUE_VIOLATION }, UNIQUE_VIOLATION)).toBe(true);
  });

  it('reconoce el código dentro de `cause`, como lo deja drizzle (DrizzleQueryError)', () => {
    const wrapped = Object.assign(new Error('Failed query'), {
      cause: { code: UNIQUE_VIOLATION, constraint: 'mutation_log_pkey' },
    });
    expect(hasPostgresErrorCode(wrapped, UNIQUE_VIOLATION)).toBe(true);
    expect(postgresErrorConstraint(wrapped)).toBe('mutation_log_pkey');
  });

  it('no confunde otro código ni un error sin código', () => {
    expect(hasPostgresErrorCode({ cause: { code: '42501' } }, UNIQUE_VIOLATION)).toBe(false);
    expect(hasPostgresErrorCode(new Error('x'), UNIQUE_VIOLATION)).toBe(false);
    expect(hasPostgresErrorCode(null, UNIQUE_VIOLATION)).toBe(false);
    expect(hasPostgresErrorCode('boom', UNIQUE_VIOLATION)).toBe(false);
  });

  it('no se cuelga con una cadena de causas circular', () => {
    const loop: { cause?: unknown } = {};
    loop.cause = loop;
    expect(hasPostgresErrorCode(loop, UNIQUE_VIOLATION)).toBe(false);
  });
});
