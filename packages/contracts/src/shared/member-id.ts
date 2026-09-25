import { z } from 'zod';

/**
 * El id de un `member` lo genera Better Auth: un string opaco de 32
 * caracteres alfanuméricos, no un UUID (ADR-010 en `docs/adr/`). No se valida
 * con `idSchema` (UUIDv7) por ese motivo.
 */
export const memberIdSchema = z.string().min(1);
