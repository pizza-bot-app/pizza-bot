import { ModelCatalogError } from "@pizza-bot/core";

export function missingCatalogCredentials(provider: string): ModelCatalogError {
  return new ModelCatalogError(
    "credentials",
    `${provider} credentials are not available to the server.`,
    false,
  );
}

export function catalogHttpError(provider: string, status: number): ModelCatalogError {
  if (status === 401 || status === 403) {
    return new ModelCatalogError(
      "authentication",
      `${provider} rejected the configured credentials.`,
      false,
    );
  }
  return new ModelCatalogError(
    "endpoint",
    `${provider} model discovery returned HTTP ${status}.`,
    status === 408 || status === 429 || status >= 500,
  );
}

export function catalogConnectionError(
  provider: string,
  cause: unknown,
): ModelCatalogError {
  if (cause instanceof ModelCatalogError) return cause;
  const timedOut =
    cause instanceof Error &&
    (cause.name === "TimeoutError" || cause.name === "AbortError");
  return new ModelCatalogError(
    "network",
    timedOut
      ? `${provider} model discovery timed out.`
      : `${provider} model discovery could not reach its endpoint.`,
    true,
    { cause },
  );
}
