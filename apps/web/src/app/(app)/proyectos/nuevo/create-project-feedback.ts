/**
 * Qué le decimos a quien crea un proyecto cuando la API lo rechaza. Mensajes que dicen qué hacer, nunca el
 * código del error (docs/design-guidelines.md §12). `field` marca bajo qué campo se muestra; sin él, va
 * arriba del botón.
 */
export interface CreateProjectFeedback {
  field?: 'code' | 'name';
  message: string;
}

export interface RejectedCall {
  /** El `code` del error de oRPC (`CONFLICT`, `FORBIDDEN`...). */
  code: string;
  /** El `domain_code` que distingue casos dentro del mismo `code`. */
  domainCode?: string | undefined;
}

export const GENERIC_CREATE_FAILURE =
  'No pudimos crear el proyecto. Revisá tu conexión e intentá de nuevo.';

export function feedbackForRejection(rejection: RejectedCall): CreateProjectFeedback {
  if (rejection.code === 'CONFLICT' && rejection.domainCode === 'project_code_taken') {
    return { field: 'code', message: 'Ya hay un proyecto con ese código. Usá otro.' };
  }
  if (rejection.code === 'FORBIDDEN') {
    return { message: 'No tenés permiso para crear proyectos.' };
  }
  if (rejection.code === 'UNAUTHORIZED') {
    return { message: 'Tu sesión venció. Volvé a iniciar sesión.' };
  }
  if (
    rejection.code === 'UNPROCESSABLE_CONTENT' &&
    rejection.domainCode === 'project_site_required'
  ) {
    return {
      message:
        'No pudimos elegir el sitio del proyecto: tu organización tiene más de un sitio activo, o ninguno, y desde acá todavía no se puede elegirlo.',
    };
  }
  if (rejection.code === 'BAD_REQUEST') {
    return { message: 'Revisá los datos: el código y el nombre son obligatorios.' };
  }
  return { message: GENERIC_CREATE_FAILURE };
}
