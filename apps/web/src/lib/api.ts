import { createORPCClient } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import type { JsonifiedClient } from '@orpc/openapi-client';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import { loadWebEnv } from '@orq/config';
import { contract } from '@orq/contracts';
import { cookies } from 'next/headers';

// Único punto de reexportación de @orpc/client hacia el resto de apps/web
// (regla de contención de ADR-005, verificada por dependency-cruiser): las
// páginas importan `safe` de acá, nunca directo del paquete.
export { isDefinedError, safe } from '@orpc/client';

const env = loadWebEnv();

// Se usa desde componentes de servidor y Server Actions (ADR-020): llama a la API directo y reenvía la
// cookie de sesión del pedido que lo originó. `headers` se evalúa en cada llamada, no al cargar el módulo.
const link = new OpenAPILink(contract, {
  url: env.API_URL,
  headers: async () => ({ cookie: (await cookies()).toString() }),
});

export const api: JsonifiedClient<ContractRouterClient<typeof contract>> = createORPCClient(link);
