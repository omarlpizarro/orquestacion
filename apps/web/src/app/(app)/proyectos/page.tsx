import type { Metadata } from 'next';
import { EmptyState } from '../../../components/ui/empty-state';

export const metadata: Metadata = { title: 'Proyectos' };

// La lista real de proyectos llega con C4. Mientras tanto la pantalla dice qué va a aparecer, sin datos
// inventados (docs/design-guidelines.md §7.6).
export default function ProjectsPage() {
  return (
    <div className="flex flex-col gap-24">
      <h1 className="text-screen-title text-text">Proyectos</h1>
      <EmptyState>Acá van a aparecer los proyectos de tu organización.</EmptyState>
    </div>
  );
}
