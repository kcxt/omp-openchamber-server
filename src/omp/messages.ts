import { mapOmpUsageToTokens, readTranscript, type TranscriptEntry } from "./transcript-reader";
import { SessionDocs, type SessionDocNotice } from "../store/session-docs";
import { getOmpSessionByOpenCodeId } from "../store/sessions";
import { editToolMetadata } from "../shared/edit-diff";
import { normalizeToolInput, normalizeToolOutput, splitBashFailure } from "../shared/tool-normalize";
import { timeHexFromTimestamp, timeHexOfMessageId } from "../shared/message-id";
import { attachTodosToState, extractTodosFromOmpDetails, isTodoTool } from "./todo";
import { ircMessageCard, parentIrcCard } from "./irc";
import { resolveImageDataUrl } from "../shared/blobs";
import type {
  OpenCodeMessageRecord,
  OpenCodePart,
  OpenCodePromptTextPart,
  OpenCodeTextPart,
  OpenCodeToolPart,
  TokenBreakdown,
} from "../shared/types";
import { contextPointOfMessage, type OmpContextPoint } from "./context";
import { asideAnswerText, asideMessageIds, asideQuestionText, btwTurns, readBtwTopics, type BtwTopic, type BtwTurn } from "./btw-history";

interface OmpTurnTelemetry {
  turnUsage: TokenBreakdown;
  modelDurationMs?: number;
  ttftMs?: number;
  ttftSamples?: number;
  context?: OmpContextPoint;
}

function hasTokenUsage(tokens: TokenBreakdown): boolean {
  return tokens.input > 0
    || tokens.output > 0
    || tokens.reasoning > 0
    || tokens.cache.read > 0
    || tokens.cache.write > 0;
}

function addTokenUsage(left: TokenBreakdown, right: TokenBreakdown): TokenBreakdown {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    reasoning: left.reasoning + right.reasoning,
    cache: {
      read: left.cache.read + right.cache.read,
      write: left.cache.write + right.cache.write,
    },
  };
}

function getRecordedTurnTelemetry(record: OpenCodeMessageRecord): OmpTurnTelemetry | undefined {
  const ompMetadata = record.info.metadata?.omp;
  if (!ompMetadata || typeof ompMetadata !== "object") return undefined;
  return ompMetadata as OmpTurnTelemetry;
}

function recordTurnTelemetry(record: OpenCodeMessageRecord, telemetry: OmpTurnTelemetry): void {
  const ompMetadata = record.info.metadata?.omp;
  const current = ompMetadata && typeof ompMetadata === "object" ? ompMetadata as Record<string, unknown> : {};
  record.info.metadata = {
    ...record.info.metadata,
    omp: { ...current, ...telemetry },
  };
}

function getAssistantModelDuration(msg: AgentMessage, createdAt: number): number | undefined {
  if (msg.role !== "assistant") return undefined;
  if (typeof msg.duration === "number" && Number.isFinite(msg.duration) && msg.duration >= 0) {
    return msg.duration;
  }
  const completedAt = getAssistantCompletionAt(msg, createdAt);
  return completedAt === undefined ? undefined : completedAt - createdAt;
}

function getAssistantTtft(msg: AgentMessage): number | undefined {
  if (
    msg.role !== "assistant"
    || typeof msg.ttft !== "number"
    || !Number.isFinite(msg.ttft)
    || msg.ttft < 0
    || (typeof msg.duration === "number" && msg.ttft > msg.duration)
  ) {
    return undefined;
  }
  return msg.ttft;
}

function getTurnTelemetryForMessage(
  msg: AgentMessage,
  tokens: TokenBreakdown,
  createdAt: number,
): OmpTurnTelemetry | undefined {
  const modelDurationMs = getAssistantModelDuration(msg, createdAt);
  const ttftMs = getAssistantTtft(msg);
  if (!hasTokenUsage(tokens) && modelDurationMs === undefined && ttftMs === undefined) return undefined;
  const context = contextPointOfMessage(msg.contextSnapshot, tokens, msg.provider ?? "omp", msg.model ?? "omp", createdAt);
  return {
    turnUsage: tokens,
    ...(modelDurationMs !== undefined ? { modelDurationMs } : {}),
    ...(ttftMs !== undefined ? { ttftMs, ttftSamples: 1 } : {}),
    ...(context ? { context } : {}),
  };
}

function addTurnTelemetry(
  record: OpenCodeMessageRecord,
  msg: AgentMessage,
  tokens: TokenBreakdown,
  createdAt: number,
): void {
  const current = getRecordedTurnTelemetry(record);
  const incoming = getTurnTelemetryForMessage(msg, tokens, createdAt);
  if (!current && !incoming) return;

  const currentUsage = current?.turnUsage ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  const incomingUsage = incoming?.turnUsage ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  const modelDurationMs = (current?.modelDurationMs ?? 0) + (incoming?.modelDurationMs ?? 0);
  const ttftSamples = (current?.ttftSamples ?? 0) + (incoming?.ttftSamples ?? 0);
  const ttftMs = (current?.ttftMs ?? 0) + (incoming?.ttftMs ?? 0);

  const context = incoming?.context ?? current?.context;
  recordTurnTelemetry(record, {
    turnUsage: addTokenUsage(currentUsage, incomingUsage),
    ...(modelDurationMs > 0 || current?.modelDurationMs !== undefined || incoming?.modelDurationMs !== undefined ? { modelDurationMs } : {}),
    ...(ttftSamples > 0 ? { ttftMs, ttftSamples } : {}),
    ...(context ? { context } : {}),
  });
}

