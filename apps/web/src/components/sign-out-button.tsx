'use client';

import { LogOut } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { authClient } from '../lib/auth';
import { Button } from './ui/button';

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function signOut() {
    setPending(true);
    try {
      await authClient.signOut();
    } finally {
      // Aunque la API no responda, la persona sale de la pantalla: la cookie vencerá sola.
      router.replace('/login');
      router.refresh();
    }
  }

  return (
    <Button variant="secondary" onClick={() => void signOut()} disabled={pending}>
      <LogOut aria-hidden className="size-icon-button" strokeWidth={2} />
      Cerrar sesión
    </Button>
  );
}
