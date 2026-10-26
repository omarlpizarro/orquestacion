import type { ReactNode } from 'react';
import { BrandMark } from '../../components/ui/brand-mark';

// Pantallas sin sesión (o antes de elegir organización): una tarjeta centrada, sin la barra de la app.
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-24 px-16 py-32">
      <BrandMark />
      <div className="w-full max-w-md rounded-card border border-border bg-surface p-24">
        {children}
      </div>
    </main>
  );
}
