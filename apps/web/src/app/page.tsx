import { redirect } from 'next/navigation';

// "Inicio" va a ser la pantalla de lo bloqueado y lo vencido entre proyectos (ADR-020). Hasta que ese
// endpoint exista, Inicio lleva a Proyectos. La guarda de sesión está en el layout de `(app)`.
export default function HomePage() {
  redirect('/proyectos');
}
