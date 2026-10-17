import { describe, expect, it } from 'vitest';
import { InvalidNotificationCursorError } from './errors/invalid-notification-cursor.error.js';
import { decodeNotificationCursor, encodeNotificationCursor } from './notification-cursor.js';

const id = '01945f4e-0000-7000-8000-00000000abcd';

describe('cursor de avisos', () => {
  it('ida y vuelta devuelve el mismo id', () => {
    expect(decodeNotificationCursor(encodeNotificationCursor(id))).toBe(id);
  });

  it('no deja ver el id a simple vista (es opaco para el cliente)', () => {
    expect(encodeNotificationCursor(id)).not.toContain(id);
  });

  it('un cursor que no decodifica a un UUID se rechaza con un error de dominio', () => {
    for (const bad of [
      'no-es-un-cursor',
      Buffer.from('1; drop table notification').toString('base64url'),
      Buffer.from("' or 1=1 --").toString('base64url'),
      '',
    ]) {
      expect(() => decodeNotificationCursor(bad), bad).toThrow(InvalidNotificationCursorError);
    }
  });

  it('acepta mayúsculas y devuelve el id en minúsculas', () => {
    const upper = Buffer.from(id.toUpperCase()).toString('base64url');
    expect(decodeNotificationCursor(upper)).toBe(id);
  });
});
