import { z } from 'zod';
import { base } from '../shared/base.contract.js';
import { memberIdSchema } from '../shared/member-id.js';

/** Tope de ids por pedido: una pantalla trae como mucho los miembros distintos que muestra. */
export const MAX_MEMBER_NAMES_PER_REQUEST = 100;

export const getMemberNamesInputSchema = z.object({
  // En la query string un único `ids=x` llega como texto y varios como arreglo: se aceptan los dos
  // y se normaliza. Un cliente (`OpenAPILink`) siempre manda arreglos.
  ids: z
    .union([memberIdSchema.transform((id) => [id]), z.array(memberIdSchema)])
    .pipe(z.array(memberIdSchema).min(1).max(MAX_MEMBER_NAMES_PER_REQUEST)),
});
export type GetMemberNamesInput = z.input<typeof getMemberNamesInputSchema>;

export const memberNameSchema = z.object({
  id: memberIdSchema,
  name: z.string(),
});
export type MemberName = z.infer<typeof memberNameSchema>;

export const getMemberNamesOutputSchema = z.object({
  // Solo los ids que son de la organización de quien pregunta, en el orden en que se pidieron y sin
  // repetir. Un id que falta (de otra organización, inventado, o de alguien que ya no está) NO vuelve,
  // y no se distingue cuál de las tres: el cliente muestra "Persona que ya no está".
  members: z.array(memberNameSchema),
});
export type GetMemberNamesOutput = z.infer<typeof getMemberNamesOutputSchema>;

/**
 * Lectura, no lleva `client_mutation_id`. Resuelve **en lote** los nombres de los miembros de la
 * propia organización que aparecen en una pantalla (autores de novedades, responsables, quien
 * bloqueó...): una consulta por pantalla con los ids distintos, no una por fila. Solo el nombre:
 * ni email, ni rol, ni foto. Lo pueden usar los cuatro roles. 400 si no hay ids o hay más de
 * `MAX_MEMBER_NAMES_PER_REQUEST`.
 */
export const getMemberNamesContract = base
  .route({
    method: 'GET',
    path: '/tenancy/members',
    summary: 'Resuelve en lote los nombres de miembros de la organización',
    tags: ['tenancy'],
  })
  .input(getMemberNamesInputSchema)
  .output(getMemberNamesOutputSchema);
