import type { Env } from "../env";
import { InternalApiClient } from "./client";

/** Host used for requests over the service binding (the hostname is ignored by bindings). */
const SERVICE_BINDING_BASE = "https://zyropay-api.internal";

/**
 * Production uses the `API` service binding (no public hop). API_INTERNAL_URL exists for
 * local development and tests, where the API runs as a separate process.
 */
export function createApiClient(env: Env): InternalApiClient {
  if (env.API_INTERNAL_URL) {
    return new InternalApiClient({
      fetcher: (request) => fetch(request),
      baseUrl: env.API_INTERNAL_URL,
      serviceToken: env.INTERNAL_SERVICE_TOKEN,
    });
  }
  const binding = env.API;
  if (!binding) throw new Error("API service binding missing");
  return new InternalApiClient({
    fetcher: (request) => binding.fetch(request),
    baseUrl: SERVICE_BINDING_BASE,
    serviceToken: env.INTERNAL_SERVICE_TOKEN,
  });
}
