import { oc } from '@orpc/contract';
import { z } from 'zod';
import { idSchema } from './id.js';

/**
 * CLAUDE.md §8: un tipo de error de dominio por caso, con un `code` estable
 * y un `message` en español apto para mostrarle al usuario. `code` es la
 * clave del error map de oRPC; `domain_code` existe para cuando el caso de
 * negocio es más fino que el status HTTP (por ejemplo, varios 409 distintos).
 */
export const domainErrorData = z.object({
  domain_code: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const base = oc.errors({
  BAD_REQUEST: { status: 400, message: 'La solicitud no es válida.', data: domainErrorData },
  UNAUTHORIZED: { status: 401, message: 'Necesitás iniciar sesión.', data: domainErrorData },
  FORBIDDEN: {
    status: 403,
    message: 'No tenés permiso para esta acción.',
    data: domainErrorData,
  },
  NOT_FOUND: { status: 404, message: 'No encontramos lo que buscabas.', data: domainErrorData },
  CONFLICT: {
    status: 409,
    message: 'El recurso cambió mientras lo editabas.',
    data: domainErrorData,
  },
  UNPROCESSABLE_CONTENT: {
    status: 422,
    message: 'No se pudo aplicar el cambio.',
    data: domainErrorData,
  },
});

/**
 * Envelope de mutación offline (CLAUDE.md §9): toda mutación que puede
 * originarse en el móvil lleva `client_mutation_id` para que un reintento
 * devuelva el resultado anterior en vez de duplicar el efecto.
 */
export function withClientMutationId<Shape extends z.ZodRawShape>(schema: z.ZodObject<Shape>) {
  return schema.extend({ client_mutation_id: idSchema });
}
