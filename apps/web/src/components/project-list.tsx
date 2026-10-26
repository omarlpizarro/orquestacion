import type { ProjectOutput } from '@orq/contracts';
import { projectStatusLabels } from '../lib/project-labels';

export type ProjectSummary = Pick<
  ProjectOutput,
  'id' | 'code' | 'name' | 'status' | 'access_level'
>;

/**
 * Los proyectos que la persona puede ver, los más nuevos primero (así los devuelve la API). Tarjetas con la
 * forma de la sección 7.3 de la guía: `surface`, borde de 1 px, radio de tarjeta, sin sombras. Todavía no
 * son enlaces: el detalle del proyecto llega con C5.
 */
export function ProjectList({ projects }: { projects: readonly ProjectSummary[] }) {
  return (
    <ul className="flex flex-col gap-12">
      {projects.map((project) => (
        <li key={project.id} className="rounded-card border border-border bg-surface p-16">
          <h2 className="text-task-title text-text">{project.name}</h2>
          <p className="text-secondary text-text-2">
            {project.code} · {projectStatusLabels[project.status]}
            {project.access_level === 'assigned' ? ' · Ves solo tus tareas' : null}
          </p>
        </li>
      ))}
    </ul>
  );
}
