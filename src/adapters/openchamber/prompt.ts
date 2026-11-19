import { allBackends, backendById, backendForSession, nativeProviderID, splitProviderPrefix } from "../../providers/registry";
import type {
  BackendSubagentSnapshot,
  BackendCredentialInput,
  BackendTurnConnection,
  ImageContent,
  ModelRef,
  NormalizedTurnEvent,
  OpenCodePromptTextPart,
  ToolPartState,
  TokenBreakdown,
  TurnPromptInput,
  TurnTelemetry,
} from "../../providers/types";
import { CredentialInputError, credentialInputFingerprint } from "../../providers/omp/credentials";
import { promptLogger } from "../../shared/logger";
import { isLowSignalTitleInput, normalizeGeneratedTitle } from "../../providers/omp/title";
import {
  emitMessagePartDelta,
  emitMessagePartUpdated,
  emitMessageUpdated,
  emitSessionCreated,
  emitSessionUpdated,
  emitSessionIdle,
  emitSessionStatus,
  emitSessionError,
  emitTodoUpdated,
  emitOpenChamberSessionTodos,
  emitPermissionAsked,
  emitQuestionAsked,
  emitPermissionReplied,
  emitQuestionReplied,
  emitQuestionRejected,
  emitFormCreated,
  emitFormSettled,
  emitSessionCompactionStarted,
  emitSessionCompacted,
  emitOpenCodeV2Event,
} from "../../shared/sse";
import { toV2FileAttachment } from "./v2";
import {
  addPendingPermission,
  addPendingQuestion,
  toOpenCodePermissionRequest,
  toOpenCodeFormRequest,
  clearSessionApprovals,
  type PermissionRequest,
  type QuestionRequest,
} from "./approvals";
import { normalizeToolInput, normalizeToolOutput } from "../../shared/tool-normalize";
import { isBlobRef, readBlobBufferSync } from "../../shared/blobs";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

interface OpenCodeTextPart {
  type: "text";
  text?: string;
  synthetic?: boolean;
}

type OpenCodePart = OpenCodeTextPart | { type: "file" | "image" | string; [key: string]: unknown } | Record<string, unknown>;

type PromptDelivery = "steer" | "queue";

interface PromptFile {
  uri: string;
  name?: string;
  description?: string;
  mention?: { start: number; end: number; text: string };
}

interface PromptBody {
  parts?: OpenCodePart[];
  messageID?: string;
  id?: string | null;
  text?: string;
  files?: PromptFile[];
  agents?: Array<{ name: string; mention?: { start: number; end: number; text: string } }>;
  skills?: Array<{ id: string; mention?: { start: number; end: number; text: string } }>;
  metadata?: Record<string, unknown>;
  resume?: boolean;
  delivery?: PromptDelivery | null;
  model?: { providerID?: string; modelID?: string };
  variant?: string;
  credentials?: BackendCredentialInput["credentials"];
  credentialRef?: string;
}

interface SessionState {
  conn: BackendTurnConnection;
  busy: boolean;
  openCodeId: string;
  cwd: string;
  sessionPath: string;
  unsubscribe: () => void;
  currentModel: ModelRef;
  /** Hash of the explicit credential input that created this child, if any. */
  credentialFingerprint?: string;
  /**
   * Inbox items announced to OpenChamber (`session.inbox.enqueued`) in send
   * order, waiting for omp to append the message to its transcript. omp
   * appends in the same order it accepted them, so a FIFO pop is the match.
   */
  pendingInbox: string[];
  /** Releases the child once it has been idle for OC_CHILD_IDLE_MS. */
  idleTimer?: ReturnType<typeof setTimeout>;
}

function sessionKey(openCodeId: string, cwd: string): string {
  return `${openCodeId}\0${cwd}`;
}

const sessionStates = new Map<string, SessionState>();
const sessionBusyLocks = new Set<string>();
/**
 * How long an idle omp child keeps its session. omp owns a session through a
 * lease held for as long as its process lives, so an idle child that lingers
 * makes a terminal omp resuming the same session fork it instead of taking it
 * over. 0 keeps children until the sidecar stops.
 */
function childIdleMs(): number {
  const configured = Number(process.env.OC_CHILD_IDLE_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : 120_000;
}

function cancelIdleRelease(state: SessionState): void {
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = undefined;
}

function scheduleIdleRelease(state: SessionState): void {
  cancelIdleRelease(state);
  const ms = childIdleMs();
  if (ms === 0) return;
  state.idleTimer = setTimeout(() => void releaseIdleChild(state), ms);
  state.idleTimer.unref?.();
}

async function releaseIdleChild(state: SessionState): Promise<void> {
  const key = sessionKey(state.openCodeId, state.cwd);
  const release = await acquireSessionLock(key);
  try {
    if (sessionStates.get(key) !== state || state.busy) return;
    // Background work (an async task, a subagent) may still wake the session.
    const settled = await state.conn.isSettled?.().catch(() => false) ?? true;
    if (!settled) return scheduleIdleRelease(state);
    state.unsubscribe();
    state.conn.kill();
    clearSubagentStatuses(key);
    sessionStates.delete(key);
  } finally {
    release();
  }
}

/**
 * omp moves a session to a sibling transcript when another live process holds
 * its lease. If this child did, the OpenChamber session continues in the new
 * file; the original stays with whoever owns it.
 */
async function followMovedTranscript(state: SessionState): Promise<void> {
  try {
    const file = await state.conn.getSessionFile?.();
    if (!file || file === state.sessionPath) return;
    const backend = backendForSession(state.openCodeId);
    await backend.store.adoptTranscript?.(state.openCodeId, file, state.cwd);
    state.sessionPath = file;
    promptLogger.info({ sessionID: state.openCodeId, file }, "[prompt] omp moved the session to a new transcript; following it");
  } catch (err) {
    promptLogger.warn({ err, sessionID: state.openCodeId }, "[prompt] could not check for a moved transcript");
  }
}

const syntheticContext = new Map<string, Array<{ text: string; description?: string; metadata?: Record<string, unknown> }>>();

interface SubagentStatusScope {
  key: string;
  directory: string;
}

interface StoredSubagentStatus {
  status: { type: string };
  scopeKey?: string;
  directory?: string;
}

const subagentStatusMap = new Map<string, StoredSubagentStatus>();

function clearSubagentStatuses(scopeKey: string): void {
  for (const [childOpenCodeId, entry] of subagentStatusMap) {
    if (entry.scopeKey === scopeKey) subagentStatusMap.delete(childOpenCodeId);
  }
}

export function removeSessionState(openCodeId: string, cwd: string): void {
  clearSessionApprovals(openCodeId);
  const key = sessionKey(openCodeId, cwd);
  syntheticContext.delete(key);
  clearSubagentStatuses(key);
  const state = sessionStates.get(key);
  if (state) {
    cancelIdleRelease(state);
    state.unsubscribe();
    try {
      state.conn.kill();
    } catch {
      /* ignore */
    }
    sessionStates.delete(key);
  }
}

/** Store v2 synthetic context until the following user prompt is dispatched. */
export function addSessionSyntheticContext(
  openCodeId: string,
  cwd: string,
  input: { id?: string; text: string; description?: string; metadata?: Record<string, unknown> },
): { id: string; sessionID: string; time: { created: number }; type: "synthetic"; payload: { text: string; description?: string; metadata?: Record<string, unknown> }; delivery: "queue" } {
  const id = input.id || makeMessageId(openCodeId);
  const entry = { text: input.text, description: input.description, metadata: input.metadata };
  const key = sessionKey(openCodeId, cwd);
  syntheticContext.set(key, [...(syntheticContext.get(key) ?? []), entry]);
  emitOpenCodeV2Event("session.synthetic", {
    sessionID: openCodeId,
    text: input.text,
    description: input.description,
    metadata: input.metadata,
  }, cwd, id.startsWith("msg_") ? `evt_${id.slice(4)}` : undefined);
  return {
    id,
    sessionID: openCodeId,
    time: { created: Date.now() },
    type: "synthetic",
    payload: { text: input.text, description: input.description, metadata: input.metadata },
    delivery: "queue",
  };
}


async function acquireSessionLock(key: string): Promise<() => void> {
  while (sessionBusyLocks.has(key)) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 5);
    await promise;
  }
  sessionBusyLocks.add(key);
  return () => {
    sessionBusyLocks.delete(key);
  };
}

