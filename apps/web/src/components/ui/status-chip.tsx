import { type TaskStatus, taskStatusIcons, taskStatusLabels } from '@orq/ui-tokens';
import { Check, Circle, CircleSlash, Eye, Play, X } from 'lucide-react';
import type { ComponentType } from 'react';

/**
 * Chip de estado de tarea (docs/design-guidelines.md §3 y §7.2). Siempre ícono Y texto, nunca solo
 * color: hay personas que no distinguen el rojo del verde y al sol los colores se lavan. No es tocable.
 *
 * Los nombres de los íconos salen de `@orq/ui-tokens` (`taskStatusIcons`); acá se enlazan con los
 * componentes de Lucide, uno por uno y con importación estática, para que el bundle solo lleve estos seis.
 */
const ICONS: Record<
  (typeof taskStatusIcons)[TaskStatus],
  ComponentType<{ className?: string; 'aria-hidden'?: boolean; strokeWidth?: number }>
> = {
  circle: Circle,
  play: Play,
  'circle-slash': CircleSlash,
  eye: Eye,
  check: Check,
  x: X,
};

// Completas y literales: Tailwind no ve clases armadas con `status-${...}`.
const COLORS: Record<TaskStatus, string> = {
  pending: 'bg-status-pending-bg text-status-pending-text',
  in_progress: 'bg-status-in-progress-bg text-status-in-progress-text',
  blocked: 'bg-status-blocked-bg text-status-blocked-text',
  in_review: 'bg-status-in-review-bg text-status-in-review-text',
  done: 'bg-status-done-bg text-status-done-text',
  cancelled: 'bg-status-cancelled-bg text-status-cancelled-text',
};

export function StatusChip({ status }: { status: TaskStatus }) {
  const Icon = ICONS[taskStatusIcons[status]];
  return (
    // Relleno 4 × 8: la guía dice 5 × 10 (§7.2) pero también que la escala de espaciado no admite otros
    // valores que 4, 8, 12... (§5). Gana la escala.
    <span
      className={`inline-flex items-center gap-4 rounded-pill px-8 py-4 text-secondary font-semibold ${COLORS[status]}`}
    >
      <Icon aria-hidden className="size-icon-chip shrink-0" strokeWidth={2} />
      {taskStatusLabels[status]}
    </span>
  );
}
