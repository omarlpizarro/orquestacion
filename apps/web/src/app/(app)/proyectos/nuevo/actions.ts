'use server';

import { api, isDefinedError, safe } from '../../../../lib/api';
import {
  type CreateProjectFeedback,
  feedbackForRejection,
  GENERIC_CREATE_FAILURE,
} from './create-project-feedback';

export type CreateProjectResult = { ok: true } | ({ ok: false } & CreateProjectFeedback);

export interface CreateProjectFormValues {
  /** UUIDv7 del proyecto y de la mutación, generados por el formulario: un reintento no duplica. */
  id: string;
  client_mutation_id: string;
  code: string;
  name: string;
  description?: string | undefined;
  visibility: 'reserved' | 'site';
}

/**
 * Server Action: la API se llama desde el servidor de la web con la cookie del pedido (ADR-020). La API
 * valida todo de nuevo; esto solo traduce su respuesta a un mensaje.
 */
export async function createProjectAction(
  values: CreateProjectFormValues,
): Promise<CreateProjectResult> {
  const { error } = await safe(api.projects.createProject(values));
  if (!error) return { ok: true };
  if (isDefinedError(error)) {
    return {
      ok: false,
      ...feedbackForRejection({ code: error.code, domainCode: error.data?.domain_code }),
    };
  }
  return { ok: false, message: GENERIC_CREATE_FAILURE };
}
