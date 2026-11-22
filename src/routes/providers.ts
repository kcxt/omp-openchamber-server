/** Providers, models, the agent catalog and the small-model description. */
import { backendById, defaultBackend, listProviders, splitProviderPrefix } from "../providers/registry";
import type { BackendCredentialInput, OpenCodeProvidersResponse } from "../providers/types";
import { CredentialInputError } from "../providers/omp/credentials";
import { describeSmallModel, readOmpConfigSmallModel } from "../adapters/openchamber/small-model";
import type { RouteContext } from "../http/router";
import { asRecord, numberOr, readJson } from "../http/response";
import { logger } from "../shared/logger";

function toV2ModelInfo(
  value: OpenCodeProvidersResponse["providers"][number]["models"][string],
  providerID: string,
) {
  const model = asRecord(value) ?? {};
  const limit = asRecord(model.limit) ?? {};
  const modalities = asRecord(model.modalities) ?? {};
  const capabilities = asRecord(model.capabilities) ?? {};
  const input = Array.isArray(capabilities.input)
    ? capabilities.input.filter((entry): entry is string => typeof entry === "string")
    : Array.isArray(modalities.input)
      ? modalities.input.filter((entry): entry is string => typeof entry === "string")
      : ["text"];
  const output = Array.isArray(capabilities.output)
    ? capabilities.output.filter((entry): entry is string => typeof entry === "string")
    : Array.isArray(modalities.output)
      ? modalities.output.filter((entry): entry is string => typeof entry === "string")
      : ["text"];
  const rawVariants = asRecord(model.variants);
  const variants = Array.isArray(model.variants)
    ? model.variants
    : Object.entries(rawVariants ?? {}).map(([id, settings]) => ({
        id,
        ...(settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {}),
      }));
  const rawCost = Array.isArray(model.cost) ? model.cost : [asRecord(model.cost) ?? {}];
  const cost = rawCost.map((entry) => {
    const item = asRecord(entry) ?? {};
    const cache = asRecord(item.cache) ?? {};
    return {
      ...(asRecord(item.tier) ? { tier: item.tier } : {}),
      input: numberOr(item.input),
      output: numberOr(item.output),
      cache: { read: numberOr(cache.read), write: numberOr(cache.write) },
    };
  });
  const modelID = typeof model.modelID === "string" ? model.modelID : typeof model.id === "string" ? model.id : "omp";
  return {
    id: typeof model.id === "string" ? model.id : modelID,
    modelID,
    providerID,
    ...(typeof model.canonical === "string" ? { canonical: model.canonical } : {}),
    name: typeof model.name === "string" ? model.name : modelID,
    capabilities: {
      tools: typeof capabilities.tools === "boolean" ? capabilities.tools : model.tool_call !== false,
      input,
      output,
    },
    variants,
    time: { released: numberOr(asRecord(model.time)?.released) },
    cost,
    status: "active" as const,
    enabled: model.disabled !== true,
    limit: { context: numberOr(limit.context), output: numberOr(limit.output) },
  };
}

function toV2Agent() {
  return {
    id: "omp",
    name: "OMP",
    description: "OMP coding agent",
    mode: "primary" as const,
    hidden: false,
    request: { settings: {}, headers: {}, body: {} },
    permissions: [],
  };
}

