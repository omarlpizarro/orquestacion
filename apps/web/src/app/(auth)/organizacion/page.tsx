import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { OrganizationPicker } from '../../../components/organization-picker';
import { getSession } from '../../../lib/session';

export const metadata: Metadata = { title: 'Elegir organización' };

export default async function OrganizationPage() {
  const session = await getSession();
  if (!session) redirect('/login');

  return (
    <div className="flex flex-col gap-24">
      <h1 className="text-screen-title text-text">Elegí con qué organización trabajar</h1>
      <OrganizationPicker />
    </div>
  );
}
