import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { LoginForm } from '../../../components/login-form';
import { getSession } from '../../../lib/session';

export const metadata: Metadata = { title: 'Iniciar sesión' };

export default async function LoginPage() {
  const session = await getSession();
  if (session) redirect(session.activeOrganizationId ? '/' : '/organizacion');

  return (
    <div className="flex flex-col gap-24">
      <h1 className="text-screen-title text-text">Iniciá sesión</h1>
      <LoginForm />
    </div>
  );
}
