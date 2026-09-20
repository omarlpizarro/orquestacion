import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';

/**
 * Todo ID de negocio es UUIDv7 generado en el cliente (CLAUDE.md §2.6): el
 * móvil offline crea filas sin esperar al servidor, y v7 es ordenable por
 * tiempo. Nunca `gen_random_uuid()` del lado del servidor.
 */
export function newId(): string {
  return uuidv7();
}

export const idSchema = z.uuidv7();
