import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendCredentials, OpenCodeModel, OpenCodeProvider, OpenCodeProvidersResponse } from "../shared/types";

export function getSidecarExtensionPaths(): string[] {
  const extensionsDir = join(import.meta.dir, "..", "adapters", "openchamber", "extensions");
  if (!existsSync(extensionsDir)) return [];
  return readdirSync(extensionsDir)
    .filter((f) => f.endsWith(".ts"))
    .sort()
    .map((f) => join(extensionsDir, f));
}

// The embedded RPC instance must start deterministically. Project-level MCP
// servers discovered from the target cwd (e.g. a flaky LSP server) otherwise
// gate OMP's `ready` frame and can stall startup for minutes. User-level MCP
// servers (~/.omp/agent/mcp.json, managed through /api/config/mcp) still load.
export function embeddedOmpConfigOverlay(): string {
  const dir = join(tmpdir(), "oc-omp-embedded");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "config.yml");
  const extensionPaths = getSidecarExtensionPaths();
  const extensionsYaml =
    extensionPaths.length > 0
      ? `\nextensions:\n${extensionPaths.map((p) => `  - ${JSON.stringify(p)}`).join("\n")}\n`
      : "";
  writeFileSync(
    file,
    `# The sidecar always selects the session itself (switch_session). A user's
# autoResume would otherwise reopen the newest session in the cwd at startup,
# and omp exits before the sidecar can steer it when that session's model
# cannot be restored (e.g. a local llama.cpp server that is not running).
autoResume: false
mcp:
  enableProjectConfig: false
edit:
  autoRepair:
    enabled: true
# The sidecar drives omp over RPC: without "rpc" an active goal never continues between turns.
goal:
  continuationModes: [rpc]
browser:
  enabled: false
  relay: false
compaction:
  methodOrder: [remote, handoff, shake, soft]${extensionsYaml}`,
  );
  return file;
}

export interface OmpRpcEvent {
  type: string;
  [key: string]: unknown;
}

/** Anything able to carry one OMP RPC session: the real connection, or a fake. */
export interface OmpRpcTransport {
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  onEvent(handler: (event: OmpRpcEvent) => void): () => void;
  switchSession(sessionPath: string): Promise<unknown>;
  /** False once the child has exited; absent on transports that cannot tell. */
  isAlive?(): boolean;
  kill(): void;
  sendFrame?(frame: unknown): void;
}

export interface OmpRpcSpawnOptions {
  /** Optional caller-owned credentials for this OMP child only. */
  credential?: BackendCredentials;
  /** Start OMP with no native tools; host tools can still be registered over RPC. */
  noTools?: boolean;
  /** Do not load sidecar/project extensions into this embedded OMP child. */
  disableExtensions?: boolean;
  /** `--auto-title`: omp names the session from its messages, as in its interactive mode (an RPC child never does by default). */
  autoTitle?: boolean;
  /** Names a supervised child's unit after what it serves (the session id); no effect on a plain child. */
  label?: string;
}

/** Stable error for RPC operations whose persisted session cwd was removed. */
export class MissingWorkingDirectoryError extends Error {
  readonly code = "MISSING_WORKING_DIRECTORY";
  readonly reason = "missing-working-directory";
  readonly statusCode = 404;
  readonly cwd: string;

  constructor(cwd: string) {
    super(`Working directory does not exist: ${cwd}`);
    this.name = "MissingWorkingDirectoryError";
    this.cwd = cwd;
  }
}

export function assertWorkingDirectory(cwd: string): void {
  try {
    if (!statSync(cwd).isDirectory()) throw new MissingWorkingDirectoryError(cwd);
  } catch (error) {
    if (error instanceof MissingWorkingDirectoryError) throw error;
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") throw new MissingWorkingDirectoryError(cwd);
    throw error;
  }
}

export interface OmpRpcModel {
  provider: string;
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: unknown;
  reasoning?: unknown;
  supportsToolCall?: boolean;
  supportsAttachment?: boolean;
  [key: string]: unknown;
}

const defaultThinkingVariants: Record<string, unknown> = {
  none: {},
  low: {},
  medium: {},
  high: {},
  xhigh: {},
};

export function parseModelInputCapabilities(input: unknown): {
  capabilitiesInput: unknown;
  modalitiesInput?: string[];
} {
  if (input === undefined) {
    return {
      capabilitiesInput: undefined,
      modalitiesInput: undefined,
    };
  }

  if (Array.isArray(input)) {
    const modalities = input
      .filter((x): x is string => typeof x === "string")
      .map((s) => s.toLowerCase());
    const hasText = modalities.includes("text") || modalities.length === 0;
    const hasImage = modalities.includes("image");
    const hasAudio = modalities.includes("audio");
    const hasVideo = modalities.includes("video");
    const hasPdf = modalities.includes("pdf");

    return {
      capabilitiesInput: {
        text: hasText,
        image: hasImage,
        audio: hasAudio,
        video: hasVideo,
        pdf: hasPdf,
      },
      modalitiesInput: modalities.length > 0 ? modalities : ["text"],
    };
  }

  if (typeof input === "object" && input !== null) {
    const obj = input as Record<string, unknown>;
    const modalities = Object.entries(obj)
      .filter(([_, v]) => Boolean(v))
      .map(([k]) => k.toLowerCase());
    return {
      capabilitiesInput: {
        text: Boolean(obj.text),
        image: Boolean(obj.image),
        audio: Boolean(obj.audio),
        video: Boolean(obj.video),
        pdf: Boolean(obj.pdf),
        ...obj,
      },
      modalitiesInput: modalities.length > 0 ? modalities : ["text"],
    };
  }

  return {
    capabilitiesInput: input,
    modalitiesInput: undefined,
  };
}

