'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { authClient } from '../lib/auth';
import { SignOutButton } from './sign-out-button';
import { Button } from './ui/button';
import { EmptyState } from './ui/empty-state';

/**
 * Elegir con qué organización trabajar. Elegir antes que tipear (docs/design-guidelines.md §1 y §8): si la
 * persona pertenece a UNA sola, se entra directo y nunca ve esta pantalla.
 */
export function OrganizationPicker() {
  const router = useRouter();
  const { data: organizations, isPending, error } = authClient.useListOrganizations();
  const [failed, setFailed] = useState(false);
  const [activating, setActivating] = useState<string>();
  const autoActivated = useRef(false);

  const activate = useCallback(
    async (organizationId: string) => {
      setActivating(organizationId);
      setFailed(false);
      const { error: activationError } = await authClient.organization.setActive({
        organizationId,
      });
      if (activationError) {
        setFailed(true);
        setActivating(undefined);
        return;
      }
      router.replace('/');
      router.refresh();
    },
    [router],
  );

  // Con una sola organización se entra directo, una única vez.
  const onlyOrganizationId = organizations?.length === 1 ? organizations[0]?.id : undefined;
  useEffect(() => {
    if (onlyOrganizationId && !autoActivated.current) {
      autoActivated.current = true;
      void activate(onlyOrganizationId);
    }
  }, [onlyOrganizationId, activate]);

  if (error) {
    return (
      <p role="alert" className="text-body text-danger">
        No pudimos cargar tus organizaciones. Revisá tu conexión e intentá de nuevo.
      </p>
    );
  }
  if (isPending || onlyOrganizationId) {
    return <p className="text-body text-text-2">Entrando a tu organización…</p>;
  }
  if (!organizations || organizations.length === 0) {
    return (
      <EmptyState action={<SignOutButton />}>
        Tu cuenta todavía no pertenece a ninguna organización. Pedile una invitación a quien
        administra tu cuenta.
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-16">
      <ul className="flex flex-col gap-8">
        {organizations.map((organization) => (
          <li key={organization.id}>
            <Button
              variant="secondary"
              fullWidth
              disabled={activating !== undefined}
              onClick={() => void activate(organization.id)}
            >
              Entrar a {organization.name}
            </Button>
          </li>
        ))}
      </ul>
      {failed ? (
        <p role="alert" className="text-secondary text-danger">
          No pudimos entrar a esa organización. Intentá de nuevo.
        </p>
      ) : null}
    </div>
  );
}