function isPromptBody(value: unknown): value is PromptBody {
  if (value == null || typeof value !== "object") return false;
  if ("parts" in value && !Array.isArray(value.parts)) return false;
  if ("messageID" in value && typeof value.messageID !== "string") return false;
  if ("id" in value && value.id !== null && typeof value.id !== "string") return false;
  if ("text" in value && typeof value.text !== "string") return false;
  if ("files" in value && (!Array.isArray(value.files) || value.files.some((file) =>
    !file || typeof file !== "object" || typeof (file as Record<string, unknown>).uri !== "string"))) return false;
  if ("agents" in value && (!Array.isArray(value.agents) || value.agents.some((agent) =>
    !agent || typeof agent !== "object" || typeof (agent as Record<string, unknown>).name !== "string"))) return false;
  if ("skills" in value && (!Array.isArray(value.skills) || value.skills.some((skill) =>
    !skill || typeof skill !== "object" || typeof (skill as Record<string, unknown>).id !== "string"))) return false;
  if ("delivery" in value && value.delivery !== null && value.delivery !== "steer" && value.delivery !== "queue") return false;
  if ("model" in value && value.model !== null && typeof value.model === "object") {
    const model = value.model as Record<string, unknown>;
    if ("providerID" in model && typeof model.providerID !== "string") return false;
    if ("modelID" in model && typeof model.modelID !== "string") return false;
  }
  if ("variant" in value && typeof value.variant !== "string") return false;
  if ("credentials" in value) {
    if (value.credentials === null || typeof value.credentials !== "object" || Array.isArray(value.credentials)) return false;
  }
  if ("credentialRef" in value && typeof value.credentialRef !== "string") return false;
  return true;
}

function isTextPart(value: unknown): value is OpenCodeTextPart {
  if (value == null || typeof value !== "object") return false;
  if (!("type" in value)) return false;
  const t = value.type;
  if (t !== "text") return false;
  if ("text" in value) {
    if (typeof value.text !== "string") return false;
  }
  if ("synthetic" in value && typeof value.synthetic !== "boolean") return false;
  return true;
}

const IMAGE_EXT_TO_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
};

export function mimeFromPath(pathOrUrl: string): string | undefined {
  const clean = pathOrUrl.split("?")[0].split("#")[0];
  const dot = clean.lastIndexOf(".");
  if (dot !== -1) {
    const ext = clean.slice(dot).toLowerCase();
    return IMAGE_EXT_TO_MIME[ext];
  }
  return undefined;
}

async function resolveImageFromUrl(
  url: string,
  explicitMime?: string,
  cwd?: string,
): Promise<ImageContent | undefined> {
  if (url.startsWith("data:")) {
    const commaIndex = url.indexOf(",");
    if (commaIndex === -1) return undefined;
    const meta = url.slice(5, commaIndex);
    const data = url.slice(commaIndex + 1);
    const mimeMatch = meta.match(/^([^;,]+)/);
    const mimeType = explicitMime || (mimeMatch ? mimeMatch[1] : undefined) || "image/png";
    return {
      type: "image",
      data,
      mimeType,
    };
  }

  if (isBlobRef(url)) {
    const buffer = readBlobBufferSync(url);
    if (buffer) {
      return {
        type: "image",
        data: buffer.toString("base64"),
        mimeType: explicitMime || "image/png",
      };
    }
  }

  let filePath = url;
  if (filePath.startsWith("file://")) {
    try {
      filePath = new URL(filePath).pathname;
    } catch {
      filePath = filePath.slice(7);
    }
  }

  if (cwd && !isAbsolute(filePath)) {
    filePath = resolve(cwd, filePath);
  }

  try {
    const buffer = await readFile(filePath);
    const mimeType = explicitMime || mimeFromPath(filePath) || "image/png";
    return {
      type: "image",
      data: buffer.toString("base64"),
      mimeType,
    };
  } catch (err) {
    promptLogger.warn({ err, url, filePath }, `[prompt] failed to read image from ${filePath}`);
    return undefined;
  }
}

export async function extractPromptImages(body: PromptBody, cwd?: string): Promise<ImageContent[]> {
  const images: ImageContent[] = [];

  const parts: OpenCodePart[] = [
    ...(Array.isArray(body.parts) ? body.parts : []),
    ...(body.files ?? []).map((file) => ({
      type: "file" as const,
      url: file.uri,
      filename: file.name,
      mime: mimeFromPath(file.name ?? file.uri),
    })),
  ];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    const type = p.type;

    if (type === "image") {
      const mimeType =
        (typeof p.mimeType === "string" ? p.mimeType : undefined) ||
        (typeof p.mime === "string" ? p.mime : undefined);
      if (typeof p.data === "string" && p.data.length > 0) {
        if (isBlobRef(p.data)) {
          const buffer = readBlobBufferSync(p.data);
          if (buffer) {
            images.push({
              type: "image",
              data: buffer.toString("base64"),
              mimeType: mimeType || "image/png",
            });
          }
        } else {
          const rawData = String(p.data).replace(/^data:[^;,]+;base64,/, "");
          images.push({
            type: "image",
            data: rawData,
            mimeType: mimeType || "image/png",
          });
        }
      } else if (typeof p.url === "string" && p.url.length > 0) {
        const img = await resolveImageFromUrl(p.url, mimeType, cwd);
        if (img) images.push(img);
      }
    } else if (type === "file") {
      const mime =
        (typeof p.mime === "string" ? p.mime : undefined) ||
        (typeof p.mimeType === "string" ? p.mimeType : undefined);
      const url = typeof p.url === "string" ? p.url : "";
      const filename = typeof p.filename === "string" ? p.filename : "";
      const inferredMime = mime || mimeFromPath(filename) || mimeFromPath(url);

      const isImage =
        (inferredMime && inferredMime.startsWith("image/")) ||
        url.startsWith("data:image/") ||
        isBlobRef(url) ||
        (inferredMime !== undefined && inferredMime in IMAGE_EXT_TO_MIME);

      if (isImage) {
        if (typeof p.data === "string" && p.data.length > 0) {
          if (isBlobRef(p.data)) {
            const buffer = readBlobBufferSync(p.data);
            if (buffer) {
              images.push({
                type: "image",
                data: buffer.toString("base64"),
                mimeType: inferredMime || "image/png",
              });
            }
          } else {
            const rawData = String(p.data).replace(/^data:[^;,]+;base64,/, "");
            images.push({
              type: "image",
              data: rawData,
              mimeType: inferredMime || "image/png",
            });
          }
        } else if (url) {
          const img = await resolveImageFromUrl(url, inferredMime, cwd);
          if (img) images.push(img);
        }
      }
    }
  }

  return images;
}

