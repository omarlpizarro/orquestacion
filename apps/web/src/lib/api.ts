import { createORPCClient } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import type { JsonifiedClient } from '@orpc/openapi-client';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import { loadWebEnv } from '@orq/config';
import { contract } from '@orq/contracts';

// Único punto de reexportación de @orpc/client hacia el resto de apps/web
// (regla de contención de ADR-005, verificada por dependency-cruiser): las
// páginas importan `safe` de acá, nunca directo del paquete.
export { isDefinedError, safe } from '@orpc/client';

const env = loadWebEnv();

const link = new OpenAPILink(contract, {
  url: env.API_URL,
});

export const api: JsonifiedClient<ContractRouterClient<typeof contract>> = createORPCClient(link);
