import { z } from 'zod';

/**
 * "Martes a las 8" en la hora del sitio, sin zona horaria adjunta: el
 * cliente manda la hora de pared tal como la eligió el usuario, y el
 * servidor la convierte a UTC resolviendo la zona del sitio (o de la
 * organización si el proyecto no tiene sitio). Ver ADR-008.
 */
export const localDateTimeSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/,
    'Formato esperado: AAAA-MM-DDTHH:mm, sin zona horaria.',
  );
