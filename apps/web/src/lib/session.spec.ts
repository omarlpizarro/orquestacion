import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * La sesión que leen los componentes de servidor (ADR-020): llama a la API directo, reenviando la cookie
 * del pedido. Sin cookie no llama a nada; una API caída es "sin sesión", no un error de la página.
 */
const cookieHeader = vi.hoisted(() => ({ value: 'better-auth.session_token=abc' }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ toString: () => cookieHeader.value }),
}));
vi.mock('@orq/config', () => ({ loadWebEnv: () => ({ API_URL: 'http://api:3000' }) }));
// `cache()` de React solo memoiza dentro de un pedido de servidor; acá cada llamada es independiente.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  cache: <T>(fn: T) => fn,
}));

import { getActiveOrganization, getSession } from './session';

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init });

describe('lib/session', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    cookieHeader.value = 'better-auth.session_token=abc';
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  describe('getSession', () => {
    it('llama a la API directo, reenviando la cookie del pedido, sin caché', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          session: { activeOrganizationId: 'org_1' },
          user: { name: 'Laura Benítez', email: 'laura@demo.orquestacion.test' },
        }),
      );

      const session = await getSession();

      expect(fetchMock).toHaveBeenCalledWith('http://api:3000/api/auth/get-session', {
        headers: { cookie: 'better-auth.session_token=abc' },
        cache: 'no-store',
      });
      expect(session).toEqual({
        userName: 'Laura Benítez',
        userEmail: 'laura@demo.orquestacion.test',
        activeOrganizationId: 'org_1',
      });
    });

    it('sin cookie no llama a la API: no hay sesión', async () => {
      cookieHeader.value = '';

      expect(await getSession()).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('Better Auth responde `null` cuando no hay sesión', async () => {
      fetchMock.mockResolvedValue(jsonResponse(null));
      expect(await getSession()).toBeNull();
    });

    it('todavía sin organización activa: la sesión existe pero activeOrganizationId es null', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ session: {}, user: { name: 'Diego', email: 'diego@x.test' } }),
      );
      expect((await getSession())?.activeOrganizationId).toBeNull();
    });

    it('si la API responde con error o no responde, para la web es "sin sesión"', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'boom' }, { status: 500 }));
      expect(await getSession()).toBeNull();
      fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      expect(await getSession()).toBeNull();
    });

    it('una respuesta con otra forma (sin nombre o sin correo) no cuenta como sesión', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ session: {}, user: { email: 'x@y.test' } }));
      expect(await getSession()).toBeNull();
      fetchMock.mockResolvedValueOnce(new Response('no es json', { status: 200 }));
      expect(await getSession()).toBeNull();
    });
  });

  describe('getActiveOrganization', () => {
    const withSession = (activeOrganizationId: string | null) =>
      jsonResponse({
        session: { activeOrganizationId },
        user: { name: 'Laura', email: 'l@x.test' },
      });

    it('devuelve el nombre de la organización activa, entre las de la persona', async () => {
      fetchMock.mockResolvedValueOnce(withSession('org_2')).mockResolvedValueOnce(
        jsonResponse([
          { id: 'org_1', name: 'Otra' },
          { id: 'org_2', name: 'Constructora Demo' },
        ]),
      );

      expect(await getActiveOrganization()).toEqual({ id: 'org_2', name: 'Constructora Demo' });
      expect(fetchMock).toHaveBeenLastCalledWith(
        'http://api:3000/api/auth/organization/list',
        expect.objectContaining({ headers: { cookie: 'better-auth.session_token=abc' } }),
      );
    });

    it('sin organización activa no pregunta por las organizaciones', async () => {
      fetchMock.mockResolvedValueOnce(withSession(null));

      expect(await getActiveOrganization()).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('si la organización activa no figura en la lista, o la lista falla, es null', async () => {
      fetchMock
        .mockResolvedValueOnce(withSession('org_9'))
        .mockResolvedValueOnce(jsonResponse([{ id: 'org_1', name: 'Otra' }]));
      expect(await getActiveOrganization()).toBeNull();

      fetchMock.mockResolvedValueOnce(withSession('org_1')).mockResolvedValueOnce(jsonResponse({}));
      expect(await getActiveOrganization()).toBeNull();
    });
  });
});
