import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { CreateProjectForm } from '../../../../components/create-project-form';
import { canCreateProject } from '../../../../lib/permissions';
import { getActiveMemberRole } from '../../../../lib/session';

export const metadata: Metadata = { title: 'Nuevo proyecto' };

export default async function NewProjectPage() {
  // La API es quien rechaza de verdad; esto solo evita mostrar un formulario que no va a andar.
  if (!canCreateProject(await getActiveMemberRole())) redirect('/proyectos');

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-24">
      <h1 className="text-screen-title text-text">Nuevo proyecto</h1>
      <CreateProjectForm />
    </div>
  );
}
