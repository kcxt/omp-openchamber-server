/**
 * The omp backend: disk-backed session store and model catalog. Driven
 * sessions (one omp child each) live in `src/sessions/`.
 */
import type {
  AgentBackend,
  BackendCapabilities,
  BackendCredentialInput,
  ModelRef,
  OpenCodeProvidersResponse,
  SessionStore,
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
import { forkOmpSession, loadSessionMessages, recordUserMessageId, truncateOmpSessionAtMessage } from "./messages";
import {
  createOmpSession,
  deleteOmpSession,
  getOmpSessionByOpenCodeId,
  listOmpChildSessions,
  listOmpSessions,
  moveOmpSession,
  setOmpSessionTitle,
  updateOmpSession,
  adoptOmpTranscript,
  readSessionIdSync,
} from "./store";

/** The omp store's stand-in model for a session with no recorded model. */
const OMP_DEFAULT_MODEL: ModelRef = { providerID: "omp", modelID: "omp", variant: "default" };

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

/** SessionStore facade over the omp on-disk store. */
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