export type AgentMessageRole = "user" | "developer" | "assistant" | "custom" | "toolResult" | "compactionSummary";

export interface AgentMessageContentBlock {
  type: "text" | "thinking" | "toolCall";
  text?: string;
  thinking?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  id?: string;
}

export interface AgentMessage {
  id?: string;
  role: AgentMessageRole;
  content?: AgentMessageContentBlock[] | string;
  summary?: string;
  shortSummary?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  method?: string;
  provider?: string;
  model?: string;
  variant?: string;
  stopReason?: string;
  errorMessage?: string;
  errorStatus?: number;
  errorId?: string | number;
  error?: unknown;
  display?: boolean;
  attribution?: "user" | "assistant";
  /** A `custom_message` entry's type (`irc:incoming`, …) and payload. */
  customType?: string;
  /** On a user message: the parent agent's steer, with the sender's own words (omp's IRC). */
  parentIrc?: unknown;
  /** OpenChamber's client message id, stored on the user entry by omp (P1) or on a `host-resume` marker (P5). */
  hostMessageId?: string;
  /** The transcript entry this message came from. */
  entryId?: string;
  /** A `/btw` turn (omp's btw history); it is not a transcript message. */
  aside?: { topicId: string; turnIndex: number; turn: BtwTurn };
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  details?: unknown;
  usage?: unknown;
  cost?: unknown;
  /** Persisted OMP completion timestamp in milliseconds since the epoch. */
  completedAt?: number;
  /** Persisted OMP model-request duration in milliseconds. */
  duration?: number;
  /** Persisted OMP time-to-first-token in milliseconds. */
  ttft?: number;
  /** Provider prompt size and non-message estimate recorded with the request (see context.ts). */
  contextSnapshot?: unknown;
}

function openCodeRoleFor(msg: AgentMessage): "user" | "assistant" | null {
  switch (msg.role) {
    case "user":
      return "user";
    case "assistant":
    case "toolResult":
    case "compactionSummary":
      return "assistant";
    case "custom": {
      if (msg.display === false) return null;
      if (msg.attribution === "user") return "user";
      return null;
    }
    default:
      return null;
  }
}

function normalizedContentBlocks(
  msg: AgentMessage,
): AgentMessageContentBlock[] {
  const { content } = msg;
  if (Array.isArray(content)) return content;
  if (typeof content === "string" && content.length > 0) return [{ type: "text", text: content }];
  return [];
}

/**
 * A developer message (omp's own directive: resume's continue, a goal nudge)
 * as a completed `developer` tool card, so it can be read without posing as
 * something the user said. Its id is the message timestamp, which the live
 * translator (sessions/turn-translator.ts) uses too.
 */
function developerToolPart(msg: AgentMessage, openCodeId: string): OpenCodeToolPart {
  const at = typeof msg.timestamp === "number" ? msg.timestamp : Date.now();
  const id = `developer_${at}`;
  return {
    id,
    type: "tool",
    callID: id,
    tool: "developer",
    state: {
      status: "completed",
      input: { description: "omp developer message" },
      output: extractTextFromContent(msg.content),
      time: { start: at, end: at },
    },
    messageID: "",
    sessionID: openCodeId,
  };
}

/** A message between agents (omp's IRC) as an `irc` tool card, or undefined for any other message. */
function ircToolPart(msg: AgentMessage, openCodeId: string): OpenCodeToolPart | undefined {
  const at = typeof msg.timestamp === "number" ? msg.timestamp : Date.now();
  const card = msg.role === "user" ? parentIrcCard(msg.parentIrc, at) : msg.role === "custom" ? ircMessageCard(msg, at) : undefined;
  if (!card) return undefined;
  return { id: card.id, type: "tool", callID: card.id, tool: "irc", state: card.state, messageID: "", sessionID: openCodeId };
}

function createToolPart(
  block: AgentMessageContentBlock,
  openCodeId: string,
  messageId: string,
  index: number,
  startTime: number,
): OpenCodeToolPart {
  const raw = block as unknown as Record<string, unknown>;
  const tool = typeof block.name === "string" && block.name.length > 0
    ? block.name
    : (typeof raw.tool === "string" && raw.tool.length > 0 ? (raw.tool as string) : "tool");
  const callID = typeof block.id === "string" && block.id.length > 0
    ? block.id
    : (typeof raw.toolCallId === "string" && raw.toolCallId.length > 0 ? (raw.toolCallId as string) : `call_${index}`);

  let input: Record<string, unknown> | undefined;
  if (typeof block.arguments === "object" && block.arguments !== null && !Array.isArray(block.arguments)) {
    input = { ...(block.arguments as Record<string, unknown>) };
  } else if (typeof raw.args === "object" && raw.args !== null && !Array.isArray(raw.args)) {
    input = { ...(raw.args as Record<string, unknown>) };
  } else if (typeof block.arguments === "string") {
    try {
      const p = JSON.parse(block.arguments);
      if (typeof p === "object" && p !== null && !Array.isArray(p)) input = p as Record<string, unknown>;
    } catch {}
  }
  if (input && !input.description && (input.intent || input.i || raw.intent)) {
    input.description = (input.intent ?? input.i ?? raw.intent) as string;
  }
  if (input) {
    input = normalizeToolInput(tool, input);
  }

  return {
    id: `part_${openCodeId}_${messageId}_tool_${index}_${block.id ?? tool}`,
    type: "tool",
    callID,
    tool,
    state: {
      status: "pending",
      input,
      time: { start: startTime },
    },
    metadata: typeof block.id === "string" ? { toolCallId: block.id } : undefined,
    messageID: messageId,
    sessionID: openCodeId,
  };
}

