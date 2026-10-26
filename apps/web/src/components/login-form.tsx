'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { authClient } from '../lib/auth';
import { Button } from './ui/button';
import { Field } from './ui/field';

/** Mensajes que dicen qué hacer, nunca un código ni un error interno (docs/design-guidelines.md §12). */
const BAD_CREDENTIALS = 'El correo o la contraseña no son correctos. Revisalos e intentá de nuevo.';
const GENERIC_FAILURE = 'No pudimos iniciar sesión. Revisá tu conexión e intentá de nuevo.';

export function LoginForm() {
  const router = useRouter();
  const [emailError, setEmailError] = useState<string>();
  const [passwordError, setPasswordError] = useState<string>();
  const [formError, setFormError] = useState<string>();
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') ?? '').trim();
    const password = String(form.get('password') ?? '');

    const missingEmail = email ? undefined : 'Escribí tu correo.';
    const missingPassword = password ? undefined : 'Escribí tu contraseña.';
    setEmailError(missingEmail);
    setPasswordError(missingPassword);
    setFormError(undefined);
    if (missingEmail || missingPassword) return;

    setPending(true);
    try {
      const { error } = await authClient.signIn.email({ email, password });
      if (error) {
        // 401/403 con credenciales que no sirven; cualquier otra cosa es una falla que la persona no arregla.
        setFormError(
          error.status === 401 || error.status === 400 ? BAD_CREDENTIALS : GENERIC_FAILURE,
        );
        return;
      }
      // Entra a la raíz: el servidor decide si falta elegir organización.
      router.replace('/');
      router.refresh();
    } catch {
      setFormError(GENERIC_FAILURE);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-16">
      <Field
        label="Correo"
        name="email"
        type="email"
        autoComplete="username"
        inputMode="email"
        error={emailError}
        disabled={pending}
      />
      <Field
        label="Contraseña"
        name="password"
        type="password"
        autoComplete="current-password"
        error={passwordError}
        disabled={pending}
      />
      {formError ? (
        <p role="alert" className="text-secondary text-danger">
          {formError}
        </p>
      ) : null}
      <Button type="submit" fullWidth disabled={pending}>
        {pending ? 'Entrando…' : 'Iniciar sesión'}
      </Button>
    </form>
  );
}
