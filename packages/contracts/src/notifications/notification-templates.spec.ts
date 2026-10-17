import { describe, expect, it } from 'vitest';
import {
  assignedDedupeKey,
  blockedDedupeKey,
  buildReasonPreview,
  REASON_PREVIEW_MAX_LENGTH,
} from './notification-templates.js';

describe('buildReasonPreview', () => {
  it('colapsa espacios y saltos de línea y recorta los bordes', () => {
    expect(buildReasonPreview('  Falta   el\npermiso\t municipal  ')).toBe(
      'Falta el permiso municipal',
    );
  });

  it('deja intacto un motivo que entra', () => {
    const exact = 'a'.repeat(REASON_PREVIEW_MAX_LENGTH);
    expect(buildReasonPreview(exact)).toBe(exact);
  });

  it('corta uno largo en el máximo, con puntos suspensivos', () => {
    const preview = buildReasonPreview('palabra '.repeat(100));
    expect(preview.length).toBeLessThanOrEqual(REASON_PREVIEW_MAX_LENGTH);
    expect(preview.endsWith('…')).toBe(true);
  });
});

describe('claves de deduplicación', () => {
  it('la asignación cambia con la versión: reasignar después avisa de nuevo, reintentar no', () => {
    const base = { taskId: 't1', recipientMemberId: 'm1' };
    expect(assignedDedupeKey({ ...base, taskVersion: 2 })).toBe(
      assignedDedupeKey({ ...base, taskVersion: 2 }),
    );
    expect(assignedDedupeKey({ ...base, taskVersion: 2 })).not.toBe(
      assignedDedupeKey({ ...base, taskVersion: 3 }),
    );
  });

  it('el bloqueo es una clave por novedad y destinatario, la misma desde la API y el worker', () => {
    const key = blockedDedupeKey({ taskUpdateId: 'u1', recipientMemberId: 'm1' });
    expect(key).toBe('task_update:u1:blocked:m1');
    expect(blockedDedupeKey({ taskUpdateId: 'u1', recipientMemberId: 'm2' })).not.toBe(key);
    expect(blockedDedupeKey({ taskUpdateId: 'u2', recipientMemberId: 'm1' })).not.toBe(key);
  });
});