function extractPromptTextParts(body: PromptBody): OpenCodePromptTextPart[] {
  const parts: OpenCodePromptTextPart[] = [];
  if (typeof body.text === "string" && body.text.length > 0) parts.push({ text: body.text });
  for (const part of body.parts ?? []) {
    if (isTextPart(part) && part.text) {
      parts.push({
        text: part.text,
        ...(part.synthetic === true ? { synthetic: true } : {}),
      });
    }
  }
  return parts;
}

async function extractPromptFileText(body: PromptBody, cwd: string): Promise<string[]> {
  const files = [
    ...(body.files ?? []).map((file) => ({ uri: file.uri, name: file.name })),
    ...(body.parts ?? []).flatMap((part) => {
      if (!part || typeof part !== "object" || !((part as Record<string, unknown>).type === "file")) return [];
      const value = part as Record<string, unknown>;
      const uri = typeof value.url === "string" ? value.url : "";
      return uri ? [{ uri, name: typeof value.filename === "string" ? value.filename : undefined }] : [];
    }),
  ];
  const textExtensions = new Set([
    ".c", ".cc", ".cpp", ".css", ".csv", ".go", ".h", ".hpp", ".html", ".ini", ".java", ".js", ".json",
    ".jsx", ".md", ".mdx", ".mjs", ".py", ".rb", ".rs", ".sh", ".sql", ".svg", ".toml", ".ts", ".tsx",
    ".txt", ".xml", ".yaml", ".yml",
  ]);
  const contexts: string[] = [];
  for (const file of files) {
    if (!file.uri || isBlobRef(file.uri)) continue;
    let filePath = file.uri;
    const label = file.name || file.uri;
    if (filePath.startsWith("data:")) {
      const match = filePath.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/s);
      const isBase64 = /^data:[^,]*;base64,/i.test(filePath);
      if (!match) continue;
      const extensionSource = file.name ?? "";
      if (!textExtensions.has(extensionSource.slice(extensionSource.lastIndexOf(".")).toLowerCase())) continue;
      try {
        const content = isBase64
          ? Buffer.from(match[2] ?? "", "base64").toString("utf8")
          : decodeURIComponent(match[2] ?? "");
        if (content.length <= 2 * 1024 * 1024 && !content.includes("\0")) {
          contexts.push(`Attached file: ${label}\n\n${content}`);
        }
      } catch {
        /* malformed inline text attachment */
      }
      continue;
    }
    try {
      if (filePath.startsWith("file://")) filePath = new URL(filePath).pathname;
      if (!isAbsolute(filePath)) filePath = resolve(cwd, filePath);
      const extensionSource = file.name || filePath;
      if (!textExtensions.has(extensionSource.slice(extensionSource.lastIndexOf(".")).toLowerCase())) {
        contexts.push(`Attached file: ${label} (available at ${filePath})`);
        continue;
      }
      const buffer = await readFile(filePath);
      if (buffer.length > 2 * 1024 * 1024 || buffer.includes(0)) {
        contexts.push(`Attached file: ${label} (available at ${filePath})`);
        continue;
      }
      contexts.push(`Attached file: ${label}\n\n${buffer.toString("utf8")}`);
    } catch {
      contexts.push(`Attached file: ${label} (available at ${filePath})`);
    }
  }
  return contexts;
}

function makeMessageId(openCodeId: string, suffix?: string): string {
  return `msg_${openCodeId}_${suffix ?? randomUUID().replace(/-/g, "")}`;
}

/**
 * `ordinal` is the part's position among parts of the same type in its message,
 * from 0: OpenChamber derives its own ids for text and reasoning parts from
 * exactly that (`<message>:text:<ordinal>`), so live events and a transcript
 * fetched later only merge into one part if the ordinals agree. The sse layer
 * reads it back from the trailing digits.
 */
function makePartId(openCodeId: string, messageID: string, type: "text" | "reasoning", ordinal: number): string {
  return `part_${openCodeId}_${messageID}_${type}_${ordinal}`;
}

function defaultModelRef(overrides?: Partial<ModelRef>): ModelRef {
  return {
    providerID: "omp",
    modelID: "omp",
    variant: "default",
    ...overrides,
  };
}

/** omp `set_thinking_level` accepts these; anything else stays on omp's own level. */
const ompThinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function ompThinkingLevel(variant: string | undefined): string | undefined {
  const level = variant?.trim().toLowerCase();
  if (!level) return undefined;
  if (level === "none") return "off";
  return ompThinkingLevels.has(level) ? level : undefined;
}

/** The omp store's stand-in for a session with no recorded model. */
function hasRealModel(model: Partial<ModelRef> | undefined): model is ModelRef {
  return typeof model?.providerID === "string"
    && typeof model?.modelID === "string"
    && !(model.providerID === "omp" && model.modelID === "omp");
}

function emitAssistantInfo(
  openCodeId: string,
  messageID: string,
  parentID: string | undefined,
  model: ModelRef,
  finish?: "stop" | "error" | string,
  cwd?: string,
  createdTime?: number,
  tokens?: TokenBreakdown,
  cost?: number,
  error?: unknown,
  telemetry?: TurnTelemetry,
): void {
  const dir = cwd || process.cwd();
  const created = createdTime ?? Date.now();
  emitMessageUpdated({
    info: {
      id: messageID,
      role: "assistant",
      sessionID: openCodeId,
      parentID,
      agent: "omp",
      mode: "primary",
      cost: cost ?? 0,
      path: { cwd: dir, root: dir },
      metadata: telemetry ? { omp: telemetry } : undefined,
      tokens: tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      model: {
        id: model.modelID,
        providerID: model.providerID,
        modelID: model.modelID,
        variant: model.variant,
      },
      providerID: model.providerID,
      modelID: model.modelID,
      variant: model.variant,
      finish,
      error,
      time: { created, completed: finish ? Date.now() : undefined },
    },
  }, dir);
}