export async function handleProviders(ctx: RouteContext): Promise<Response | undefined> {
  const { req, url, path, p, dir, effectiveDir, json, jsonError } = ctx;
  // Provider list / auth / sources
  if (p === "/provider/auth" && req.method === "GET") {
    return json({});
  }

  if (p.startsWith("/provider/") && p.endsWith("/source") && req.method === "GET") {
    return json({
      auth: { exists: true, path: null },
      user: { exists: false, path: null },
      project: { exists: false, path: null },
    });
  }

  if (p === "/provider" && req.method === "GET") {
    try {
      const cwd = dir ?? process.cwd();
      const providersData = await listProviders(cwd);
      const providers = providersData.providers.map((provider) => ({
        id: provider.id,
        name: provider.name,
        activation: "enabled" as const,
        package: "omp",
      }));
      return json({ location: { directory: cwd }, data: providers });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "provider list failed", 500);
    }
  }

  const providerMatch = p.match(/^\/provider\/([^/]+)$/);
  if (providerMatch && req.method === "GET") {
    try {
      const cwd = dir ?? process.cwd();
      const providerID = decodeURIComponent(providerMatch[1]!);
      const providersData = await listProviders(cwd);
      const provider = providersData.providers.find((entry) => entry.id === providerID);
      if (!provider) return jsonError("provider not found", 404);
      return json({
        location: { directory: cwd },
        data: { id: provider.id, name: provider.name, activation: "enabled", package: "omp" },
      });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "provider lookup failed", 500);
    }
  }

  if (p === "/providers" && req.method === "GET") {
    try {
      const cwd = dir ?? process.cwd();
      const providersData = await listProviders(cwd);
      return json({
        all: providersData.providers.map((provider) => ({ id: provider.id, name: provider.name })),
        default: providersData.default,
        connected: providersData.providers.map((provider) => provider.id),
        providers: providersData.providers,
      });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "provider list failed", 500);
    }
  }

  // Providers
  if (p === "/config/providers" && req.method === "GET") {
    try {
      const cwd = dir ?? process.cwd();
      const response = await listProviders(cwd);
      return json(response);
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "providers failed", 500);
    }
  }

  // Opt-in caller-owned provider catalog. The legacy GET above continues to
  // use OMP's normal host-local configuration. A POST is intentionally
  // separate so credentials can never silently alter that behavior.
  if (p === "/config/providers" && req.method === "POST") {
    try {
      const body = asRecord(await readJson(req));
      const hasCredentials = body?.credentials !== undefined;
      const hasCredentialRef = body?.credentialRef !== undefined;
      if (hasCredentials === hasCredentialRef) {
        return jsonError("provide exactly one of credentials or credentialRef", 400);
      }

      const model = asRecord(body?.model);
      const requestedProviderID = typeof model?.providerID === "string" ? model.providerID : undefined;
      const requestedModelID = typeof model?.modelID === "string" ? model.modelID : undefined;
      const providerSelection = requestedProviderID ? splitProviderPrefix(requestedProviderID) : undefined;
      const selectedBackend = providerSelection?.backendId
        ? backendById(providerSelection.backendId)
        : defaultBackend();
      if (!selectedBackend) return jsonError("unknown model backend", 400);

      const auth: BackendCredentialInput = hasCredentials
        ? {
            credentials: body?.credentials as BackendCredentialInput["credentials"],
            selectedProviderID: providerSelection?.native,
            selectedModelID: requestedModelID,
          }
        : {
            credentialRef: body?.credentialRef as string,
            selectedProviderID: providerSelection?.native,
            selectedModelID: requestedModelID,
          };
      const response = await selectedBackend.listModels(dir ?? process.cwd(), auth);
      return json(response);
    } catch (err) {
      if (err instanceof CredentialInputError) return jsonError(err.message, err.statusCode);
      return jsonError(err instanceof Error ? err.message : "providers failed", 500);
    }
  }

  // OpenCode v2 exposes a flat model list alongside the provider catalog.
  // The sidecar's existing catalog is grouped by provider; keep the wire
  // model shape and normalize provider ids for multi-backend mode.
  if (p === "/model" && req.method === "GET") {
    try {
      const providersData = await listProviders(dir ?? process.cwd());
      const models = providersData.providers.flatMap((provider) =>
        Object.values(provider.models).map((model) => toV2ModelInfo(model, provider.id)),
      );
      return json({ location: { directory: dir ?? process.cwd() }, data: models });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "model list failed", 500);
    }
  }

  // listModels orders the current provider and model first, so the model at
  // the head of the configured default provider is the active default.
  if (p === "/model/default" && req.method === "GET") {
    try {
      const providersData = await listProviders(dir ?? process.cwd());
      const provider = providersData.providers.find((entry) => entry.id === providersData.default.default);
      if (!provider) return json({ location: { directory: dir ?? process.cwd() }, data: null });
      const model = Object.values(provider.models)[0];
      return json({
        location: { directory: dir ?? process.cwd() },
        data: model ? toV2ModelInfo(model, provider.id) : null,
      });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "default model lookup failed", 500);
    }
  }

  // Agent catalog
  if (p === "/agent" && req.method === "GET") {
    return json({ location: { directory: dir ?? process.cwd() }, data: [toV2Agent()] });
  }

  // OpenChamber's small-model service asks for the hidden `title` agent to
  // learn which model the backend uses for side work. omp's answer is its
  // `smol` role, then `tiny`; no role configured is a plain 404, which the
  // client reads as "nothing configured".
  if (p === "/agent/title" && req.method === "GET") {
    const role = readOmpConfigSmallModel();
    if (!role) return jsonError("title agent not configured", 404);
    return json({
      location: { directory: dir ?? process.cwd() },
      data: { ...toV2Agent(), name: "title", hidden: true, model: { providerID: role.providerID, id: role.modelID, ...(role.variant ? { variant: role.variant } : {}) } },
    });
  }

  // Small model: OpenChamber's override picker filters the provider catalog
  // (served at /config/providers) by this allow-list, so the IDs must be the
  // same OpenCode-mapped IDs.
  if (path === "/api/small-model") {
    if (req.method !== "GET") return jsonError("method not allowed", 405);
    try {
      const providersData = await listProviders(effectiveDir);
      const seen: Record<string, true> = {};
      const authenticatedProviders: string[] = [];
      for (const pr of providersData.providers) {
        if (seen[pr.id]) continue;
        seen[pr.id] = true;
        authenticatedProviders.push(pr.id);
      }
      const preferredProviderID = url.searchParams.get("providerID") ?? undefined;
      const preferredModelID = url.searchParams.get("modelID") ?? undefined;
      const resolved = await describeSmallModel({
        directory: effectiveDir,
        preferredProviderID,
        preferredModelID,
      });
      return json({
        available: Boolean(resolved && resolved.hasLogin),
        model: resolved,
        authenticatedProviders,
      });
    } catch (err) {
      logger.warn(
        `[sidecar] small-model providers unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
      return json({ available: false, model: null, authenticatedProviders: [] });
    }
  }

  return undefined;
}
