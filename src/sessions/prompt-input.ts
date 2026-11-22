/**
 * What an OpenChamber prompt body turns into: the text omp receives (user
 * text, synthetic context, attached text files), the images, the client
 * message id, and the user message echoed back to OpenChamber.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { BackendCredentialInput, ImageContent, ModelRef, OpenCodePromptTextPart } from "../shared/types";
import { isBlobRef, readBlobBufferSync } from "../shared/blobs";
import { promptLogger } from "../shared/logger";
import { randomIdSuffix, timeSortableHex } from "../shared/message-id";
import { emitMessagePartUpdated, emitMessageUpdated, emitOpenCodeV2Event } from "../shared/sse";
import { toV2FileAttachment } from "../adapters/openchamber/v2";

interface OpenCodeTextPart {
  type: "text";
  text?: string;
  synthetic?: boolean;
}

type OpenCodePart = OpenCodeTextPart | { type: "file" | "image" | string; [key: string]: unknown } | Record<string, unknown>;

interface PromptFile {
  uri: string;
  name?: string;
  description?: string;
  mention?: { start: number; end: number; text: string };
}

export interface PromptBody {
  parts?: OpenCodePart[];
  messageID?: string;
  id?: string | null;
  text?: string;
  files?: PromptFile[];
  agents?: Array<{ name: string; mention?: { start: number; end: number; text: string } }>;
  skills?: Array<{ id: string; mention?: { start: number; end: number; text: string } }>;
  metadata?: Record<string, unknown>;
  delivery?: "steer" | "queue" | null;
  model?: { providerID?: string; modelID?: string };
  variant?: string;
  credentials?: BackendCredentialInput["credentials"];
  credentialRef?: string;
}

export function isPromptBody(value: unknown): value is PromptBody {
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
  if (!("type" in value) || value.type !== "text") return false;
  if ("text" in value && typeof value.text !== "string") return false;
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
  return dot === -1 ? undefined : IMAGE_EXT_TO_MIME[clean.slice(dot).toLowerCase()];
}

async function resolveImageFromUrl(url: string, explicitMime?: string, cwd?: string): Promise<ImageContent | undefined> {
  if (url.startsWith("data:")) {
    const commaIndex = url.indexOf(",");
    if (commaIndex === -1) return undefined;
    const meta = url.slice(5, commaIndex);
    const mimeMatch = meta.match(/^([^;,]+)/);
    return { type: "image", data: url.slice(commaIndex + 1), mimeType: explicitMime || (mimeMatch ? mimeMatch[1] : undefined) || "image/png" };
  }

  if (isBlobRef(url)) {
    const buffer = readBlobBufferSync(url);
    if (buffer) return { type: "image", data: buffer.toString("base64"), mimeType: explicitMime || "image/png" };
  }

  let filePath = url;
  if (filePath.startsWith("file://")) {
    try {
      filePath = new URL(filePath).pathname;
    } catch {
      filePath = filePath.slice(7);
    }
  }
  if (cwd && !isAbsolute(filePath)) filePath = resolve(cwd, filePath);

  try {
    const buffer = await readFile(filePath);
    return { type: "image", data: buffer.toString("base64"), mimeType: explicitMime || mimeFromPath(filePath) || "image/png" };
  } catch (err) {
    promptLogger.warn({ err, url, filePath }, `[prompt] failed to read image from ${filePath}`);
    return undefined;
  }
}

function inlineImage(data: string, mimeType: string): ImageContent | undefined {
  if (isBlobRef(data)) {
    const buffer = readBlobBufferSync(data);
    return buffer ? { type: "image", data: buffer.toString("base64"), mimeType } : undefined;
  }
  return { type: "image", data: data.replace(/^data:[^;,]+;base64,/, ""), mimeType };
}

export async function extractPromptImages(body: PromptBody, cwd?: string): Promise<ImageContent[]> {
  const images: ImageContent[] = [];
  const parts: OpenCodePart[] = [
    ...(Array.isArray(body.parts) ? body.parts : []),
    ...(body.files ?? []).map((file) => ({ type: "file" as const, url: file.uri, filename: file.name, mime: mimeFromPath(file.name ?? file.uri) })),
  ];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (p.type === "image") {
      const mimeType = (typeof p.mimeType === "string" ? p.mimeType : undefined) || (typeof p.mime === "string" ? p.mime : undefined);
      if (typeof p.data === "string" && p.data.length > 0) {
        const image = inlineImage(p.data, mimeType || "image/png");
        if (image) images.push(image);
      } else if (typeof p.url === "string" && p.url.length > 0) {
        const image = await resolveImageFromUrl(p.url, mimeType, cwd);
        if (image) images.push(image);
      }
    } else if (p.type === "file") {
      const mime = (typeof p.mime === "string" ? p.mime : undefined) || (typeof p.mimeType === "string" ? p.mimeType : undefined);
      const url = typeof p.url === "string" ? p.url : "";
      const filename = typeof p.filename === "string" ? p.filename : "";
      const inferredMime = mime || mimeFromPath(filename) || mimeFromPath(url);
      const isImage = (inferredMime && inferredMime.startsWith("image/")) || url.startsWith("data:image/") || isBlobRef(url)
        || (inferredMime !== undefined && inferredMime in IMAGE_EXT_TO_MIME);
      if (!isImage) continue;
      if (typeof p.data === "string" && p.data.length > 0) {
        const image = inlineImage(p.data, inferredMime || "image/png");
        if (image) images.push(image);
      } else if (url) {
        const image = await resolveImageFromUrl(url, inferredMime, cwd);
        if (image) images.push(image);
      }
    }
  }
  return images;
}

export function extractPromptTextParts(body: PromptBody): OpenCodePromptTextPart[] {
  const parts: OpenCodePromptTextPart[] = [];
  if (typeof body.text === "string" && body.text.length > 0) parts.push({ text: body.text });
  for (const part of body.parts ?? []) {
    if (isTextPart(part) && part.text) parts.push({ text: part.text, ...(part.synthetic === true ? { synthetic: true } : {}) });
  }
  return parts;
}

const TEXT_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".css", ".csv", ".go", ".h", ".hpp", ".html", ".ini", ".java", ".js", ".json",
  ".jsx", ".md", ".mdx", ".mjs", ".py", ".rb", ".rs", ".sh", ".sql", ".svg", ".toml", ".ts", ".tsx",
  ".txt", ".xml", ".yaml", ".yml",
]);

const hasTextExtension = (name: string): boolean => TEXT_EXTENSIONS.has(name.slice(name.lastIndexOf(".")).toLowerCase());

async function extractPromptFileText(body: PromptBody, cwd: string): Promise<string[]> {
  const files = [
    ...(body.files ?? []).map((file) => ({ uri: file.uri, name: file.name })),
    ...(body.parts ?? []).flatMap((part) => {
      if (!part || typeof part !== "object" || (part as Record<string, unknown>).type !== "file") return [];
      const value = part as Record<string, unknown>;
      const uri = typeof value.url === "string" ? value.url : "";
      return uri ? [{ uri, name: typeof value.filename === "string" ? value.filename : undefined }] : [];
    }),
  ];
  const contexts: string[] = [];
  for (const file of files) {
    if (!file.uri || isBlobRef(file.uri)) continue;
    let filePath = file.uri;
    const label = file.name || file.uri;
    if (filePath.startsWith("data:")) {
      const match = filePath.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/s);
      if (!match || !hasTextExtension(file.name ?? "")) continue;
      try {
        const content = /^data:[^,]*;base64,/i.test(filePath)
          ? Buffer.from(match[2] ?? "", "base64").toString("utf8")
          : decodeURIComponent(match[2] ?? "");
        if (content.length <= 2 * 1024 * 1024 && !content.includes("\0")) contexts.push(`Attached file: ${label}\n\n${content}`);
      } catch {
        /* malformed inline text attachment */
      }
      continue;
    }
    try {
      if (filePath.startsWith("file://")) filePath = new URL(filePath).pathname;
      if (!isAbsolute(filePath)) filePath = resolve(cwd, filePath);
      if (!hasTextExtension(file.name || filePath)) {
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

export function makeMessageId(sessionId: string, suffix?: string): string {
  return `msg_${timeSortableHex()}_${sessionId}_${suffix ?? randomIdSuffix()}`;
}

/**
 * OpenChamber briefs the agent for its own goal loop: the final message is judged
 * by an independent check and ends the run. omp's goal works the other way (the
 * agent calls the `goal` tool), so omp's own goal prompt replaces that briefing.
 */
function isOpenChamberGoalBriefing(text: string): boolean {
  return /^\s*<system-reminder>\s*Goal mode is active for this session/.test(text);
}

type SyntheticItem = { text: string; description?: string; metadata?: Record<string, unknown> };

/** v2 synthetic context waiting for the next user prompt (kind: output assembly, consumed by that prompt). */
const syntheticContext = new Map<string, SyntheticItem[]>();
const contextKey = (sessionId: string, cwd: string) => `${sessionId}\0${cwd}`;

/** Store v2 synthetic context until the following user prompt is dispatched. */
export function addSessionSyntheticContext(
  sessionId: string,
  cwd: string,
  input: { id?: string; text: string; description?: string; metadata?: Record<string, unknown> },
) {
  const id = input.id || makeMessageId(sessionId);
  const key = contextKey(sessionId, cwd);
  syntheticContext.set(key, [...(syntheticContext.get(key) ?? []), { text: input.text, description: input.description, metadata: input.metadata }]);
  emitOpenCodeV2Event("session.synthetic", {
    sessionID: sessionId,
    text: input.text,
    description: input.description,
    metadata: input.metadata,
  }, cwd, id.startsWith("msg_") ? `evt_${id.slice(4)}` : undefined);
  return {
    id,
    sessionID: sessionId,
    time: { created: Date.now() },
    type: "synthetic" as const,
    payload: { text: input.text, description: input.description, metadata: input.metadata },
    delivery: "queue" as const,
  };
}

export function clearSessionSyntheticContext(sessionId: string, cwd: string): void {
  syntheticContext.delete(contextKey(sessionId, cwd));
}

export interface PreparedPrompt {
  /** The client message id (OpenChamber's optimistic id), sent to omp as `hostMessageId`. */
  messageID: string;
  /** Everything omp receives as the message. */
  message: string;
  /** What the user typed (the visible bubble). */
  visibleText: string;
  visibleParts: OpenCodePromptTextPart[];
  images: ImageContent[];
}

/** Builds the omp message from a body and consumes the session's pending synthetic context. */
export async function preparePrompt(sessionId: string, cwd: string, body: PromptBody): Promise<PreparedPrompt | { error: string }> {
  const textParts = extractPromptTextParts(body);
  const visibleParts = textParts.filter((part) => part.synthetic !== true);
  const visibleText = visibleParts.map((part) => part.text).join("\n\n");
  const key = contextKey(sessionId, cwd);
  const queued = syntheticContext.get(key) ?? [];
  const fileContext = await extractPromptFileText(body, cwd);
  const message = [
    ...queued.map((item) => item.text).filter((text) => !isOpenChamberGoalBriefing(text)),
    ...textParts.filter((part) => part.synthetic === true && !isOpenChamberGoalBriefing(part.text)).map((part) => part.text),
    visibleText,
    ...fileContext,
  ].filter(Boolean).join("\n\n");
  const images = await extractPromptImages(body, cwd);
  if (!message && images.length === 0) return { error: "no text parts" };
  syntheticContext.delete(key);
  return { messageID: body.id ?? body.messageID ?? makeMessageId(sessionId), message, visibleText, visibleParts, images };
}

/**
 * Echoes the user's message to OpenChamber the moment it is accepted: the
 * inbox item (`session.inbox.enqueued`, delivered once omp journals it), the
 * user message, then its file and text parts.
 */
export function emitUserPrompt(sessionId: string, cwd: string, prompt: Pick<PreparedPrompt, "messageID" | "visibleText" | "visibleParts">, body: PromptBody, model: ModelRef): void {
  const { messageID } = prompt;
  const created = Date.now() - 1;
  const filePayload = [
    ...(body.files ?? []).map((file) => toV2FileAttachment({ ...file, mime: mimeFromPath(file.name ?? file.uri) ?? undefined })),
    ...(body.parts ?? []).flatMap((part) => {
      if (!part || typeof part !== "object" || !("type" in part) || (part.type !== "file" && part.type !== "image")) return [];
      const value = part as Record<string, unknown>;
      const mime = (typeof value.mime === "string" ? value.mime : undefined)
        ?? (typeof value.mimeType === "string" ? value.mimeType : undefined) ?? "application/octet-stream";
      const uri = typeof value.url === "string" ? value.url : undefined;
      const inline = typeof value.data === "string" ? value.data : undefined;
      const source = uri ?? (inline ? `data:${mime};base64,${inline.replace(/^data:[^,]*,/, "")}` : "");
      return source ? [toV2FileAttachment({ uri: source, mime, ...(typeof value.filename === "string" ? { name: value.filename } : {}) })] : [];
    }),
  ];
  emitOpenCodeV2Event("session.inbox.enqueued", {
    sessionID: sessionId,
    inboxID: messageID,
    item: {
      type: "user",
      delivery: body.delivery ?? "queue",
      payload: {
        text: prompt.visibleText,
        files: filePayload,
        ...(body.agents ? { agents: body.agents } : {}),
        ...(body.skills ? { skills: body.skills } : {}),
        ...(body.metadata ? { metadata: body.metadata } : {}),
      },
    },
  }, cwd);
  emitMessageUpdated({
    info: {
      id: messageID,
      sessionID: sessionId,
      role: "user",
      agent: "omp",
      model: { id: model.modelID, providerID: model.providerID, modelID: model.modelID, variant: model.variant },
      time: { created, completed: created },
    },
  }, cwd);

  let nextPartIndex = prompt.visibleParts.length;
  // Emit file/image parts before text parts so OpenChamber's event-reducer
  // replaces optimistic file parts in place (it gates optimistic part replacement
  // on the first part lacking sessionID). Emitting text first assigns sessionID
  // to part 0, causing subsequent file parts to be appended as duplicates.
  const fileParts: OpenCodePart[] = [
    ...(body.parts ?? []),
    ...(body.files ?? []).map((file) => ({ type: "file", url: file.uri, filename: file.name, mime: mimeFromPath(file.name ?? file.uri) })),
  ];
  for (const part of fileParts) {
    if (!part || typeof part !== "object" || !("type" in part) || (part.type !== "file" && part.type !== "image")) continue;
    const p = part as Record<string, unknown>;
    const mime = (typeof p.mime === "string" ? p.mime : undefined) || (typeof p.mimeType === "string" ? p.mimeType : undefined) || "image/png";
    const url = typeof p.url === "string" ? p.url : (typeof p.data === "string" ? `data:${mime};base64,${p.data}` : "");
    emitMessagePartUpdated(sessionId, {
      id: (typeof p.id === "string" ? p.id : undefined) || `part_${sessionId}_${messageID}_${nextPartIndex++}`,
      type: "file",
      mime,
      url,
      ...(p.filename ? { filename: p.filename } : {}),
      messageID,
      sessionID: sessionId,
    }, cwd);
  }

  for (const [index, part] of prompt.visibleParts.entries()) {
    emitMessagePartUpdated(sessionId, {
      id: `part_${sessionId}_${messageID}_${index}`,
      type: "text",
      text: part.text,
      ...(part.synthetic === true ? { synthetic: true } : {}),
      messageID,
      sessionID: sessionId,
    }, cwd);
  }
}
