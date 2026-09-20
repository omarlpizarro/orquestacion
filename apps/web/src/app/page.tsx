import { api, safe } from '../lib/api.js';

export default async function StatusPage() {
  const [error, health] = await safe(api.health.get());

  if (error) {
    return (
      <main>
        <h1>Orquestación</h1>
        <p role="alert">No se pudo consultar el estado de la API: {error.message}</p>
      </main>
    );
  }

  return (
    <main>
      <h1>Orquestación</h1>
      <dl>
        <dt>Estado</dt>
        <dd>{health.status}</dd>
        <dt>Base de datos</dt>
        <dd>{health.database.reachable ? 'conectada' : 'sin conexión'}</dd>
        <dt>Conectada como</dt>
        <dd>{health.database.connectedAs}</dd>
        <dt>Hora del servidor (UTC)</dt>
        <dd>{health.database.serverTimeUtc}</dd>
      </dl>
    </main>
  );
}
