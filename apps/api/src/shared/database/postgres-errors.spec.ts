import { describe, expect, it, vi } from 'vitest';
import {
  hasPostgresErrorCode,
  postgresErrorConstraint,
  retryOnceOnUniqueViolation,
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

describe('retryOnceOnUniqueViolation', () => {
  const uniqueViolation = Object.assign(new Error('Failed query'), {
    cause: { code: UNIQUE_VIOLATION },
  });

  it('devuelve el primer resultado sin reintentar', async () => {
    const attempt = vi.fn().mockResolvedValue('ok');
    expect(await retryOnceOnUniqueViolation(attempt)).toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('reintenta una vez ante una violación de unicidad', async () => {
    const attempt = vi.fn().mockRejectedValueOnce(uniqueViolation).mockResolvedValueOnce('ok');
    expect(await retryOnceOnUniqueViolation(attempt)).toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('no reintenta otros errores', async () => {
    const attempt = vi.fn().mockRejectedValue(new Error('otro'));
    await expect(retryOnceOnUniqueViolation(attempt)).rejects.toThrow('otro');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('si el segundo intento también falla, propaga ese error', async () => {
    const attempt = vi.fn().mockRejectedValue(uniqueViolation);
    await expect(retryOnceOnUniqueViolation(attempt)).rejects.toBe(uniqueViolation);
    expect(attempt).toHaveBeenCalledTimes(2);
  });
});
