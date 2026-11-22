/**
 * Backend-agnostic contracts for the provider abstraction.
 *
 * Layering rules (see docs/providers.md):
 *  - `src/providers/types.ts` (this file) is a leaf: it imports only shared
 *    src-level protocol modules and is imported by every backend.
 *  - Backend implementations live under `src/providers/<backendId>/` and may
 *    import shared src modules, but must never import `main.ts` or `src/sessions/`.
 */

// ---------------------------------------------------------------------------
// Model catalog protocol (OpenCode /provider surface)
// ---------------------------------------------------------------------------

export interface OpenCodeModel {
  id: string;
  name: string;
  providerID: string;
  limit?: { context?: number; output?: number };
  reasoning?: unknown;
  tool_call?: boolean;
  attachment?: boolean;
  capabilities?: {
    input?: unknown;
    output?: unknown;
    toolcall?: boolean;
    reasoning?: boolean;
    attachment?: boolean;
    temperature?: boolean;
    [key: string]: unknown;
  };
  modalities?: {
    input?: string[];
    output?: string[];
  };
  variants?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface OpenCodeProvider {
  id: string;
  name: string;
  models: Record<string, OpenCodeModel>;
}

export interface OpenCodeProvidersResponse {
  providers: OpenCodeProvider[];
  default: { default: string };
}

// ---------------------------------------------------------------------------
// Model reference / usage
// ---------------------------------------------------------------------------

export interface ModelRef {
  providerID: string;
  modelID: string;
  variant: string;
}

// ---------------------------------------------------------------------------
// Optional caller-owned model credentials
// ---------------------------------------------------------------------------

/**
 * Provider configuration supplied by a trusted caller for one OMP runtime.
 *
 * This is deliberately a small OpenAI/OMP model-config-shaped envelope rather
 * than an AuthStorage implementation. The sidecar only uses it when the
 * request includes `credentials` or `credentialRef`; otherwise OMP keeps its
 * normal host-local credential resolution behavior.
 */
export interface BackendCredentials {
  /** OMP provider id. Inferred from the selected model when omitted. */
  providerID?: string;
  apiKey?: string;
  baseUrl?: string;
  api?: string;
  auth?: "apiKey" | "none" | "oauth";
  authHeader?: boolean;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  remoteCompaction?: Record<string, unknown>;
  discovery?: Record<string, unknown>;
  modelOverrides?: Record<string, Record<string, unknown>>;
  disableStrictTools?: boolean;
  guardrailIdentifier?: string;
  guardrailVersion?: string;
  guardrailTrace?: "enabled" | "disabled" | "enabled_full";
  transport?: "pi-native";
  /** Optional custom OMP model definitions for providers outside OMP's catalog. */
  models?: Array<Record<string, unknown>>;
}

/**
 * Per-request credential input. `credentialRef` is opaque to OMP and is
 * resolved by the sidecar's configured credential resolver before the child
 * process starts. Raw credentials are never sent in the OMP RPC prompt.
 */
export interface BackendCredentialInput {
  credentials?: BackendCredentials;
  credentialRef?: string;
  /** Internal model context used when resolving an opaque ref. */
  selectedProviderID?: string;
  selectedModelID?: string;
}

/** Model ref as persisted in session records (adds the display id). */
export interface SessionModelRef extends ModelRef {
  id: string;
}

export interface TokenBreakdown {
  input: number;
  output: number;
  reasoning: number;
  cache: {
    read: number;
    write: number;
  };
}

/** Aggregate timing and usage for the raw model requests in one visible turn. */
export interface TurnTelemetry {
  turnUsage?: TokenBreakdown;
  modelDurationMs?: number;
  ttftMs?: number;
  ttftSamples?: number;
}

// ---------------------------------------------------------------------------
// Prompt body image content
// ---------------------------------------------------------------------------

export interface ImageContent {
  type: "image";
  data: string; // base64 encoded image data
  mimeType: string;
}

// ---------------------------------------------------------------------------
// Tool part state (SSE assembly)
// ---------------------------------------------------------------------------

export interface ToolPartState {
  status: "pending" | "running" | "completed" | "error";
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  /** Backend-side facts about the call that the client contract carries alongside the output. */
  metadata?: Record<string, unknown>;
  time?: { start: number; end?: number };
}

// ---------------------------------------------------------------------------
// Todo protocol
// ---------------------------------------------------------------------------

export interface OpenCodeTodo {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority: string;
}

// ---------------------------------------------------------------------------
// Session / transcript records
// ---------------------------------------------------------------------------

export interface OpenCodeSession {
  id: string;
  slug: string;
  projectID: string;
  directory: string;
  path: string;
  title?: string;
  parentID?: string;
  agent: string;
  model: SessionModelRef;
  version: string;
  time: { created: number; updated: number; archived?: number; viewed?: number };
  revert?: { messageID: string; partID?: string; snapshot?: string; files?: unknown[] };
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  metadata?: Record<string, unknown>;
}

export interface OpenCodeTextPart {
  id: string;
  type: "text" | "reasoning";
  text: string;
  synthetic?: boolean;
  time?: { start: number; end?: number };
  messageID: string;
  sessionID: string;
}

/** Text parts received in an OpenCode prompt before the sidecar assigns IDs. */
export interface OpenCodePromptTextPart {
  text: string;
  synthetic?: boolean;
}

export interface OpenCodeFilePart {
  id: string;
  type: "file";
  mime?: string;
  filename?: string;
  url: string;
  messageID: string;
  sessionID: string;
}

export interface OpenCodeToolPart {
  id: string;
  type: "tool";
  callID: string;
  tool: string;
  state: {
    status: "pending" | "running" | "completed" | "error";
    input?: Record<string, unknown>;
    output?: string;
    error?: string;
    /** Backend facts the client contract carries alongside the output (e.g. the todo list a call produced). */
    metadata?: Record<string, unknown>;
    time: { start: number; end?: number };
  };
  metadata?: { toolCallId?: string };
  messageID: string;
  sessionID: string;
}

export type OpenCodePart = OpenCodeTextPart | OpenCodeToolPart | OpenCodeFilePart;

export interface OpenCodeMessageRecord {
  info: {
    id: string;
    role: string;
    sessionID: string;
    parentID?: string;
    agent: string;
    model: { id?: string; providerID: string; modelID: string; variant: string };
    providerID?: string;
    modelID?: string;
    variant?: string;
    mode?: string;
    path?: { cwd: string; root: string };
    metadata?: Record<string, unknown>;
    cost?: number;
    tokens?: {
      input: number;
      output: number;
      reasoning: number;
      cache: { read: number; write: number };
    };
    finish?: string;
    error?: unknown;
    summary?: boolean;
    time: { created: number; completed?: number };
  };
  parts: Array<OpenCodeTextPart | OpenCodeToolPart | OpenCodeFilePart>;
}

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

/**
 * Feature matrix consulted by the sidecar to gate backend-specific routes.
 * `compact` and `shell` gate OpenCode routes that are backed by omp-RPC
 * methods (`summarize`, `bash`); a backend without them returns 501/400.
 */
export interface BackendCapabilities {
  thinkingLevels: boolean;
  images: boolean;
  approvals: boolean;
  subagents: boolean;
  todo: boolean;
  titleGeneration: boolean;
  skills: boolean;
  compact: boolean;
  shell: boolean;
  /** The backend runs goals itself (the agent ends them); the host must not drive its own loop. */
  goals: boolean;
}

/** The backend's own goal for a session (omp goal mode): it, not the host, decides when the goal is done. */
export interface BackendGoalSnapshot {
  status: "active" | "paused" | "complete" | "budget-limited" | "dropped";
  objective: string;
  tokensUsed: number;
  tokenBudget?: number;
}

export type BackendGoalOp = "create" | "resume" | "pause" | "drop";

export interface SessionUpdateInput {
  title?: string;
  metadata?: Record<string, unknown>;
  agent?: string;
  model?: ModelRef;
  revert?: { messageID: string; partID?: string; snapshot?: string; files?: unknown[] } | null;
  time?: { created?: number; updated?: number; archived?: number | null; viewed?: number };
}

/** Persistent session storage owned by a backend. */
export interface SessionStore {
  create(
    directory: string | null | undefined,
    init?: { id?: string; title?: string; parentID?: string; agent?: string; model?: ModelRef; metadata?: Record<string, unknown> },
  ): Promise<OpenCodeSession>;
  get(openCodeId: string, directory?: string | null): Promise<OpenCodeSession | null>;
  list(
    directory?: string | null,
    options?: { all?: boolean; limit?: number; archived?: boolean; search?: string },
  ): Promise<OpenCodeSession[]>;
  delete(openCodeId: string, directory?: string | null): Promise<boolean>;
  update(
    openCodeId: string,
    updates: SessionUpdateInput,
    directory?: string | null,
  ): Promise<OpenCodeSession | null>;
  /** Commit a staged revert by removing the boundary message and its tail. */
  commitRevert(openCodeId: string, messageID: string, directory?: string | null): Promise<boolean>;
  /** The backend moved this session to another transcript file: keep answering to the same id from there. */
  adoptTranscript?(openCodeId: string, transcriptPath: string, cwd: string): Promise<void>;
  /** Create a session forked from `openCodeId`, optionally excluding the transcript from `before` onward. */
  fork(openCodeId: string, directory: string, before?: string): Promise<OpenCodeSession | null>;
  move(openCodeId: string, directory: string, sourceDirectory?: string | null): Promise<OpenCodeSession | null>;
  setTitle(openCodeId: string, title: string, source: "auto" | "user", cwd: string): Promise<void>;
  children(parentOpenCodeId: string, directory?: string | null): Promise<OpenCodeSession[]>;
  transcript(openCodeId: string, cwd: string): Promise<OpenCodeMessageRecord[] | null>;
  /** Records the visible prompt parts a client message id was sent with (the transcript holds the full prompt). */
  recordUserMessage?(openCodeId: string, text: string, messageId?: string, parts?: OpenCodePromptTextPart[]): void;
  getTodos?(openCodeId: string, cwd: string): Promise<OpenCodeTodo[] | undefined>;
}

/** One agent backend (omp, fake, later Claude Code / Codex). */
export interface AgentBackend {
  /** Stable backend id; also the session-id prefix for non-legacy sessions. */
  id: string;
  label: string;
  capabilities: BackendCapabilities;
  defaultModel: ModelRef;
  listModels(cwd: string, auth?: BackendCredentialInput): Promise<OpenCodeProvidersResponse>;
  store: SessionStore;
  /**
   * True when another live process (a terminal omp) owns the session's transcript.
   * `undefined` when ownership could not be determined (probe failed or omp reported the id unknown).
   */
  sessionOwnedElsewhere?(cwd: string, transcriptPath: string): Promise<boolean | undefined>;
  shutdownAll(): void;
}
