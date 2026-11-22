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
import { OmpCli } from "../../omp/cli";
import { RpcChild } from "../../omp/rpc-child";
import { listOmpModels } from "./models";
import { loadSessionMessages } from "./messages";
import {
  createOmpSession,
  deleteOmpSession,
  getOmpSessionByOpenCodeId,
  listOmpChildSessions,
  listOmpSessions,
  updateOmpSession,
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
        metadata: updates.metadata,
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
  async children(parentOpenCodeId, directory) {
    return listOmpChildSessions(parentOpenCodeId, directory);
  },
  async transcript(openCodeId, cwd) {
    return loadSessionMessages(openCodeId, cwd);
  },
};

/** The omp backend: disk-backed sessions, RPC transport, full capabilities. */
export const ompBackend: AgentBackend = {
  id: "omp",
  label: "omp",
  capabilities: ompCapabilities,
  defaultModel: OMP_DEFAULT_MODEL,
  store: ompStore,
  async listModels(cwd: string, auth?: BackendCredentialInput): Promise<OpenCodeProvidersResponse> {
    return listOmpModels(cwd, await resolveBackendCredentials(auth, { cwd }));
  },
  shutdownAll() {
    OmpCli.shutdown();
    RpcChild.killAll();
  },
};
