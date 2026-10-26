import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { NavLink } from '../../components/nav-link';
import { SignOutButton } from '../../components/sign-out-button';
import { BrandMark } from '../../components/ui/brand-mark';
import { getActiveOrganization, getSession } from '../../lib/session';

/**
 * El shell de la app y su guarda de sesión (ADR-020). Todo lo que cuelga de `(app)` exige sesión y una
 * organización activa; si falta una de las dos, redirige antes de renderizar nada. Es un layout de
 * servidor: la decisión se toma con la cookie del pedido, no en el navegador.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!session.activeOrganizationId) redirect('/organizacion');
  const organization = await getActiveOrganization();

  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#contenido"
        className="sr-only rounded-control bg-primary px-16 py-12 text-on-primary focus:not-sr-only focus:absolute focus:left-16 focus:top-16"
      >
        Saltar al contenido
      </a>
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-x-24 gap-y-8 px-16 py-12">
          <div className="flex flex-wrap items-center gap-x-24 gap-y-8">
            <BrandMark />
            <nav aria-label="Principal" className="flex items-center gap-8">
              <NavLink href="/proyectos">Proyectos</NavLink>
            </nav>
          </div>
          <div className="flex flex-wrap items-center gap-x-16 gap-y-8">
            <p className="text-secondary text-text-2">
              <span className="font-medium text-text">{session.userName}</span>
              {organization ? ` · ${organization.name}` : null}
            </p>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main id="contenido" className="mx-auto w-full max-w-5xl flex-1 px-16 py-24">
        {children}
      </main>
    </div>
  );
}
