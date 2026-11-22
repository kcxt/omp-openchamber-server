/**
 * OMP backend turn connection.
 *
 * Wraps a raw OmpRpcTransport and exposes the backend-agnostic
 * BackendTurnConnection surface. Event frames flowing out of the transport
 * pass through the omp normalizer (events.ts) before reaching the sink.
 */
import { logger } from "../../shared/logger";
import { readOmpConfigSmallModel } from "../../adapters/openchamber/small-model";
import type {
  BackendGoalSnapshot,
  AgentBackend,
  BackendCapabilities,
  BackendSubagentSnapshot,
  BackendTurnConnection,
  BackendCredentialInput,
  BackendCredentials,
  ModelRef,
  OpenCodeProvidersResponse,
  SessionStore,
  TurnPromptInput,
} from "../types";
import { resolveBackendCredentials } from "./credentials";
import { RpcChild } from "../../omp/rpc-child";
import { Utility } from "../../omp/utility";
import {
  getCurrentModel,
  mapRpcModelsToOpenCodeProviders,
  normalizeModelsResponse,
  withOmpRpc,
  type OmpRpcTransport,
} from "./rpc";
import { rememberModelWindows } from "./context";
import { createOmpEventNormalizer, OMP_DEFAULT_MODEL } from "./events";
import { forkOmpSession, loadSessionMessages, recordUserMessageId, truncateOmpSessionAtMessage } from "./messages";
import {
  createOmpSession,
  deleteOmpSession,
  getOmpSessionByOpenCodeId,
  listOmpChildSessions,
  listOmpSessions,
  moveOmpSession,
  resolveOmpSubagentOpenCodeId,
  setOmpSessionTitle,
  updateOmpSession,
  adoptOmpTranscript,
  readSessionIdSync,
} from "./store";

export interface OmpTurnContext {
  /** External OpenCode session id. */
  openCodeId: string;
  cwd: string;
  /** Session file path; enables header re-reads + respawn semantics. */
  sessionPath?: string;
  /** Model the connection starts with; defaults to the omp builtin. */
  initialModel?: ModelRef;
  /** Grace window for non-terminal agent ends (tests shorten this). */
  nonTerminalGraceMs?: number;
}

export type OmpTransportFactory = (
  cwd: string,
  sessionPath: string,
  credential?: BackendCredentials,
) => Promise<OmpRpcTransport>;

const defaultOmpTransportFactory: OmpTransportFactory = async (cwd, sessionPath, credential) => {
  const conn = credential
    ? await RpcChild.spawn(cwd, 3, { credential })
    : await RpcChild.spawn(cwd);
  try {
    try {
      await conn.switchSession(sessionPath);
    } catch (error) {
      // The session's last model can no longer be restored (typically a local
      // llama.cpp provider whose server is down). Open it on the model this
      // child started with instead of failing every prompt; the user can pick
      // another model, and the saved history is unaffected.
      if (!(error instanceof Error) || !error.message.includes("Could not restore model")) throw error;
      // Prefer the cheap role (smol, then tiny) over the default, so a session
      // that lost its model never silently continues on the most expensive one.
      const role = readOmpConfigSmallModel();
      const state = (await conn.request("get_state")) as { model?: { provider?: unknown; id?: unknown } } | undefined;
      const provider = role?.providerID ?? state?.model?.provider;
      const modelId = role?.modelID ?? state?.model?.id;
      if (typeof provider !== "string" || typeof modelId !== "string") throw error;
      logger.warn({ sessionPath, provider, modelId }, `[omp] ${error.message}; opening the session on ${provider}/${modelId}`);
      await conn.request("switch_session", { sessionPath, provider, modelId });
    }
    await conn.request("set_subagent_subscription", { level: "events" }).catch(() => {});
    return conn;
  } catch (error) {
    // Preserve the legacy failure path for ambient OMP auth, but never leave
    // a credentialed child or its temporary config behind on initialization
    // failure.
    if (credential) conn.kill();
    throw error;
  }
};

let ompTransportFactory: OmpTransportFactory = defaultOmpTransportFactory;

/** Test seam: replaces how turn connections obtain their raw transport. */
export function setOmpTransportFactory(factory: OmpTransportFactory): void {
  ompTransportFactory = factory;
}

export function resetOmpTransportFactory(): void {
  ompTransportFactory = defaultOmpTransportFactory;
}

function isBackendSubagentStatus(value: unknown): value is BackendSubagentSnapshot["status"] {
  return value === "pending" || value === "running" || value === "completed" || value === "failed" || value === "aborted";
}