function extractTextFromContent(content: AgentMessageContentBlock[] | string | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return JSON.stringify(block);
      if (typeof block.text === "string") return block.text;
      if (typeof block.thinking === "string") return block.thinking;
      return JSON.stringify(block);
    })
    .join("\n");
}

function mergeToolResultIntoAssistant(
  msg: AgentMessage,
  record: OpenCodeMessageRecord,
  resultTime: number,
): boolean {
  const raw = msg as unknown as Record<string, unknown>;
  const toolCallId = typeof msg.toolCallId === "string" ? msg.toolCallId : (typeof raw.tool_call_id === "string" ? (raw.tool_call_id as string) : undefined);
  const toolName = typeof msg.toolName === "string" ? msg.toolName : (typeof raw.tool_name === "string" ? (raw.tool_name as string) : undefined);

  const toolParts = record.parts.filter(
    (part): part is OpenCodeToolPart => part.type === "tool",
  );
  if (toolParts.length === 0) return false;

  const targetByCallId = toolCallId
    ? toolParts.find((part) => part.metadata?.toolCallId === toolCallId || part.callID === toolCallId)
    : undefined;
  const target = targetByCallId ?? (toolName
    ? toolParts.find((part) => part.tool === toolName && part.state.status === "pending")
    : undefined);
  if (!target) return false;

  if (target.tool === "tool" && toolName) {
    target.tool = toolName;
  }

  const content = extractTextFromContent(msg.content);
  const isError = msg.isError === true || raw.is_error === true;
  target.state.status = isError ? "error" : "completed";
  if (isError) {
    const failure = (target.tool === "bash" || target.tool === "shell") ? splitBashFailure(content) : undefined;
    target.state.error = failure?.error ?? content;
    if (failure) target.state.output = failure.output;
  } else {
    target.state.output = normalizeToolOutput(target.tool, content, msg.details ?? raw.details);
    if (target.tool.toLowerCase() === "edit") {
      const metadata = editToolMetadata(msg.details ?? raw.details, target.state.input);
      if (metadata) target.state.metadata = { ...target.state.metadata, ...metadata };
    }
  }
  // OpenChamber reads a todo list off the call's input; omp's `todo` tool takes
  // an op, so the list the call produced comes from its recorded details.
  if (!isError && isTodoTool(target.tool)) {
    const todos = extractTodosFromOmpDetails(msg.details ?? raw.details);
    if (todos) attachTodosToState(target.state, todos);
  }
  target.state.time.end = resultTime;
  return true;
}

function updateAssistantCompletion(
  record: OpenCodeMessageRecord,
  completedAt: number,
  force = false,
): void {
  const hasActiveTool = record.parts.some(
    (part) => part.type === "tool" && (part.state.status === "pending" || part.state.status === "running"),
  );
  if (hasActiveTool && !force) {
    delete record.info.time.completed;
    return;
  }
  record.info.time.completed = Math.max(record.info.time.completed ?? 0, completedAt);
}

function getAssistantCompletionAt(msg: AgentMessage, createdAt: number): number | undefined {
  if (typeof msg.completedAt === "number" && Number.isFinite(msg.completedAt) && msg.completedAt >= createdAt) {
    return msg.completedAt;
  }

  if (typeof msg.duration === "number" && Number.isFinite(msg.duration) && msg.duration >= 0) {
    const derived = createdAt + msg.duration;
    if (Number.isFinite(derived)) return derived;
  }

  return undefined;
}

function getAssistantFirstOutputAt(msg: AgentMessage, createdAt: number): number {
  if (
    typeof msg.ttft === "number"
    && Number.isFinite(msg.ttft)
    && msg.ttft >= 0
    && (typeof msg.duration !== "number" || msg.ttft <= msg.duration)
  ) {
    return createdAt + msg.ttft;
  }
  return createdAt;
}

function isTerminalAssistantCompletion(msg: AgentMessage, completedAt: number | undefined): boolean {
  return msg.role === "assistant"
    && completedAt !== undefined
    && msg.stopReason !== undefined
    && msg.stopReason !== "toolUse";
}

