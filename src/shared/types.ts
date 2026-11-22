/**
 * Shared wire and domain types: the OpenCode protocol shapes the sidecar
 * serves (providers, sessions, messages, parts) and the omp-side inputs it
 * maps from (credentials, goal snapshot). A leaf module: it imports nothing.
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
// omp goal
// ---------------------------------------------------------------------------

/** omp's own goal for a session (goal mode): omp, not the host, decides when the goal is done. */
export interface BackendGoalSnapshot {
  status: "active" | "paused" | "complete" | "budget-limited" | "dropped";
  objective: string;
  tokensUsed: number;
  tokenBudget?: number;
}

export type BackendGoalOp = "create" | "resume" | "pause" | "drop";
