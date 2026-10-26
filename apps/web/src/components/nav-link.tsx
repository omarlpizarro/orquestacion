'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

/** Destino de la navegación. El activo va en `primary` y en negrita (docs/design-guidelines.md §7.4). */
export function NavLink({ href, children }: { href: string; children: ReactNode }) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`inline-flex min-h-touch items-center rounded-control px-12 text-body ${
        active ? 'font-bold text-primary' : 'text-text-2 hover:bg-surface-2'
      }`}
    >
      {children}
    </Link>
  );
}