function buildParts(
  msg: AgentMessage,
  openCodeId: string,
  messageId: string,
  startIndex = 0,
): OpenCodePart[] {
  const parts: OpenCodePart[] = [];
  let currentTextPart: { type: "text" | "reasoning"; text: string } | null = null;
  let hasOutputPart = false;
  const msgTime = typeof msg.timestamp === "number" ? msg.timestamp : Date.now();
  const firstOutputAt = getAssistantFirstOutputAt(msg, msgTime);
  const toolStartAt = getAssistantCompletionAt(msg, msgTime) ?? firstOutputAt;

  const flushText = () => {
    if (currentTextPart) {
      const partTime = hasOutputPart ? msgTime : firstOutputAt;
      parts.push({
        id: `part_${openCodeId}_${messageId}_${startIndex + parts.length}`,
        type: currentTextPart.type,
        text: currentTextPart.text || "(empty)",
        time: { start: partTime, end: partTime },
        messageID: messageId,
        sessionID: openCodeId,
      });
      hasOutputPart = true;
      currentTextPart = null;
    }
  };

  for (const block of normalizedContentBlocks(msg)) {
    if (!block || typeof block !== "object") continue;
    const kind = block.type;
    const raw = block as unknown as Record<string, unknown>;
    if (kind === "text") {
      const text = typeof raw.text === "string" ? raw.text : JSON.stringify(block);
      if (currentTextPart && currentTextPart.type === "text") {
        if (currentTextPart.text) currentTextPart.text += "\n";
        currentTextPart.text += text;
      } else {
        flushText();
        currentTextPart = { type: "text", text };
      }
    } else if (kind === "thinking") {
      const text = typeof raw.thinking === "string" ? raw.thinking : JSON.stringify(block);
      if (currentTextPart && currentTextPart.type === "reasoning") {
        if (currentTextPart.text) currentTextPart.text += "\n";
        currentTextPart.text += text;
      } else {
        flushText();
        currentTextPart = { type: "reasoning", text };
      }
    } else if (kind === "toolCall") {
      flushText();
      parts.push(createToolPart(block, openCodeId, messageId, startIndex + parts.length, toolStartAt));
      hasOutputPart = true;
    } else if (kind === "image") {
      flushText();
      const mime =
        (typeof raw.mimeType === "string" ? raw.mimeType : undefined) ||
        (typeof raw.mime === "string" ? raw.mime : undefined) ||
        "image/png";
      const rawData = typeof raw.data === "string" ? raw.data : "";
      const rawUrl = typeof raw.url === "string" ? raw.url : "";

      let url = "";
      if (rawData) {
        url = resolveImageDataUrl(rawData, mime);
      } else if (rawUrl) {
        url = resolveImageDataUrl(rawUrl, mime);
      }

      parts.push({
        id: `part_${openCodeId}_${messageId}_${startIndex + parts.length}`,
        type: "file",
        mime,
        url,
        messageID: messageId,
        sessionID: openCodeId,
      });
    } else if (kind === "file") {
      flushText();
      const mime =
        (typeof raw.mime === "string" ? raw.mime : undefined) ||
        (typeof raw.mimeType === "string" ? raw.mimeType : undefined) ||
        "application/octet-stream";
      const rawUrl = typeof raw.url === "string" ? raw.url : "";
      const rawData = typeof raw.data === "string" ? raw.data : "";
      const filename = typeof raw.filename === "string" ? raw.filename : undefined;

      let url = rawUrl;
      if (rawData) {
        url = resolveImageDataUrl(rawData, mime);
      } else if (rawUrl) {
        url = resolveImageDataUrl(rawUrl, mime);
      }

      parts.push({
        id:
          (typeof raw.id === "string" ? raw.id : undefined) ||
          `part_${openCodeId}_${messageId}_${startIndex + parts.length}`,
        type: "file",
        mime,
        url,
        ...(filename ? { filename } : {}),
        messageID: messageId,
        sessionID: openCodeId,
      });
    } else {
      const text = JSON.stringify(block);
      if (currentTextPart && currentTextPart.type === "text") {
        if (currentTextPart.text) currentTextPart.text += "\n";
        currentTextPart.text += text;
      } else {
        flushText();
        currentTextPart = { type: "text", text };
      }
    }
  }

  flushText();

  if (parts.length === 0 && startIndex === 0) {
    const msgTime = typeof msg.timestamp === "number" ? msg.timestamp : Date.now();
    const rawError = typeof msg.errorMessage === "string" ? msg.errorMessage : (typeof msg.error === "string" ? msg.error : undefined);
    const text = (msg.stopReason === "error" || rawError)
      ? (rawError ? `⚠️ **Provider Error**: ${rawError}` : "⚠️ **Provider Error**: Turn ended with error.")
      : "(empty)";
    parts.push({
      id: `part_${openCodeId}_${messageId}_0`,
      type: "text",
      text,
      time: { start: msgTime, end: msgTime },
      messageID: messageId,
      sessionID: openCodeId,
    });
  }

  return parts;
}

function buildPromptTextParts(
  promptParts: OpenCodePromptTextPart[],
  openCodeId: string,
  messageId: string,
  timestamp: number,
): OpenCodeTextPart[] {
  return promptParts.map((part, index) => ({
    id: `part_${openCodeId}_${messageId}_${index}`,
    type: "text",
    text: part.text,
    ...(part.synthetic === true ? { synthetic: true } : {}),
    time: { start: timestamp, end: timestamp },
    messageID: messageId,
    sessionID: openCodeId,
  }));
}

