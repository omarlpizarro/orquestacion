// Para el healthcheck del contenedor y la prueba de humo: dice que la web responde y qué commit corre.
// Sin tocar la API: que la web esté viva no depende de que la API también lo esté.
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ status: 'ok', commit: process.env.GIT_COMMIT ?? 'unknown' });
}
