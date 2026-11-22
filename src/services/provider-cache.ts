import { listProviders } from "../providers/registry";
import type { OpenCodeProvidersResponse } from "../providers/types";

const PROVIDER_TTL_MS = 120_000;

const providerCache = new Map<string, { data: OpenCodeProvidersResponse; expiresAt: number }>();
const providerInFlight = new Map<string, Promise<OpenCodeProvidersResponse>>();
let globalProviderCache: { data: OpenCodeProvidersResponse; expiresAt: number } | null = null;

export async function fetchProvidersForDirectory(cwd: string): Promise<OpenCodeProvidersResponse> {
  const cached = providerCache.get(cwd) ?? globalProviderCache;
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }
  const existing = providerInFlight.get(cwd);
  if (existing) return existing;

  const request = listProviders(cwd)
    .then((response) => {
      const entry = { data: response, expiresAt: Date.now() + PROVIDER_TTL_MS };
      providerCache.set(cwd, entry);
      globalProviderCache = entry;
      return response;
    })
    .finally(() => {
      if (providerInFlight.get(cwd) === request) providerInFlight.delete(cwd);
    });
  providerInFlight.set(cwd, request);
  return request;
}

export function clearProviderCache(): void {
  providerCache.clear();
  globalProviderCache = null;
}
