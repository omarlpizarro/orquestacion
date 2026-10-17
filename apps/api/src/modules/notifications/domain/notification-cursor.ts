import { InvalidNotificationCursorError } from './errors/invalid-notification-cursor.error.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * El listado va del más nuevo al más viejo por `id` (UUIDv7, ordenable por tiempo), así que el
 * cursor es el último `id` de la página. Se codifica para que el cliente lo trate como opaco y
 * no dependa de que sea un id; se valida al volver, porque llega de afuera y termina en un `WHERE`.
 */
export function encodeNotificationCursor(lastId: string): string {
  return Buffer.from(lastId, 'utf8').toString('base64url');
}

export function decodeNotificationCursor(cursor: string): string {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!UUID.test(decoded)) throw new InvalidNotificationCursorError();
  return decoded.toLowerCase();
}