/** The two messages of one `/btw` turn: the question as the user's, the answer as an assistant message marked as an aside. */
function asideRecords(openCodeId: string, aside: NonNullable<AgentMessage["aside"]>): OpenCodeMessageRecord[] {
  const { turn } = aside;
  const { userId, assistantId } = asideMessageIds(openCodeId, aside.topicId, aside.turnIndex, turn.createdAt);
  const live = turn.status === "running";
  const finished = live ? undefined : turn.updatedAt;
  const model = { id: "omp", providerID: "omp", modelID: "omp", variant: "default" };
  const failed = turn.status === "error";
  return [
    {
      info: { id: userId, role: "user", sessionID: openCodeId, agent: "omp", model, time: { created: turn.createdAt, completed: turn.createdAt } },
      parts: [{
        id: `part_${openCodeId}_${userId}_0`,
        type: "text",
        text: asideQuestionText(turn),
        time: { start: turn.createdAt, end: turn.createdAt },
        messageID: userId,
        sessionID: openCodeId,
      }],
    },
    {
      info: {
        id: assistantId,
        role: "assistant",
        sessionID: openCodeId,
        parentID: userId,
        agent: "omp",
        model,
        providerID: "omp",
        modelID: "omp",
        variant: "default",
        mode: "aside",
        metadata: { aside: { recordId: aside.topicId, turn: aside.turnIndex, status: turn.status } },
        finish: live ? undefined : failed ? "error" : "stop",
        ...(failed ? { error: { message: turn.error ?? "The side question failed." } } : {}),
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: turn.createdAt, ...(finished !== undefined ? { completed: finished } : {}) },
      },
      parts: [{
        id: `part_${openCodeId}_${assistantId}_0`,
        type: "text",
        text: asideAnswerText(turn),
        time: { start: turn.createdAt, ...(finished !== undefined ? { end: finished } : {}) },
        messageID: assistantId,
        sessionID: openCodeId,
      }],
    },
  ];
}

/**
 * User message ids are exact, never matched by text or position: P1 stores the
 * client id on omp's entry (`hostMessageId`); a message from before the
 * migration uses the id the importer recorded for its entry
 * (`legacyIdsByEntry`); anything else gets an id derived from its entry id.
 * `visibleParts` (by client id) only supplies what the user typed for a prompt
 * whose message to the model carried more. `entryIds`, when given, receives
 * the omp entry that opens each record.
 */
