import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { classesOf, undefinedClasses } from '../test/tailwind';

// El formulario usa el enrutador de Next y el cliente de Better Auth, que necesitan un navegador: acá solo
// se comprueba lo que se ve y lo que se anuncia al renderizar en el servidor.
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock('../lib/auth', () => ({ authClient: { signIn: { email: vi.fn() } } }));

import { LoginForm } from './login-form';

describe('LoginForm', () => {
  const html = renderToStaticMarkup(<LoginForm />);

  it('pide correo y contraseña, con la etiqueta siempre visible y el autocompletado correcto', () => {
    expect(html).toContain('>Correo</label>');
    expect(html).toContain('>Contraseña</label>');
    expect(html).toContain('type="email"');
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="username"');
    expect(html).toContain('autoComplete="current-password"');
  });

  it('una sola acción principal, con verbo, a ancho completo y de tipo submit', () => {
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toContain('type="submit"');
    expect(html).toContain('>Iniciar sesión</button>');
    expect(classesOf(html)).toContain('w-full');
  });

  it('empieza sin errores a la vista', () => {
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('aria-invalid');
  });

  it('el formulario no valida con el navegador (los mensajes son los de la guía, en español)', () => {
    expect(html).toContain('noValidate');
  });

  it('todas sus clases existen en el CSS de la web', async () => {
    const classes = classesOf(html).filter((name) => !name.startsWith('lucide'));
    expect(await undefinedClasses(classes)).toEqual([]);
  });
});
