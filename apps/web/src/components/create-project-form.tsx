'use client';

import { newId } from '@orq/contracts';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { createProjectAction } from '../app/(app)/proyectos/nuevo/actions';
import {
  type CreateProjectFeedback,
  GENERIC_CREATE_FAILURE,
} from '../app/(app)/proyectos/nuevo/create-project-feedback';
import { Button, ButtonLink } from './ui/button';
import { Field, TextAreaField } from './ui/field';

const MAX_CODE = 40;
const MAX_NAME = 200;
const MAX_DESCRIPTION = 4000;

interface FieldErrors {
  code?: string | undefined;
  name?: string | undefined;
  description?: string | undefined;
}

function tooLongOrEmpty(value: string, max: number, missing: string, tooLong: string) {
  if (!value) return missing;
  return value.length > max ? tooLong : undefined;
}

/**
 * Alta de un proyecto (docs/design-guidelines.md §8): solo código y nombre a la vista; la descripción va
 * en "Más opciones". No pregunta el sitio: con uno solo la API lo elige. Los ids se generan una vez al
 * abrir el formulario, así que un reintento tras un corte de red no crea dos proyectos.
 */
export function CreateProjectForm() {
  const router = useRouter();
  const [ids] = useState(() => ({ id: newId(), clientMutationId: newId() }));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string>();
  const [pending, setPending] = useState(false);

  function showRejection(feedback: CreateProjectFeedback) {
    if (feedback.field) {
      setErrors({ [feedback.field]: feedback.message });
    } else {
      setFormError(feedback.message);
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const code = String(form.get('code') ?? '').trim();
    const name = String(form.get('name') ?? '').trim();
    const description = String(form.get('description') ?? '').trim();

    const found: FieldErrors = {
      code: tooLongOrEmpty(
        code,
        MAX_CODE,
        'Escribí un código para el proyecto.',
        `Usá un código de hasta ${MAX_CODE} caracteres.`,
      ),
      name: tooLongOrEmpty(
        name,
        MAX_NAME,
        'Escribí el nombre del proyecto.',
        `Usá un nombre de hasta ${MAX_NAME} caracteres.`,
      ),
      description:
        description.length > MAX_DESCRIPTION
          ? `Usá una descripción de hasta ${MAX_DESCRIPTION} caracteres.`
          : undefined,
    };
    setErrors(found);
    setFormError(undefined);
    if (found.code || found.name || found.description) return;

    setPending(true);
    try {
      const result = await createProjectAction({
        id: ids.id,
        client_mutation_id: ids.clientMutationId,
        code,
        name,
        ...(description ? { description } : {}),
      });
      if (result.ok) {
        router.push('/proyectos');
        router.refresh();
        return;
      }
      showRejection(result);
    } catch {
      setFormError(GENERIC_CREATE_FAILURE);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-16">
      <Field
        label="Código"
        name="code"
        hint="Corto y único en tu organización, por ejemplo OBRA-12."
        autoComplete="off"
        error={errors.code}
        disabled={pending}
      />
      <Field label="Nombre" name="name" autoComplete="off" error={errors.name} disabled={pending} />
      <details className="rounded-control border border-border bg-surface">
        <summary className="flex min-h-touch cursor-pointer items-center px-16 text-secondary-medium text-text">
          Más opciones
        </summary>
        <div className="px-16 pb-16 pt-8">
          <TextAreaField
            label="Descripción"
            name="description"
            error={errors.description}
            disabled={pending}
          />
        </div>
      </details>
      {formError ? (
        <p role="alert" className="text-secondary text-danger">
          {formError}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-12">
        <Button type="submit" disabled={pending}>
          {pending ? 'Creando…' : 'Crear proyecto'}
        </Button>
        <ButtonLink href="/proyectos" variant="secondary">
          Cancelar
        </ButtonLink>
      </div>
    </form>
  );
}