export function mapRpcMessagesToOpenCodeRecords(
  messages: AgentMessage[],
  openCodeId: string,
  legacyIdsByEntry: Record<string, string> = {},
  visibleParts: Record<string, OpenCodePromptTextPart[]> = {},
  entryIds?: Map<string, string>,
): OpenCodeMessageRecord[] {
  const records: OpenCodeMessageRecord[] = [];
  let lastUserMessageId: string | undefined;
  let lastUserMatched = false;
  let lastAssistantRecord: OpenCodeMessageRecord | undefined;
  let visibleIndex = 0;
  let assistantSegmentIndex = 0;
  /** Developer messages waiting for the assistant record they lead into. */
  let pendingDeveloper: OpenCodeToolPart[] = [];
  /** Developer messages nothing answered (e.g. a refused resume) still show, in a record of their own. */
  const flushDeveloper = () => {
    if (pendingDeveloper.length === 0) return;
    const at = pendingDeveloper[0]!.state.time.start;
    const id = `msg_${timeHexFromTimestamp(at)}_${openCodeId}_developer_${at}`;
    records.push({
      info: {
        id,
        role: "assistant",
        sessionID: openCodeId,
        parentID: lastUserMessageId,
        agent: "omp",
        model: { id: "omp", providerID: "omp", modelID: "omp", variant: "default" },
        providerID: "omp",
        modelID: "omp",
        variant: "default",
        finish: "stop",
        mode: "primary",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: at, completed: at },
      },
      parts: pendingDeveloper.map((part) => ({ ...part, messageID: id })),
    });
    pendingDeveloper = [];
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.aside) {
      // A side question: its own question and answer, never merged into the turn it sits in.
      records.push(...asideRecords(openCodeId, msg.aside));
      continue;
    }
    const card = msg.role === "developer" ? developerToolPart(msg, openCodeId) : ircToolPart(msg, openCodeId);
    if (card) {
      // omp's own directives (resume's continue, goal nudges) and messages between agents read as a tool card in the turn they drive.
      if (lastAssistantRecord) lastAssistantRecord.parts.push({ ...card, messageID: lastAssistantRecord.info.id });
      else pendingDeveloper.push(card);
      continue;
    }
    const role = openCodeRoleFor(msg);
    if (role === null) continue;
    if (role === "user") flushDeveloper();

    const createdAt = typeof msg.timestamp === "number" ? msg.timestamp : Date.now();
    const assistantCompletionAt = msg.role === "assistant"
      ? getAssistantCompletionAt(msg, createdAt)
      : undefined;
    const terminalAssistantCompletion = isTerminalAssistantCompletion(msg, assistantCompletionAt);

    if (msg.role === "toolResult" && lastAssistantRecord) {
      if (mergeToolResultIntoAssistant(msg, lastAssistantRecord, createdAt)) {
        updateAssistantCompletion(lastAssistantRecord, createdAt);
        continue;
      }
    }

    let messageId: string;
    if (role === "user") {
      assistantSegmentIndex = 0;
      const clientId = typeof msg.hostMessageId === "string" && msg.hostMessageId.length > 0
        ? msg.hostMessageId
        : typeof msg.id === "string" ? legacyIdsByEntry[msg.id] : undefined;
      if (clientId) {
        messageId = clientId;
        lastUserMatched = true;
      } else if (typeof msg.id === "string" && msg.id.startsWith("msg_")) {
        messageId = msg.id;
        lastUserMatched = false;
      } else {
        messageId = `msg_${timeHexFromTimestamp(createdAt)}_${openCodeId}_${msg.id ?? visibleIndex}`;
        lastUserMatched = false;
      }

      visibleIndex++;
      const matchedPromptParts = clientId ? visibleParts[clientId] : undefined;
      const parts = matchedPromptParts && matchedPromptParts.length > 0
        ? buildPromptTextParts(matchedPromptParts, openCodeId, messageId, createdAt)
        : buildParts(msg, openCodeId, messageId);
      const baseInfo: OpenCodeMessageRecord["info"] = {
        id: messageId,
        role: "user",
        sessionID: openCodeId,
        agent: "omp",
        model: { providerID: "omp", modelID: "omp", variant: "default" },
        time: { created: createdAt, completed: createdAt },
      };
      records.push({ info: baseInfo, parts });
      if (msg.entryId) entryIds?.set(messageId, msg.entryId);
      lastUserMessageId = messageId;
      lastAssistantRecord = undefined;
    } else {
      const providerID = msg.provider ?? "omp";
      const modelID = msg.model ?? "omp";
      const variant = msg.variant ?? "default";
      const { tokens, cost } = mapOmpUsageToTokens(msg.usage, msg.cost);

      let finish: string | undefined;
      if (msg.stopReason === "toolUse") {
        finish = "tool-calls";
      } else if (msg.stopReason) {
        finish = msg.stopReason;
      }

      const rawError = typeof msg.errorMessage === "string" ? msg.errorMessage : (typeof msg.error === "string" ? msg.error : undefined);
      const errorObj = rawError ? { message: rawError } : (msg.stopReason === "error" ? { message: "Turn ended with error" } : undefined);
      const isCompaction = msg.role === "compactionSummary";
      if (isCompaction) assistantSegmentIndex++;

      if (lastAssistantRecord && !isCompaction && !lastAssistantRecord.info.summary) {
        const parts = buildParts(msg, openCodeId, lastAssistantRecord.info.id, lastAssistantRecord.parts.length);
        lastAssistantRecord.parts.push(...parts);
        updateAssistantCompletion(
          lastAssistantRecord,
          assistantCompletionAt ?? createdAt,
          terminalAssistantCompletion,
        );
        if (finish) {
          lastAssistantRecord.info.finish = finish;
        } else if (lastAssistantRecord.parts.some((p) => p.type === "tool" && (p.state.status === "pending" || p.state.status === "running"))) {
          lastAssistantRecord.info.finish = "tool-calls";
        } else {
          lastAssistantRecord.info.finish = "stop";
        }
        if (errorObj) {
          lastAssistantRecord.info.error = errorObj;
        } else if (lastAssistantRecord.info.finish === "stop") {
          lastAssistantRecord.info.error = undefined;
        }
        addTurnTelemetry(lastAssistantRecord, msg, tokens, createdAt);
        if (hasTokenUsage(tokens)) {
          lastAssistantRecord.info.tokens = tokens;
        }
        if (cost > 0) {
          lastAssistantRecord.info.cost = (lastAssistantRecord.info.cost || 0) + cost;
        }
        if (msg.provider && msg.provider !== "omp") {
          lastAssistantRecord.info.providerID = msg.provider;
          lastAssistantRecord.info.model.providerID = msg.provider;
        }
        if (msg.model && msg.model !== "omp") {
          lastAssistantRecord.info.modelID = msg.model;
          lastAssistantRecord.info.model.modelID = msg.model;
          lastAssistantRecord.info.model.id = msg.model;
        }
        if (msg.variant) {
          lastAssistantRecord.info.variant = msg.variant;
          lastAssistantRecord.info.model.variant = msg.variant;
        }
      } else {
        if (typeof msg.id === "string" && msg.id.startsWith("msg_")) {
          messageId = msg.id;
        } else if (isCompaction) {
          const cmpHex = timeHexFromTimestamp(createdAt);
          messageId = typeof msg.id === "string" && msg.id.length > 0
            ? `msg_${cmpHex}_${openCodeId}_cmp_${msg.id}`
            : `msg_${cmpHex}_${openCodeId}_cmp_${visibleIndex}`;
        } else if (lastUserMatched && lastUserMessageId) {
          const asstHex = timeHexOfMessageId(lastUserMessageId) ?? timeHexFromTimestamp(createdAt);
          const segmentSuffix = assistantSegmentIndex > 0 ? `_segment_${String(assistantSegmentIndex).padStart(2, "0")}` : "";
          // `~` sits above the base62 range OpenChamber ids use, so the
          // assistant sorts after its parent user id when they share a turn.
          messageId = `msg_${asstHex}~${openCodeId}_asst_${lastUserMessageId}${segmentSuffix}`;
        } else if (typeof msg.id === "string" && msg.id.length > 0) {
          messageId = `msg_${timeHexFromTimestamp(createdAt)}_${openCodeId}_${msg.id}`;
        } else {
          messageId = `msg_${timeHexFromTimestamp(createdAt)}_${openCodeId}_${visibleIndex}`;
        }

        visibleIndex++;
        const parts: OpenCodePart[] = [];
        if (isCompaction) {
          const text = msg.summary || "Conversation history compacted";
          parts.push({
            id: `part_${openCodeId}_${messageId}_0`,
            type: "text",
            text,
            time: { start: createdAt, end: createdAt },
            messageID: messageId,
            sessionID: openCodeId,
          });
          if (!finish) finish = "stop";
        } else {
          const own = buildParts(msg, openCodeId, messageId, pendingDeveloper.length);
          parts.push(...pendingDeveloper.map((part) => ({ ...part, messageID: messageId })), ...own);
          pendingDeveloper = [];
          if (!finish) {
            finish = own.some((p) => p.type === "tool") ? "tool-calls" : "stop";
          }
        }

        const recordTokens = isCompaction
          ? {
              input: msg.tokensBefore ?? 0,
              output: msg.tokensAfter ?? 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            }
          : tokens;

        const turnTelemetry = isCompaction ? undefined : getTurnTelemetryForMessage(msg, tokens, createdAt);
        const record: OpenCodeMessageRecord = {
          info: {
            id: messageId,
            role: "assistant",
            sessionID: openCodeId,
            parentID: lastUserMessageId,
            agent: isCompaction ? "compaction" : "omp",
            model: { id: modelID, providerID, modelID, variant },
            providerID,
            modelID,
            variant,
            finish,
            error: errorObj,
            summary: isCompaction ? true : undefined,
            mode: isCompaction ? "compaction" : "primary",
            metadata: turnTelemetry ? { omp: turnTelemetry } : undefined,
            cost,
            tokens: recordTokens,
            time: { created: createdAt, completed: isCompaction ? createdAt : undefined },
          },
          parts,
        };
        updateAssistantCompletion(record, assistantCompletionAt ?? createdAt, terminalAssistantCompletion || isCompaction);
        records.push(record);
        if (msg.entryId) entryIds?.set(messageId, msg.entryId);
        lastAssistantRecord = isCompaction ? undefined : record;
      }
    }
  }

  flushDeveloper();
  return records;
}

function timestampOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

/**
 * The conversation as AgentMessages: the messages and compactions of the
 * transcript's active branch (see `transcript-reader.ts`), with command notices
 * placed where omp journaled them (P2 `oc-notice` entries; replies from before
 * P2 sit in the doc's read-only `legacyNotices` and go in by timestamp).
 *
 * Record shapes (omp session file format):
 *   {"type":"message","id","parentId","timestamp":"<iso>","message":{"role","content":[...],
 *    "api","provider","model","usage","stopReason","timestamp":<ms>,
 *    "toolCallId","toolName","isError"}}
 * The inner `message` object matches the AgentMessage shape the `get_messages`
 * RPC returns, so it flows through the same mapper.
 */
function agentMessagesOfBranch(branch: TranscriptEntry[], legacyNotices: SessionDocNotice[] = [], asides: BtwTopic[] = []): AgentMessage[] {
  const messages: AgentMessage[] = [];
  /** entry id → how many messages the branch had once that entry was read. */
  const after = new Map<string, number>();
  let previous: string | undefined;
  for (const entry of branch) {
    if (previous) after.set(previous, messages.length);
    previous = typeof entry.id === "string" ? entry.id : undefined;
    const entryId = typeof entry.id === "string" ? entry.id : undefined;
    if (entry.type === "compaction") {
      messages.push({
        id: entryId,
        entryId,
        role: "compactionSummary",
        summary: typeof entry.summary === "string" ? entry.summary : "",
        shortSummary: typeof entry.shortSummary === "string" ? entry.shortSummary : undefined,
        tokensBefore: typeof entry.tokensBefore === "number" ? entry.tokensBefore : undefined,
        tokensAfter: typeof entry.tokensAfter === "number" ? entry.tokensAfter : undefined,
        method: typeof entry.method === "string" ? entry.method : undefined,
        timestamp: timestampOf(entry.timestamp) ?? Date.now(),
      } as unknown as AgentMessage);
      continue;
    }
    // P5: a `.` sent from OpenChamber is journaled as a `host-resume` marker (never shown to the model);
    // it is the user message the continuation answers, under the client's id. A command the sidecar ran
    // itself (`/goal …`) is journaled the same way as `host-command`.
    if (entry.type === "custom" && (entry.customType === "host-resume" || entry.customType === "host-command")) {
      const data = entry.data as Record<string, unknown> | undefined;
      if (typeof data?.hostMessageId !== "string") continue;
      messages.push({
        id: entryId,
        entryId,
        role: "user",
        content: [{ type: "text", text: typeof data.text === "string" ? data.text : "." }],
        hostMessageId: data.hostMessageId,
        timestamp: timestampOf(entry.timestamp) ?? Date.now(),
      });
      continue;
    }
    // P2: a command's reply the runtime journaled; it reads as an assistant message.
    if (entry.type === "custom" && entry.customType === "oc-notice") {
      const data = entry.data as Record<string, unknown> | undefined;
      if (typeof data?.text !== "string") continue;
      messages.push(noticeMessage(entryId, data.text, typeof data.level === "string" ? data.level : "info", timestampOf(entry.timestamp) ?? Date.now()));
      continue;
    }
    // omp's IRC: a message another agent sent this session (`irc:incoming`, `irc:relay`, …).
    if (entry.type === "custom_message" && typeof entry.customType === "string" && entry.customType.startsWith("irc:")) {
      messages.push({
        id: entryId,
        entryId,
        role: "custom",
        customType: entry.customType,
        display: entry.display !== false,
        details: entry.details,
        timestamp: timestampOf(entry.timestamp) ?? Date.now(),
      });
      continue;
    }
    if (entry.type !== "message") continue;
    const raw = entry.message;
    if (raw == null || typeof raw !== "object") continue;
    const message = raw as Record<string, unknown>;
    const id = typeof message.id === "string" ? message.id : entryId;
    const timestamp = typeof message.timestamp === "number" ? message.timestamp : timestampOf(entry.timestamp);
    messages.push({ ...message, id, entryId, timestamp } as unknown as AgentMessage);
  }
  if (previous) after.set(previous, messages.length);

  // Side questions (`/btw`) sit after the entry omp asked them at; one that was asked before the first entry leads.
  const placed = new Map<number, AgentMessage[]>();
  for (const topic of asides) {
    const index = topic.leafId === null ? 0 : after.get(topic.leafId);
    if (index === undefined) continue; // asked on a branch that is no longer the active one
    const turns = btwTurns(topic).map((turn, turnIndex) => ({
      role: "custom",
      timestamp: turn.createdAt,
      aside: { topicId: topic.id, turnIndex, turn },
    }) as unknown as AgentMessage);
    placed.set(index, [...(placed.get(index) ?? []), ...turns]);
  }
  if (placed.size > 0) {
    const merged: AgentMessage[] = [];
    for (let index = 0; index <= messages.length; index++) {
      merged.push(...(placed.get(index) ?? []));
      if (index < messages.length) merged.push(messages[index]!);
    }
    messages.splice(0, messages.length, ...merged);
  }

  for (const notice of legacyNotices) {
    const message = noticeMessage(`notice_${notice.timestamp}`, notice.text, notice.level, notice.timestamp);
    const index = messages.findIndex((m) => typeof m.timestamp === "number" && m.timestamp > notice.timestamp);
    if (index === -1) messages.push(message);
    else messages.splice(index, 0, message);
  }
  return messages;
}