async function parseSubagentSnapshots(
  value: unknown,
  parentOpenCodeId: string,
  directory: string,
): Promise<BackendSubagentSnapshot[]> {
  if (value === null || typeof value !== "object" || !("subagents" in value) || !Array.isArray(value.subagents)) {
    throw new Error("invalid get_subagents response");
  }

  return Promise.all(value.subagents.map(async (entry, index) => {
    if (
      entry === null ||
      typeof entry !== "object" ||
      !("id" in entry) ||
      typeof entry.id !== "string" ||
      !("status" in entry) ||
      !isBackendSubagentStatus(entry.status)
    ) {
      throw new Error(`invalid get_subagents entry at index ${index}`);
    }
    return {
      id: await resolveOmpSubagentOpenCodeId(entry.id, parentOpenCodeId, directory),
      status: entry.status,
    };
  }));
}

function parseGoalSnapshot(value: unknown): BackendGoalSnapshot | null {
  if (value === null || typeof value !== "object") return null;
  const goal = value as Record<string, unknown>;
  const status = goal.status;
  if (status !== "active" && status !== "paused" && status !== "complete" && status !== "budget-limited" && status !== "dropped") return null;
  return {
    status,
    objective: typeof goal.objective === "string" ? goal.objective : "",
    tokensUsed: typeof goal.tokensUsed === "number" ? goal.tokensUsed : 0,
    ...(typeof goal.tokenBudget === "number" ? { tokenBudget: goal.tokenBudget } : {}),
  };
}

/**
 * Builds a turn connection over an existing transport. The normalizer owns
 * all backend-specific event translation; the returned object is exactly the
 * BackendTurnConnection contract.
 */
export function createOmpTurnConnection(transport: OmpRpcTransport, ctx: OmpTurnContext): BackendTurnConnection {
  const normalizer = createOmpEventNormalizer({
    transport,
    openCodeId: ctx.openCodeId,
    cwd: ctx.cwd,
    sessionPath: ctx.sessionPath,
    initialModel: ctx.initialModel,
    nonTerminalGraceMs: ctx.nonTerminalGraceMs,
  });
  return {
    onEvent(sink) {
      return normalizer.subscribe(sink);
    },
    prompt(input: TurnPromptInput) {
      return transport.request("prompt", input);
    },
    setModel(providerID: string, modelID: string) {
      return transport.request("set_model", { provider: providerID, modelId: modelID });
    },
    setThinkingLevel(level: string) {
      return transport.request("set_thinking_level", { level });
    },
    compact() {
      // Summarising calls a model; the default 30s request deadline is far too short.
      return transport.request("compact", {}, 10 * 60_000);
    },
    async getInitialModel() {
      try {
        const m = await getCurrentModel(transport);
        return (m && m.providerID && m.modelID
          ? { providerID: m.providerID, modelID: m.modelID, variant: m.variant ?? "default" }
          : undefined);
      } catch {
        return undefined;
      }
    },
    isAlive() {
      return transport.isAlive?.() ?? true;
    },
    async getSessionFile() {
      const state = (await transport.request("get_state", {})) as { sessionFile?: unknown } | undefined;
      return typeof state?.sessionFile === "string" ? state.sessionFile : undefined;
    },
    async isSettled() {
      const state = (await transport.request("get_state", {})) as { isSettled?: unknown; hasPendingAsyncWork?: unknown } | undefined;
      return state?.isSettled !== false && state?.hasPendingAsyncWork !== true;
    },
    async isStreaming() {
      const state = (await transport.request("get_state", {})) as { isStreaming?: unknown } | undefined;
      return state?.isStreaming === true;
    },
    async getSubagentStatuses() {
      return parseSubagentSnapshots(await transport.request("get_subagents"), ctx.openCodeId, ctx.cwd);
    },
    async goal(op, input) {
      await transport.request("goal", {
        op,
        ...(input?.objective !== undefined ? { objective: input.objective } : {}),
        ...(input?.tokenBudget !== undefined ? { token_budget: input.tokenBudget } : {}),
      });
    },
    async getGoal() {
      const state = (await transport.request("get_state", {})) as { goal?: { goal?: unknown } | null } | undefined;
      return parseGoalSnapshot(state?.goal?.goal);
    },
    onGoalUpdate(sink) {
      return transport.onEvent((event) => {
        if (event.type !== "goal_updated") return;
        sink(parseGoalSnapshot((event as { goal?: unknown }).goal));
      });
    },
    abort() {
      return transport.request("abort", {});
    },
    kill() {
      transport.kill();
    },
  };
}