function emitAssistantPart(
  openCodeId: string,
  messageID: string,
  partID: string,
  partType: "text" | "reasoning",
  text: string,
  directory?: string,
  startTime?: number,
  endTime?: number,
): void {
  emitMessagePartUpdated(
    openCodeId,
    {
      id: partID,
      type: partType,
      text,
      time: { start: startTime ?? Date.now(), end: endTime },
      messageID,
      sessionID: openCodeId,
    },
    directory,
  );
}

function buildPromptPayload(
  message: string,
  images: ImageContent[],
  streamingBehavior?: TurnPromptInput["streamingBehavior"],
): TurnPromptInput {
  return {
    message,
    ...(images.length > 0 ? { images } : {}),
    ...(streamingBehavior ? { streamingBehavior } : {}),
  };
}

function recordAndEmitUserPrompt(
  state: SessionState,
  parentMessageID: string | undefined,
  promptText: string,
  promptTextParts: OpenCodePromptTextPart[],
  body: PromptBody,
): void {
  if (!parentMessageID) return;

  const { openCodeId, cwd, currentModel } = state;
  state.pendingInbox.push(parentMessageID);
  if (state.pendingInbox.length > 64) state.pendingInbox.shift();
  backendForSession(openCodeId).store.recordUserMessage?.(
    openCodeId,
    promptText,
    parentMessageID,
    promptTextParts,
  );
  const userMsgTime = Date.now() - 1;
  const filePayload = [
    ...(body.files ?? []).map((file) => toV2FileAttachment({
      ...file,
      mime: mimeFromPath(file.name ?? file.uri) ?? undefined,
    })),
    ...(body.parts ?? []).flatMap((part) => {
      if (!part || typeof part !== "object" || !("type" in part) || (part.type !== "file" && part.type !== "image")) return [];
      const value = part as Record<string, unknown>;
      const mime = (typeof value.mime === "string" ? value.mime : undefined) ??
        (typeof value.mimeType === "string" ? value.mimeType : undefined) ?? "application/octet-stream";
      const uri = typeof value.url === "string" ? value.url : undefined;
      const inline = typeof value.data === "string" ? value.data : undefined;
      const source = uri ?? (inline ? `data:${mime};base64,${inline.replace(/^data:[^,]*,/, "")}` : "");
      return source ? [toV2FileAttachment({
        uri: source,
        mime,
        ...(typeof value.filename === "string" ? { name: value.filename } : {}),
      })] : [];
    }),
  ];
  emitOpenCodeV2Event("session.inbox.enqueued", {
    sessionID: openCodeId,
    inboxID: parentMessageID,
    item: {
      type: "user",
      delivery: body.delivery ?? "queue",
      payload: {
        text: promptText,
        files: filePayload,
        ...(body.agents ? { agents: body.agents } : {}),
        ...(body.skills ? { skills: body.skills } : {}),
        ...(body.metadata ? { metadata: body.metadata } : {}),
      },
    },
  }, cwd);
  emitMessageUpdated(
    {
      info: {
        id: parentMessageID,
        sessionID: openCodeId,
        role: "user",
        agent: "omp",
        model: {
          id: currentModel.modelID,
          providerID: currentModel.providerID,
          modelID: currentModel.modelID,
          variant: currentModel.variant,
        },
        time: { created: userMsgTime, completed: userMsgTime },
      },
    },
    cwd,
  );

  let nextPartIndex = promptTextParts.length;

  // Emit file/image parts before text parts so OpenChamber's event-reducer
  // replaces optimistic file parts in place (it gates optimistic part replacement
  // on the first part lacking sessionID). Emitting text first assigns sessionID
  // to part 0, causing subsequent file parts to be appended as duplicates.
  if (Array.isArray(body.parts) || body.files?.length) {
    const fileParts: OpenCodePart[] = [
      ...(body.parts ?? []),
      ...(body.files ?? []).map((file) => ({ type: "file", url: file.uri, filename: file.name, mime: mimeFromPath(file.name ?? file.uri) })),
    ];
    for (const part of fileParts) {
      if (part && typeof part === "object" && "type" in part && (part.type === "file" || part.type === "image")) {
        const p = part as Record<string, unknown>;
        const mime = (typeof p.mime === "string" ? p.mime : undefined) ||
                     (typeof p.mimeType === "string" ? p.mimeType : undefined) ||
                     "image/png";
        const url = typeof p.url === "string"
          ? p.url
          : (typeof p.data === "string" ? `data:${mime};base64,${p.data}` : "");
        emitMessagePartUpdated(
          openCodeId,
          {
            id: (typeof p.id === "string" ? p.id : undefined) || `part_${openCodeId}_${parentMessageID}_${nextPartIndex++}`,
            type: "file",
            mime,
            url,
            ...(p.filename ? { filename: p.filename } : {}),
            messageID: parentMessageID,
            sessionID: openCodeId,
          },
          cwd,
        );
      }
    }
  }

  for (const [index, part] of promptTextParts.entries()) {
    emitMessagePartUpdated(
      openCodeId,
      {
        id: `part_${openCodeId}_${parentMessageID}_${index}`,
        type: "text",
        text: part.text,
        ...(part.synthetic === true ? { synthetic: true } : {}),
        messageID: parentMessageID,
        sessionID: openCodeId,
      },
      cwd,
    );
  }
}


/**
 * Assembly-only SSE sink: consumes backend-normalized turn events and emits
 * the OpenCode SSE surface. All backend/transport specifics live in the
 * provider adapters (see src/providers/).
 */
