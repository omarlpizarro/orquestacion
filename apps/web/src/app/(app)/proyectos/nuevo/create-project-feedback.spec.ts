import { describe, expect, it } from 'vitest';
import { feedbackForRejection, GENERIC_CREATE_FAILURE } from './create-project-feedback';

describe('feedbackForRejection', () => {
  it('un código repetido se muestra bajo el campo código', () => {
    const feedback = feedbackForRejection({ code: 'CONFLICT', domainCode: 'project_code_taken' });
    expect(feedback.field).toBe('code');
    expect(feedback.message).toBe('Ya hay un proyecto con ese código. Usá otro.');
  });

  it('otro conflicto no se le atribuye al código', () => {
    const feedback = feedbackForRejection({ code: 'CONFLICT', domainCode: 'project_id_taken' });
    expect(feedback).toEqual({ message: GENERIC_CREATE_FAILURE });
  });

  it.each([
    ['FORBIDDEN', 'No tenés permiso para crear proyectos.'],
    ['UNAUTHORIZED', 'Tu sesión venció. Volvé a iniciar sesión.'],
    ['BAD_REQUEST', 'Revisá los datos: el código y el nombre son obligatorios.'],
  ])('%s dice qué hacer', (code, message) => {
    expect(feedbackForRejection({ code }).message).toBe(message);
  });

  it('con más de un sitio lo dice claro, porque la web todavía no deja elegirlo', () => {
    const feedback = feedbackForRejection({
      code: 'UNPROCESSABLE_CONTENT',
      domainCode: 'project_site_required',
    });
    expect(feedback.message).toContain('más de un sitio');
  });

  it('cualquier otra cosa es la falla genérica, sin códigos internos', () => {
    const feedback = feedbackForRejection({ code: 'INTERNAL_SERVER_ERROR' });
    expect(feedback).toEqual({ message: GENERIC_CREATE_FAILURE });
    expect(feedback.message).not.toMatch(/INTERNAL|500/);
  });
});
