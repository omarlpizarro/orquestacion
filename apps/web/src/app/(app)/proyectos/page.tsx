import type { Metadata } from 'next';
import { ProjectList } from '../../../components/project-list';
import { ButtonLink } from '../../../components/ui/button';
import { EmptyState } from '../../../components/ui/empty-state';
import { api, safe } from '../../../lib/api';
import { canCreateProject } from '../../../lib/permissions';
import { getActiveMemberRole } from '../../../lib/session';

export const metadata: Metadata = { title: 'Proyectos' };

export default async function ProjectsPage() {
  const [role, { error, data }] = await Promise.all([
    getActiveMemberRole(),
    safe(api.projects.listProjects({})),
  ]);
  const canCreate = canCreateProject(role);

  return (
    <div className="flex flex-col gap-24">
      <div className="flex flex-wrap items-center justify-between gap-16">
        <h1 className="text-screen-title text-text">Proyectos</h1>
        {canCreate ? <ButtonLink href="/proyectos/nuevo">Nuevo proyecto</ButtonLink> : null}
      </div>
      {error ? (
        <p role="alert" className="text-body text-danger">
          No pudimos cargar los proyectos. Revisá tu conexión y volvé a abrir esta pantalla.
        </p>
      ) : data.projects.length === 0 ? (
        <EmptyState
          action={
            canCreate ? <ButtonLink href="/proyectos/nuevo">Crear proyecto</ButtonLink> : null
          }
        >
          {canCreate
            ? 'Todavía no hay proyectos. Creá el primero para empezar a repartir tareas.'
            : 'Todavía no tenés proyectos. Cuando te sumen a uno o te asignen una tarea, aparece acá.'}
        </EmptyState>
      ) : (
        <ProjectList projects={data.projects} />
      )}
    </div>
  );
}