function noticeMessage(id: string | undefined, text: string, level: string, timestamp: number): AgentMessage {
  return {
    id,
    role: "assistant",
    content: [{ type: "text", text: level === "info" ? text : `⚠️ ${text}` }],
    stopReason: "stop",
    timestamp,
  } as unknown as AgentMessage;
}

async function readBranch(openCodeId: string, path: string) {
  const transcript = await readTranscript(path);
  if (!transcript?.header) throw new Error(`Failed to load messages for ${openCodeId}: transcript unreadable`);
  const doc = await SessionDocs.get(transcript.header.id);
  const asides = await readBtwTopics(path);
  const messages = agentMessagesOfBranch(transcript.activeBranch, doc.legacyNotices, asides);
  return { transcript, doc, messages };
}

/** Messages of the session's transcript, read through the memoised `TranscriptReader`. */
export async function loadSessionMessages(openCodeId: string, cwd: string): Promise<OpenCodeMessageRecord[]> {
  const session = await getOmpSessionByOpenCodeId(openCodeId, cwd);
  if (!session) throw new Error(`Failed to load messages for ${openCodeId}: no session found in ${cwd}`);
  const { doc, messages } = await readBranch(openCodeId, session.path);
  return mapRpcMessagesToOpenCodeRecords(messages, openCodeId, doc.legacyMessageIds, doc.visibleParts);
}

/** Where a visible message sits in omp's tree. */
export interface MessageLocation {
  /** The omp entry that opens the message. */
  entryId: string;
  parentId: string | null;
  /** A user message omp's `navigate_tree` rewinds past (it moves the leaf to its parent). */
  userMessage: boolean;
  /** A `.` marker (P5): a user message to OpenChamber, a `custom` entry to omp. */
  resumeMarker: boolean;
  /** The session's leaf in the file (omp's last line). */
  leafId: string | null;
  /** omp session uuid (the SessionDoc key). */
  uuid: string;
}

/** Maps a message id OpenChamber knows (client id, legacy id, derived id) to its entry in the active branch. */
export async function locateMessage(openCodeId: string, transcriptPath: string, messageID: string): Promise<MessageLocation | undefined> {
  const { transcript, doc, messages } = await readBranch(openCodeId, transcriptPath);
  const entryIds = new Map<string, string>();
  mapRpcMessagesToOpenCodeRecords(messages, openCodeId, doc.legacyMessageIds, doc.visibleParts, entryIds);
  const entryId = entryIds.get(messageID);
  if (!entryId) return undefined;
  const entry = transcript.entries.find((candidate) => candidate.id === entryId);
  if (!entry) return undefined;
  const message = entry.type === "message" ? entry.message as Record<string, unknown> | undefined : undefined;
  return {
    entryId,
    parentId: typeof entry.parentId === "string" ? entry.parentId : null,
    userMessage: message?.role === "user",
    resumeMarker: entry.type === "custom" && entry.customType === "host-resume",
    leafId: transcript.leafId,
    uuid: transcript.header!.id,
  };
}
