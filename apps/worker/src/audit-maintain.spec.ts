import { describe, expect, it } from 'vitest';
import { summarizeAuditPartitions } from './audit-maintain.js';

const NOW = new Date('2026-10-17T12:00:00Z');

describe('summarizeAuditPartitions', () => {
  it('cuenta los meses posteriores al actual, sin contar el actual ni la DEFAULT', () => {
    const names = [
      'audit_log_default',
      'audit_log_2026_09',
      'audit_log_2026_10',
      'audit_log_2026_11',
      'audit_log_2026_12',
      'audit_log_2027_01',
    ];
    expect(summarizeAuditPartitions(names, NOW).monthsAhead).toBe(3);
  });

  it('sin particiones futuras, 0', () => {
    expect(
      summarizeAuditPartitions(['audit_log_default', 'audit_log_2026_10'], NOW).monthsAhead,
    ).toBe(0);
  });

  it('marca las que pasaron el umbral: el mes que cumple el umbral justo todavía no', () => {
    // Umbral de 60 meses desde 2026-10: 2021-10 está en el límite, 2021-09 lo pasó.
    const names = ['audit_log_2021_09', 'audit_log_2021_10', 'audit_log_2026_10'];
    expect(summarizeAuditPartitions(names, NOW, 60).beyondRetention).toEqual(['audit_log_2021_09']);
  });

  it('cruza el cambio de año al contar meses', () => {
    const january = new Date('2027-01-05T00:00:00Z');
    const names = [
      'audit_log_2026_12',
      'audit_log_2027_01',
      'audit_log_2027_02',
      'audit_log_2027_03',
    ];
    expect(summarizeAuditPartitions(names, january).monthsAhead).toBe(2);
    expect(summarizeAuditPartitions(['audit_log_2025_12'], january, 12).beyondRetention).toEqual([
      'audit_log_2025_12',
    ]);
  });

  it('ignora nombres que no son una partición mensual', () => {
    expect(summarizeAuditPartitions(['audit_log_default', 'audit_log_foo', 'otra'], NOW)).toEqual({
      monthsAhead: 0,
      beyondRetention: [],
    });
  });
});