export function mapRpcModelsToOpenCodeProviders(
  modelsInput: OmpRpcModel[] | { models?: OmpRpcModel[] } | unknown,
  currentProviderID?: string,
  currentModelID?: string,
): OpenCodeProvidersResponse {
  let models: OmpRpcModel[] = [];
  if (Array.isArray(modelsInput)) {
    models = modelsInput as OmpRpcModel[];
  } else if (
    modelsInput &&
    typeof modelsInput === "object" &&
    Array.isArray((modelsInput as { models?: unknown }).models)
  ) {
    models = (modelsInput as { models: OmpRpcModel[] }).models;
  }

  const providersById = new Map<string, OpenCodeProvider>();
  for (const model of models) {
    let provider = providersById.get(model.provider);
    if (!provider) {
      provider = { id: model.provider, name: model.provider, models: {} };
      providersById.set(model.provider, provider);
    }
    let variants: Record<string, unknown> = { ...defaultThinkingVariants };
    if (model.variants && typeof model.variants === "object") {
      if (Array.isArray(model.variants)) {
        variants = Object.fromEntries(model.variants.map((v) => [String(v), {}]));
      } else {
        variants = { ...(model.variants as Record<string, unknown>) };
      }
    }
    const thinking = model.thinking as { efforts?: string[] } | undefined;
    if (Array.isArray(thinking?.efforts)) {
      for (const effort of thinking.efforts) {
        variants[String(effort)] = {};
      }
    }
    const { capabilitiesInput, modalitiesInput } = parseModelInputCapabilities(model.input);
    const supportsAttachment =
      model.supportsAttachment ??
      (modalitiesInput ? modalitiesInput.includes("image") || modalitiesInput.includes("pdf") : undefined);

    const entry: OpenCodeModel = {
      id: model.id,
      name: model.name,
      providerID: model.provider,
      limit: undefined,
      reasoning: model.reasoning ?? true,
      tool_call: model.supportsToolCall,
      attachment: supportsAttachment,
      capabilities:
        capabilitiesInput !== undefined
          ? {
              input: capabilitiesInput,
              ...(typeof model.supportsToolCall === "boolean" ? { toolcall: model.supportsToolCall } : {}),
              ...(typeof supportsAttachment === "boolean" ? { attachment: supportsAttachment } : {}),
              ...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
            }
          : undefined,
      modalities: modalitiesInput ? { input: modalitiesInput, output: ["text"] } : undefined,
      variants,
    };
    if (model.contextWindow !== undefined || model.maxTokens !== undefined) {
      const l: OpenCodeModel["limit"] = {};
      if (model.contextWindow !== undefined) l.context = model.contextWindow;
      if (model.maxTokens !== undefined) l.output = model.maxTokens;
      entry.limit = l;
    }
    provider.models[model.id] = entry;
  }

  // Ensure currentModelID is mapped if it has a region/custom prefix
  if (currentProviderID && currentModelID) {
    const provider = providersById.get(currentProviderID);
    if (provider && !provider.models[currentModelID]) {
      const stripped = currentModelID.replace(/^(us|eu|ap|jp|global)\./, "");
      const matched =
        provider.models[stripped] ??
        Object.values(provider.models).find(
          (m) => m.id.endsWith(stripped) || stripped.endsWith(m.id),
        );
      if (matched) {
        provider.models[currentModelID] = { ...matched, id: currentModelID };
      } else {
        provider.models[currentModelID] = {
          id: currentModelID,
          name: currentModelID,
          providerID: currentProviderID,
          reasoning: true,
          variants: { ...defaultThinkingVariants },
        };
      }
    }
  }

  const providers = Array.from(providersById.values());
  const defaultIdx = providers.findIndex((p) => p.id === currentProviderID);
  if (defaultIdx > 0) {
    const [def] = providers.splice(defaultIdx, 1);
    providers.unshift(def);
  }
  if (currentModelID && providers[0]?.models[currentModelID]) {
    const curModel = providers[0].models[currentModelID];
    delete providers[0].models[currentModelID];
    providers[0].models = { [currentModelID]: curModel, ...providers[0].models };
  }
  const defaultProvider = providers[0];
  return {
    providers,
    default: { default: defaultProvider?.id ?? "" },
  };
}
