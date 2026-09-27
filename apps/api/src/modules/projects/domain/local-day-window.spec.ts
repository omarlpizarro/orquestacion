import { describe, expect, it } from 'vitest';
import { localDayWindow } from './local-day-window.js';

describe('localDayWindow', () => {
  it('con timeZone UTC, el día local y el día UTC coinciden', () => {
    const window = localDayWindow(new Date('2026-09-29T12:00:00.000Z'), 'UTC');
    expect(window).toEqual({
      startUtc: '2026-09-29T00:00:00.000Z',
      endUtc: '2026-09-30T00:00:00.000Z',
    });
  });

  it('el día local va atrás del día UTC (Buenos Aires, UTC-3, cerca de medianoche)', () => {
    // 2026-09-29T01:00:00Z son las 2026-09-28T22:00:00 en Buenos Aires:
    // el día UTC ya es 29, pero el día local todavía es 28.
    const window = localDayWindow(
      new Date('2026-09-29T01:00:00.000Z'),
      'America/Argentina/Buenos_Aires',
    );
    expect(window).toEqual({
      startUtc: '2026-09-28T03:00:00.000Z',
      endUtc: '2026-09-29T03:00:00.000Z',
    });
  });

  it('el día local va adelante del día UTC (Tokio, UTC+9, después de medianoche local)', () => {
    // 2026-09-28T16:00:00Z son las 2026-09-29T01:00:00 en Tokio: el día UTC
    // todavía es 28, pero el día local ya es 29.
    const window = localDayWindow(new Date('2026-09-28T16:00:00.000Z'), 'Asia/Tokyo');
    expect(window).toEqual({
      startUtc: '2026-09-28T15:00:00.000Z',
      endUtc: '2026-09-29T15:00:00.000Z',
    });
  });
});
