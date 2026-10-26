import type { ReactNode } from 'react';

/**
 * Estado vacío (docs/design-guidelines.md §7.6): una línea que explica qué va a aparecer ahí y, si
 * corresponde, una acción para empezar. Sin ilustraciones decorativas.
 */
export function EmptyState({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-16 rounded-card border border-border bg-surface p-24">
      <p className="text-body text-text-2">{children}</p>
      {action}
    </div>
  );
}