export function createEventHandler(
  openCodeId: string,
  parentMessageID: string | undefined,
  model: ModelRef,
  onComplete: () => void,
  cwd?: string,
  pendingInbox?: string[],
): (event: NormalizedTurnEvent) => void {
  const subagentScope = cwd === undefined ? undefined : { key: sessionKey(openCodeId, cwd), directory: cwd };
  let currentParentID = parentMessageID;
  let assistantMessageID: string | undefined;
  let assistantStartTime: number | undefined;
  let currentPartType: "text" | "reasoning" | undefined;
  let activePartId: string | undefined;
  let activePartStartTime: number | undefined;
  let activePartText = "";
  let partIndex = 0;
  const partOrdinals = { text: 0, reasoning: 0 };
  let hasStarted = false;
  let turnTelemetry: TurnTelemetry | undefined;

  const toolParts = new Map<string, { tool: string; state: ToolPartState }>();

  const ensureStarted = () => {
    if (hasStarted) return;
    hasStarted = true;
    assistantStartTime = Date.now();
    assistantMessageID = makeMessageId(
      openCodeId,
      currentParentID ? `asst_${currentParentID}` : `assistant_${assistantStartTime}`,
    );
    emitAssistantInfo(openCodeId, assistantMessageID, currentParentID, model, undefined, cwd, assistantStartTime);
  };

  const finalizeCurrentPart = () => {
    if (!currentPartType || !activePartId || !assistantMessageID) return;
    const now = Date.now();
    emitAssistantPart(
      openCodeId,
      assistantMessageID,
      activePartId,
      currentPartType,
      activePartText,
      cwd,
      activePartStartTime ?? now,
      now,
    );
    currentPartType = undefined;
    activePartId = undefined;
    activePartStartTime = undefined;
    activePartText = "";
  };

  const emitToolPart = (toolCallId: string, tool: string|undefined, state: ToolPartState) => {
    ensureStarted();
    if (!toolParts.has(toolCallId)) {
      finalizeCurrentPart();
    }
    const mid = assistantMessageID!;
    const entry = toolParts.get(toolCallId);
    const validTool = tool && tool !== "tool" ? tool : undefined;
    if (entry) {
      if (validTool) entry.tool = validTool;
      entry.state = state;
    } else {
      toolParts.set(toolCallId, { tool: validTool ?? "tool", state });
    }
    const entryRef = toolParts.get(toolCallId);
    const effectiveTool = entryRef && entryRef.tool !== "tool" ? entryRef.tool : (validTool ?? "tool");
    if (state.input) {
      state.input = normalizeToolInput(effectiveTool, state.input);
    }
    if (state.output !== undefined) {
      state.output = normalizeToolOutput(effectiveTool, state.output);
    }
    emitMessagePartUpdated(openCodeId, {
      id: toolCallId,
      type: "tool",
      callID: toolCallId,
      tool: effectiveTool,
      state,
      messageID: mid,
      sessionID: openCodeId,
    }, cwd);
  };

  let latestTokens: TokenBreakdown = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  let latestCost = 0;

  const emitUsageInfo = () => {
    if (!assistantMessageID) return;
    emitAssistantInfo(
      openCodeId,
      assistantMessageID,
      currentParentID,
      model,
      undefined,
      cwd,
      assistantStartTime,
      latestTokens,
      latestCost,
      undefined,
      turnTelemetry,
    );
  };

  return (event: NormalizedTurnEvent) => {
    switch (event.kind) {
      case "usage": {
        latestTokens = event.tokens;
        latestCost = event.cost;
        emitUsageInfo();
        return;
      }
      case "model": {
        model.providerID = event.model.providerID;
        model.modelID = event.model.modelID;
        model.variant = event.model.variant;
        emitUsageInfo();
        return;
      }
      case "telemetry": {
        turnTelemetry = event.telemetry;
        emitUsageInfo();
        return;
      }
      case "text_delta":
      case "reasoning_delta": {
        ensureStarted();
        const mid = assistantMessageID!;
        const partType: "text" | "reasoning" = event.kind === "reasoning_delta" ? "reasoning" : "text";
        const deltaText = event.text;
        if (currentPartType !== partType) {
          finalizeCurrentPart();
          partIndex++;
          currentPartType = partType;
          activePartId = makePartId(openCodeId, mid, partType, partOrdinals[partType]++);
          activePartStartTime = Date.now();
          activePartText = deltaText;
          emitAssistantPart(openCodeId, mid, activePartId, partType, deltaText, cwd, activePartStartTime);
        } else {
          if (deltaText) {
            activePartText += deltaText;
            emitMessagePartDelta(
              openCodeId,
              mid,
              activePartId ?? makePartId(openCodeId, mid, partType, 0),
              deltaText,
              cwd,
              partType,
            );
          }
        }
        return;
      }
      case "part_end": {
        finalizeCurrentPart();
        return;
      }
      case "tool": {
        emitToolPart(event.callID, event.tool, event.state);
        return;
      }
      case "tool_input_delta": {
        // The tool card already exists (toolcall_start opened it); its argument
        // text fills in live instead of appearing whole when the call ends.
        ensureStarted();
        emitMessagePartDelta(openCodeId, assistantMessageID!, event.callID, event.delta, cwd, "raw");
        return;
      }
      case "todo": {
        emitTodoUpdated(openCodeId, event.todos, cwd);
        emitOpenChamberSessionTodos(
          openCodeId,
          cwd,
          event.todos.map((todo) => ({ content: todo.content, status: todo.status })),
        );
        return;
      }
      case "subagent_started": {
        const childOpenCodeId = event.childId;
        setSubagentStatus(childOpenCodeId, { type: "busy" }, subagentScope);
        emitSessionCreated({
          id: childOpenCodeId,
          slug: childOpenCodeId,
          projectID: "global",
          directory: cwd,
          path: event.sessionFile ?? "",
          title: event.description ?? `Subagent (${event.agent ?? "task"})`,
          parentID: openCodeId,
          agent: event.agent ?? "task",
          model: { id: model.modelID, providerID: model.providerID, modelID: model.modelID, variant: model.variant },
          version: "0.0.0",
          time: { created: Date.now(), updated: Date.now() },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }, cwd);
        emitSessionStatus(childOpenCodeId, { type: "busy" }, cwd);
        return;
      }
      case "subagent_ended": {
        setSubagentStatus(event.childId, undefined, subagentScope);
        emitSessionStatus(event.childId, { type: "idle" }, cwd);
        emitSessionIdle(event.childId, cwd);
        emitSessionUpdated({
          id: event.childId,
          parentID: openCodeId,
          time: { updated: Date.now() },
        }, cwd);
        return;
      }
      case "subagent_failed": {
        setSubagentStatus(event.childId, undefined, subagentScope);
        emitSessionError(event.childId, { message: event.message ?? "Subagent failed" }, cwd);
        emitSessionStatus(event.childId, { type: "idle" }, cwd);
        emitSessionIdle(event.childId, cwd);
        emitSessionUpdated({
          id: event.childId,
          parentID: openCodeId,
          time: { updated: Date.now() },
        }, cwd);
        return;
      }
      case "subagent_status": {
        if (event.status === "busy") {
          setSubagentStatus(event.childId, { type: "busy" }, subagentScope);
          emitSessionStatus(event.childId, { type: "busy" }, cwd);
        } else {
          setSubagentStatus(event.childId, undefined, subagentScope);
          emitSessionStatus(event.childId, { type: "idle" }, cwd);
          emitSessionIdle(event.childId, cwd);
        }
        return;
      }
      case "permission_request": {
        finalizeCurrentPart();
        const permReq: PermissionRequest = {
          id: event.id,
          sessionID: openCodeId,
          permission: event.permission,
          patterns: [],
          metadata: event.metadata,
          always: [],
          tool: assistantMessageID ? { messageID: assistantMessageID, callID: event.id } : undefined,
          directory: cwd,
        };
        addPendingPermission(permReq, (res) => {
          emitPermissionReplied(permReq.sessionID, permReq.id, res.cancelled ? "reject" : "once", cwd);
          event.respond(res);
        });
        emitPermissionAsked(toOpenCodePermissionRequest(permReq) as unknown as Record<string, unknown>, cwd);
        return;
      }
      case "question_request": {
        finalizeCurrentPart();
        const qReq: QuestionRequest = {
          id: event.id,
          sessionID: openCodeId,
          questions: event.questions,
          tool: assistantMessageID ? { messageID: assistantMessageID, callID: event.id } : undefined,
          directory: cwd,
        };
        addPendingQuestion(qReq, (res) => {
          if (res.cancelled) {
            emitQuestionRejected(qReq.sessionID, qReq.id, cwd);
          } else {
            emitQuestionReplied(qReq.sessionID, qReq.id, [[res.value ?? ""]], cwd);
          }
          emitFormSettled(qReq.sessionID, qReq.id, cwd);
          event.respond(res);
        });
        emitQuestionAsked(qReq as unknown as Record<string, unknown>, cwd);
        emitFormCreated(toOpenCodeFormRequest(qReq) as unknown as Record<string, unknown>, cwd);
        return;
      }
      case "compaction_start": {
        finalizeCurrentPart();
        emitSessionCompactionStarted(openCodeId, cwd);
        return;
      }
      case "compaction_end": {
        finalizeCurrentPart();
        if (!event.aborted) {
          emitSessionCompacted(openCodeId, cwd);
        }
        return;
      }
      case "user_message": {
        // omp appended one of the inbox items this sidecar announced. Without
        // the delivery ACK OpenChamber keeps it as a pending inbox entry,
        // pinned after the streaming assistant message instead of becoming a
        // turn boundary in the history.
        const inboxID = pendingInbox?.shift();
        if (!inboxID) return;
        emitOpenCodeV2Event("session.inbox.delivered", { sessionID: openCodeId, inboxID }, cwd);
        if (!hasStarted || !assistantMessageID) {
          currentParentID = inboxID;
          return;
        }
        // omp interrupted the running assistant message to apply the steer, and
        // records the interruption (`stopReason: aborted`) followed by a new
        // assistant message. Mirror that boundary instead of gluing both
        // halves into one OpenChamber step.
        finalizeCurrentPart();
        emitAssistantInfo(
          openCodeId,
          assistantMessageID,
          currentParentID,
          model,
          "aborted",
          cwd,
          assistantStartTime,
          latestTokens,
          latestCost,
          undefined,
          turnTelemetry,
        );
        hasStarted = false;
        assistantMessageID = undefined;
        assistantStartTime = undefined;
        partIndex = 0;
        partOrdinals.text = 0;
        partOrdinals.reasoning = 0;
        currentParentID = inboxID;
        return;
      }
      case "turn_end": {
        finalizeCurrentPart();
        const isError = event.stopReason === "error" || Boolean(event.error) || (typeof event.error === "string" && event.error.length > 0);
        const rawError = event.error;
        if (isError) {
          if (!hasStarted) {
            ensureStarted();
          }
          if (assistantMessageID && partIndex === 0 && !activePartText && toolParts.size === 0) {
            const errText = rawError ? `⚠️ **Provider Error**: ${rawError}` : "⚠️ **Provider Error**: Turn ended with error.";
            emitAssistantPart(
              openCodeId,
              assistantMessageID,
              makePartId(openCodeId, assistantMessageID, "text", 0),
              "text",
              errText,
              cwd,
              assistantStartTime,
              Date.now(),
            );
          }
          if (assistantMessageID) {
            emitAssistantInfo(
              openCodeId,
              assistantMessageID,
              currentParentID,
              model,
              "error",
              cwd,
              assistantStartTime,
              latestTokens,
              latestCost,
              rawError ? { message: rawError } : { message: "Turn ended with error" },
              turnTelemetry,
            );
          }
          emitSessionError(openCodeId, { message: rawError || "Turn ended with error" }, cwd);
        } else {
          if (assistantMessageID) {
            emitAssistantInfo(openCodeId, assistantMessageID, currentParentID, model, "stop", cwd, assistantStartTime, latestTokens, latestCost, undefined, turnTelemetry);
          }
        }
        onComplete();
        return;
      }
    }
  };
}