/** omp supports every capability the sidecar surfaces. */
const ompCapabilities: BackendCapabilities = {
  thinkingLevels: true,
  images: true,
  approvals: true,
  subagents: true,
  todo: true,
  titleGeneration: true,
  skills: true,
  compact: true,
  shell: true,
  goals: true,
};

/**
 * SessionStore facade over the omp on-disk store. `recordUserMessage` wires the
 * user-message ledger so prompt.ts stays backend-agnostic.
 */
const ompStore: SessionStore = {
  async create(directory, init) {
    return createOmpSession(directory, init);
  },
  async get(openCodeId, directory) {
    return getOmpSessionByOpenCodeId(openCodeId, directory);
  },
  async list(directory, options) {
    return listOmpSessions(directory, options);
  },
  async delete(openCodeId, directory) {
    return deleteOmpSession(openCodeId, directory);
  },
  async update(openCodeId, updates, directory) {
    return updateOmpSession(
      openCodeId,
      {
        title: updates.title,
        metadata: updates.metadata,
        agent: updates.agent,
        model: updates.model,
        revert: updates.revert,
        time: updates.time?.archived !== undefined || updates.time?.viewed !== undefined
          ? {
              ...(updates.time.archived !== undefined ? { archived: updates.time.archived } : {}),
              ...(updates.time.viewed !== undefined ? { viewed: updates.time.viewed } : {}),
            }
          : undefined,
      },
      directory,
    );
  },
  async commitRevert(openCodeId, messageID, directory) {
    return truncateOmpSessionAtMessage(openCodeId, directory ?? "", messageID);
  },
  async adoptTranscript(openCodeId, transcriptPath) {
    await adoptOmpTranscript(openCodeId, transcriptPath);
  },
  async fork(openCodeId, directory, before) {
    return forkOmpSession(openCodeId, directory, before);
  },
  async move(openCodeId, directory, sourceDirectory) {
    return moveOmpSession(openCodeId, directory, sourceDirectory);
  },
  async setTitle(openCodeId, title, source, cwd) {
    await setOmpSessionTitle(openCodeId, title, source, cwd);
  },
  async children(parentOpenCodeId, directory) {
    return listOmpChildSessions(parentOpenCodeId, directory);
  },
  async transcript(openCodeId, cwd) {
    return loadSessionMessages(openCodeId, cwd);
  },
  recordUserMessage(openCodeId, text, messageId, parts) {
    recordUserMessageId(openCodeId, text, messageId, undefined, parts);
  },
};

/** The omp backend: disk-backed sessions, RPC transport, full capabilities. */
export const ompBackend: AgentBackend = {
  id: "omp",
  label: "omp",
  capabilities: ompCapabilities,
  defaultModel: OMP_DEFAULT_MODEL,
  store: ompStore,
  async listModels(cwd, auth?: BackendCredentialInput): Promise<OpenCodeProvidersResponse> {
    const credential = await resolveBackendCredentials(auth, { cwd });
    const readModels = async (request: OmpRpcTransport["request"]): Promise<OpenCodeProvidersResponse> => {
      const models = normalizeModelsResponse(await request("get_available_models"));
      const currentModel = await getCurrentModel({ request });
      const providers = mapRpcModelsToOpenCodeProviders(models, currentModel?.providerID, currentModel?.modelID);
      rememberModelWindows(providers);
      return providers;
    };
    if (!credential) {
      const utility = Utility.for(cwd);
      return readModels((method, params, timeoutMs) => utility.request(method, params, timeoutMs));
    }
    // Caller-owned credentials are per child: a shared utility cannot carry them.
    return withOmpRpc(cwd, (conn) => readModels((method, params, timeoutMs) => conn.request(method, params, timeoutMs)), { credential });
  },
  async createTurnConnection(cwd, sessionPath, openCodeId, auth?: BackendCredentialInput) {
    const credential = await resolveBackendCredentials(auth, {
      cwd,
      openCodeId,
    });
    const transport = credential === undefined
      ? await ompTransportFactory(cwd, sessionPath)
      : await ompTransportFactory(cwd, sessionPath, credential);
    return createOmpTurnConnection(transport, { openCodeId, cwd, sessionPath });
  },
  async sessionOwnedElsewhere(cwd, transcriptPath) {
    const id = readSessionIdSync(transcriptPath);
    if (!id) return false;
    // A utility omp never opened the session: `held` can only be another process.
    try {
      const lease = await Utility.for(cwd).leaseHeld([id]);
      if (lease.held.includes(id)) return true;
      return lease.unknown.includes(id) ? undefined : false;
    } catch {
      return undefined;
    }
  },
  shutdownAll() {
    Utility.shutdown();
    RpcChild.killAll();
  },
};