async function getOrCreateSessionState(
  openCodeId: string,
  cwd: string,
  sessionPath: string,
  auth?: BackendCredentialInput,
): Promise<SessionState> {
  const key = sessionKey(openCodeId, cwd);
  const requestedCredentialFingerprint = auth ? credentialInputFingerprint(auth) : undefined;
  const existing = sessionStates.get(key);
  if (existing) {
    // Reuse a persistent child when the caller repeats the same envelope. A
    // changed direct credential, provider selection, or opaque ref replaces
    // the child so its isolated models.yml matches the new request.
    // A child that died (crash, OOM kill) is never reusable: respawn instead of
    // sending the next prompt into a closed pipe.
    const dead = existing.conn.isAlive?.() === false;
    const mustReplace = dead || (auth !== undefined && existing.credentialFingerprint !== requestedCredentialFingerprint);
    if (!mustReplace) return existing;

    cancelIdleRelease(existing);
    existing.unsubscribe();
    existing.conn.kill();
    sessionStates.delete(key);
  }

  const backend = backendForSession(openCodeId);
  const conn = auth === undefined
    ? await backend.createTurnConnection(cwd, sessionPath, openCodeId)
    : await backend.createTurnConnection(cwd, sessionPath, openCodeId, auth);

  const modelFromRpc = await conn.getInitialModel?.();

  const state: SessionState = {
    conn,
    busy: false,
    openCodeId,
    cwd,
    sessionPath,
    unsubscribe: () => {},
    credentialFingerprint: requestedCredentialFingerprint,
    currentModel: defaultModelRef({
      providerID: modelFromRpc?.providerID ?? "omp",
      modelID: modelFromRpc?.modelID ?? "omp",
      variant: modelFromRpc?.variant ?? "default",
    }),
    pendingInbox: [],
  };

  sessionStates.set(key, state);
  return state;
}

/**
 * Pushes the model the user picked onto the live omp child.
 *
 * The model switch is strict: a turn must never run on whatever model the child
 * booted with (omp's configured default role). The reasoning effort is best
 * effort — omp clamps it to what the active model supports, and a level omp
 * rejects must not cancel an otherwise valid turn.
 */
async function applyModelRef(state: SessionState, model: ModelRef, strict: boolean): Promise<void> {
  const sameModel = state.currentModel.providerID === model.providerID
    && state.currentModel.modelID === model.modelID;
  if (!sameModel) {
    try {
      await state.conn.setModel(nativeProviderID(model.providerID), model.modelID);
    } catch (err) {
      if (!strict) {
        promptLogger.error({ err, sessionID: state.openCodeId }, `[prompt] ${state.openCodeId} set_model failed`);
        return;
      }
      // The turn is aborted: tag the failure with the model the user asked for,
      // not the one the child would otherwise have used.
      state.currentModel = defaultModelRef(model);
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`could not switch to ${model.providerID}/${model.modelID}: ${reason}`);
    }
  }
  const level = ompThinkingLevel(model.variant);
  // A model switch resets the effort to that model's default, so re-assert it.
  if (level && state.conn.setThinkingLevel && (level !== ompThinkingLevel(state.currentModel.variant) || !sameModel)) {
    await state.conn.setThinkingLevel(level).catch((err) => {
      promptLogger.warn({ err, sessionID: state.openCodeId, level }, `[prompt] ${state.openCodeId} thinking level ${level} rejected`);
    });
  }
  state.currentModel = defaultModelRef(model);
}

/**
 * Applies a model the user just picked to this session's live child, if it has
 * one. With no live child there is nothing to push: the next prompt reads the
 * stored model back out of the session record and applies it then.
 */
export async function applySessionModel(
  openCodeId: string,
  cwd: string,
  model: ModelRef,
): Promise<{ applied: boolean; error?: string }> {
  const state = sessionStates.get(sessionKey(openCodeId, cwd));
  if (!state || state.conn.isAlive?.() === false) return { applied: false };
  try {
    await applyModelRef(state, model, true);
    return { applied: true };
  } catch (err) {
    return { applied: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function promptSessionAsync(
  openCodeId: string,
  cwd: string,
  sessionPath: string,
  body: unknown,
  /** The session's own model, from the session record the route already resolved. */
  sessionModel?: Partial<ModelRef>,
): Promise<{ queued: boolean; messageID?: string; error?: string; status?: number }> {
  if (!isPromptBody(body)) {
    return { queued: false, error: "invalid body", status: 400 };
  }

  const promptTextParts = extractPromptTextParts(body);
  const userPromptTextParts = promptTextParts.filter((part) => part.synthetic !== true);
  const userPromptText = userPromptTextParts.map((part) => part.text).join("\n\n");
  const contextKey = sessionKey(openCodeId, cwd);
  const queuedContext = syntheticContext.get(contextKey) ?? [];
  const fileContext = await extractPromptFileText(body, cwd);
  const promptText = [
    ...queuedContext.map((item) => item.text),
    ...promptTextParts.filter((part) => part.synthetic === true).map((part) => part.text),
    userPromptText,
    ...fileContext,
  ].filter(Boolean).join("\n\n");
  const visiblePromptText = userPromptText;
  const images = await extractPromptImages(body, cwd);
  if (!promptText && images.length === 0) {
    return { queued: false, error: "no text parts", status: 400 };
  }
  // D1: a namespaced model prefix must match the backend that owns this
  // session; a session is bound to its backend for its lifetime.
  const requestedPrefix = splitProviderPrefix(body.model?.providerID ?? "").backendId;
  if (requestedPrefix && backendById(requestedPrefix) !== backendForSession(openCodeId)) {
    return { queued: false, status: 400, error: "model provider does not belong to this session's backend" };
  }

  // OpenCode's v2 prompt body carries no model field: the model the user picked
  // lives on the session record (set at create, or by POST /session/:id/model).
  // Falling back to it is what makes that pick real — without it every turn ran
  // on whatever model the omp child booted with, i.e. omp's default role.
  const modelRef: ModelRef | undefined = body.model?.providerID && body.model?.modelID
    ? defaultModelRef({
        providerID: nativeProviderID(body.model.providerID),
        modelID: body.model.modelID,
        variant: body.variant ?? "default",
      })
    : hasRealModel(sessionModel)
      ? defaultModelRef({
          providerID: nativeProviderID(sessionModel.providerID),
          modelID: sessionModel.modelID,
          variant: sessionModel.variant ?? "default",
        })
      : undefined;
  const hasCredentials = body.credentials !== undefined;
  const hasCredentialRef = body.credentialRef !== undefined;
  if (hasCredentials && hasCredentialRef) {
    return { queued: false, error: "provide exactly one of credentials or credentialRef", status: 400 };
  }
  const auth: BackendCredentialInput | undefined = hasCredentials
    ? {
        credentials: body.credentials,
        selectedProviderID: modelRef?.providerID,
        selectedModelID: modelRef?.modelID,
      }
    : hasCredentialRef
      ? {
          credentialRef: body.credentialRef,
          selectedProviderID: modelRef?.providerID,
          selectedModelID: modelRef?.modelID,
        }
      : undefined;

  const key = sessionKey(openCodeId, cwd);
  const release = await acquireSessionLock(key);

  try {
    let state: SessionState;
    try {
      state = await getOrCreateSessionState(openCodeId, cwd, sessionPath, auth);
    } catch (err) {
      if (err instanceof CredentialInputError) {
        return { queued: false, error: err.message, status: err.statusCode };
      }
      throw err;
    }

    if (state.busy) {
      const delivery = body.delivery ?? "queue";

      // Steering is an additional input to the active OMP turn, not a second
      // sidecar turn. Keep the existing event subscription and busy lifecycle
      // intact while forwarding OMP's streaming behavior explicitly.
      const parentMessageID = body.id ?? body.messageID ?? makeMessageId(openCodeId);
      syntheticContext.delete(contextKey);
      recordAndEmitUserPrompt(state, parentMessageID, userPromptText, userPromptTextParts, body);
      // The turn already running keeps its model; omp applies this to the turns
      // that follow. A failure here must not drop the steered message.
      if (modelRef) await applyModelRef(state, modelRef, false);
      void state.conn.prompt(buildPromptPayload(promptText, images, delivery === "steer" ? "steer" : "followUp")).catch((err) => {
        emitSessionError(openCodeId, err, cwd);
        promptLogger.error({ err, sessionID: openCodeId }, `[prompt] ${openCodeId} steering acknowledgement failed`);
      });
      return { queued: true, messageID: parentMessageID };
    }

    cancelIdleRelease(state);
    state.busy = true;
    backendForSession(openCodeId).store.beforeTurn?.(openCodeId, cwd);
    emitSessionStatus(openCodeId, { type: "busy" }, cwd);

    const parentMessageID = body.id ?? body.messageID ?? makeMessageId(openCodeId);
    syntheticContext.delete(contextKey);

    recordAndEmitUserPrompt(state, parentMessageID, userPromptText, userPromptTextParts, body);

    (async () => {
      let completed = false;
      const { promise: completion, resolve: markComplete } = Promise.withResolvers<void>();
      const complete = () => {
        if (completed) return;
        completed = true;
        markComplete();
      };

      try {
        // Apply the picked model before subscribing: the handler tags every
        // assistant event with the model it captured, and the turn must never
        // run on whatever model the child booted with (omp's default role).
        if (modelRef) await applyModelRef(state, modelRef, true);

        state.unsubscribe();
        state.unsubscribe = state.conn.onEvent(
          createEventHandler(openCodeId, parentMessageID, state.currentModel, complete, cwd, state.pendingInbox),
        );

        await state.conn.prompt(
          buildPromptPayload(promptText, images, body.delivery === "steer" ? "steer" : undefined),
        );
        await completion;

        if (visiblePromptText && !isLowSignalTitleInput(visiblePromptText)) {
          (async () => {
            try {
              const backend = backendForSession(openCodeId);
              const session = await backend.store.get(openCodeId, cwd);
              if (session && (!session.title || session.title.startsWith("Session "))) {
                if (backend.capabilities.titleGeneration) {
                  const titleCandidate = normalizeGeneratedTitle(visiblePromptText, visiblePromptText);
                  if (titleCandidate) {
                    await backend.store.setTitle(openCodeId, titleCandidate, "auto", cwd);
                  }
                }
              }
            } catch {
              // best effort background title generation
            }
          })();
        }
      } catch (err) {
        // A terminal event is authoritative even if the RPC acknowledgement
        // fails afterward. Do not append a second assistant message that can
        // overwrite a provider error (or a successful terminal message) in
        // OpenChamber's event reducer.
        if (completed) {
          promptLogger.error({ err, sessionID: openCodeId }, `[prompt] ${openCodeId} acknowledgement failed after completion`);
          return;
        }
        const messageID = makeMessageId(openCodeId, `error_${Date.now()}`);
        const errorModel = state.currentModel;
        emitSessionError(openCodeId, err, cwd);
        const errorMessage = err instanceof Error ? err.message : String(err);
        emitAssistantInfo(
          openCodeId,
          messageID,
          parentMessageID,
          errorModel,
          "error",
          cwd,
          undefined,
          undefined,
          undefined,
          { message: errorMessage },
        );
        emitAssistantPart(openCodeId, messageID, makePartId(openCodeId, messageID, "text", 0), "text", `Prompt failed: ${errorMessage}`);
        promptLogger.error({ err, sessionID: openCodeId }, `[prompt] ${openCodeId} failed`);
      } finally {
        state.unsubscribe();
        // Before going idle, so a refetch the idle event provokes already reads the right file.
        if (state.conn.getSessionFile) {
          await Promise.race([followMovedTranscript(state), new Promise((resolve) => setTimeout(resolve, 2_000).unref?.())]);
        }
        state.busy = false;
        scheduleIdleRelease(state);
        try {
          const session = await backendForSession(openCodeId).store.get(openCodeId, cwd);
          if (session) {
            emitOpenCodeV2Event("session.usage.updated", {
              sessionID: openCodeId,
              cost: session.cost,
              tokens: session.tokens,
            }, cwd);
          }
        } catch {
          // Usage refresh is best effort; completion events must still be delivered.
        }
        emitSessionStatus(openCodeId, { type: "idle" }, cwd);
        emitSessionIdle(openCodeId, cwd);
      }
    })();

    return { queued: true, messageID: parentMessageID };
  } finally {
    release();
  }
}

/**
 * Compact through a session's persistent connection only for credentialed
 * sessions. This is important because spawning a separate ambient OMP child
 * would silently lose the caller-owned provider configuration. Legacy
 * sessions deliberately return false so the HTTP route keeps its old
 * ephemeral-RPC behavior.
 *
 * Returns false when no persistent connection exists so the legacy caller can
 * retain its existing ephemeral-RPC behavior.
 */
export async function compactSession(openCodeId: string, cwd: string): Promise<boolean> {
  const state = sessionStates.get(sessionKey(openCodeId, cwd));
  if (!state?.credentialFingerprint || !state.conn.compact) return false;
  await state.conn.compact();
  return true;
}

/**
 * Drops the omp child holding a session. After a revert commit rewrites the
 * transcript the child still carries the old one in memory and would answer
 * (and persist) from it; the next prompt spawns a fresh child that reloads the
 * session file. Also what releases omp's ownership lease on the session.
 */
export async function discardSessionConnection(openCodeId: string, cwd: string): Promise<void> {
  const key = sessionKey(openCodeId, cwd);
  const release = await acquireSessionLock(key);
  try {
    const state = sessionStates.get(key);
    if (!state) return;
    cancelIdleRelease(state);
    state.unsubscribe();
    state.conn.kill();
    clearSubagentStatuses(key);
    sessionStates.delete(key);
  } finally {
    release();
  }
}

export async function abortSession(openCodeId: string, cwd: string): Promise<boolean> {
  const key = sessionKey(openCodeId, cwd);
  const release = await acquireSessionLock(key);
  try {
    const state = sessionStates.get(key);
    if (!state) return false;

    try {
      await state.conn.abort();
    } catch (err) {
      promptLogger.error({ err, sessionID: openCodeId }, `[abort] ${openCodeId} RPC abort failed`);
      state.conn.kill();
      clearSubagentStatuses(key);
      sessionStates.delete(key);
    }
    state.unsubscribe();
    state.busy = false;
    emitSessionStatus(openCodeId, { type: "idle" }, cwd);
    emitSessionIdle(openCodeId, cwd, true);
    return true;
  } finally {
    release();
  }
}

export function isSessionBusy(openCodeId: string, cwd: string): boolean {
  return sessionStates.get(sessionKey(openCodeId, cwd))?.busy ?? false;
}

export function setSubagentStatus(
  childOpenCodeId: string,
  status?: { type: string },
  scope?: SubagentStatusScope,
): void {
  if (!status) {
    subagentStatusMap.delete(childOpenCodeId);
  } else {
    subagentStatusMap.set(childOpenCodeId, {
      status,
      scopeKey: scope?.key,
      directory: scope?.directory,
    });
  }
}

export function getSessionStatusMap(directory?: string): Record<string, { type: string }> {
  const result: Record<string, { type: string }> = {};
  for (const state of sessionStates.values()) {
    if (directory !== undefined && state.cwd !== directory) continue;
    if (state.busy) result[state.openCodeId] = { type: "busy" };
  }
  for (const [id, entry] of subagentStatusMap) {
    if (directory !== undefined && entry.directory !== directory) continue;
    result[id] = entry.status;
  }
  return result;
}

function isActiveSubagentStatus(snapshot: BackendSubagentSnapshot): boolean {
  return snapshot.status === "pending" || snapshot.status === "running";
}

async function reconcileStateSubagents(state: SessionState): Promise<void> {
  if (!state.conn.getSubagentStatuses) return;

  let snapshots: BackendSubagentSnapshot[];
  try {
    snapshots = await state.conn.getSubagentStatuses();
  } catch {
    return;
  }

  const scope = { key: sessionKey(state.openCodeId, state.cwd), directory: state.cwd };
  const activeIds = new Set<string>();
  for (const snapshot of snapshots) {
    if (!isActiveSubagentStatus(snapshot)) continue;
    activeIds.add(snapshot.id);
    setSubagentStatus(snapshot.id, { type: "busy" }, scope);
  }
  for (const [childOpenCodeId, entry] of subagentStatusMap) {
    if (entry.scopeKey === scope.key && !activeIds.has(childOpenCodeId)) {
      subagentStatusMap.delete(childOpenCodeId);
    }
  }
}

export async function reconcileSessionStatuses(directory?: string): Promise<void> {
  const states = [...sessionStates.values()].filter((state) => directory === undefined || state.cwd === directory);
  await Promise.all(states.map((state) => reconcileStateSubagents(state)));
}

/** Kill every persistent OMP child and ephemeral RPC process; used on process shutdown. */
export function shutdownAll(): void {
  for (const [key, state] of sessionStates) {
    try {
      cancelIdleRelease(state);
      state.unsubscribe();
      state.busy = false;
      state.conn.kill();
    } catch {
      /* ignore */
    }
    sessionStates.delete(key);
  }
  sessionBusyLocks.clear();
  subagentStatusMap.clear();
  for (const backend of allBackends()) {
    try {
      backend.shutdownAll();
    } catch {
      /* ignore */
    }
  }
}
