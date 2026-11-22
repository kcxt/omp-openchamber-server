/**
 * One translator from omp RPC frames to OpenCode events, for one session's
 * stream (a root session's own stream, or a subagent's `subagent_event`
 * stream under the child's session id).
 *
 * Its state (current assistant message, part ordinals, open tool parts, usage
 * of the message being assembled) is output assembly only: it decides nothing
 * about busy/idle. Run boundaries come from the runtime state machine.
 *
 * Streaming: every omp text/thinking delta becomes exactly one
 * `message.part.delta` (the first one of a part rides in its opening
 * `message.part.updated`), never batched. Subagent streams carry full-form
 * `message_update` frames (accumulated snapshots); with `fullForm` the delta
 * is derived from the snapshot instead of trusted.
 */
import { randomUUID } from "node:crypto";
import type { ModelRef, OpenCodeTodo, TokenBreakdown, ToolPartState, TurnTelemetry } from "../shared/types";
import { mapOmpUsageToTokens } from "../omp/transcript-reader";
import { attachTodosToState, extractTodosFromOmpDetails, isTodoTool, openCodeToolName } from "../omp/todo";
import { ircMessageCard, parentIrcCard } from "../omp/irc";
import {
  emitFormCreated,
  emitFormSettled,
  emitMessagePartDelta,
  emitMessagePartUpdated,
  emitMessageUpdated,
  emitOpenChamberSessionTodos,
  emitOpenCodeV2Event,
  emitPermissionAsked,
  emitPermissionReplied,
  emitQuestionAsked,
  emitQuestionRejected,
  emitQuestionReplied,
  emitSessionCompactionStarted,
  emitSessionCompacted,
  emitSessionError,
  emitTodoUpdated,
} from "../shared/sse";
import {
  addPendingPermission,
  addPendingQuestion,
  toOpenCodeFormRequest,
  toOpenCodePermissionRequest,
  type PermissionRequest,
  type QuestionRequest,
} from "../adapters/openchamber/approvals";
import { normalizeToolInput, normalizeToolOutput } from "../shared/tool-normalize";
import { timeHexFromTimestamp, timeHexOfMessageId } from "../shared/message-id";
import { promptLogger } from "../shared/logger";
import { getToolCallId, getToolName, reduceToolPartState } from "./tool-state";

export type OmpFrame = Record<string, unknown>;

export interface TranslatorHost {
  /** Writes an `extension_ui_response`; absent for subagent streams (they ask nothing of the host). */
  respond?(frame: Record<string, unknown>): void;
  /** omp's todo list, for a todo tool that ended without details. */
  readTodos?(): Promise<OpenCodeTodo[] | undefined>;
  /** Journals a command notice in the transcript (P2 `oc-notice`) so the reply survives a refetch. */
  journalNotice?(text: string, level: string): void;
  /** omp journaled a user message carrying this host message id. */
  delivered?(hostMessageId: string): void;
}

type PartType = "text" | "reasoning";

const ZERO_TOKENS: TokenBreakdown = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function errorMessageOf(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  const message = record(value)?.message;
  return typeof message === "string" && message.length > 0 ? message : undefined;
}

function hasTokenUsage(tokens: TokenBreakdown): boolean {
  return tokens.input > 0 || tokens.output > 0 || tokens.reasoning > 0 || tokens.cache.read > 0 || tokens.cache.write > 0;
}

function nonnegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function addTelemetry(current: TurnTelemetry | undefined, incoming: TurnTelemetry): TurnTelemetry {
  const a = current?.turnUsage;
  const b = incoming.turnUsage;
  const turnUsage = a || b
    ? {
        input: (a?.input ?? 0) + (b?.input ?? 0),
        output: (a?.output ?? 0) + (b?.output ?? 0),
        reasoning: (a?.reasoning ?? 0) + (b?.reasoning ?? 0),
        cache: { read: (a?.cache.read ?? 0) + (b?.cache.read ?? 0), write: (a?.cache.write ?? 0) + (b?.cache.write ?? 0) },
      }
    : undefined;
  const hasDuration = current?.modelDurationMs !== undefined || incoming.modelDurationMs !== undefined;
  const ttftSamples = (current?.ttftSamples ?? 0) + (incoming.ttftSamples ?? 0);
  return {
    ...(turnUsage ? { turnUsage } : {}),
    ...(hasDuration ? { modelDurationMs: (current?.modelDurationMs ?? 0) + (incoming.modelDurationMs ?? 0) } : {}),
    ...(ttftSamples > 0 ? { ttftMs: (current?.ttftMs ?? 0) + (incoming.ttftMs ?? 0), ttftSamples } : {}),
  };
}

/** Text of block `index` in a message snapshot, for full-form delta derivation. */
function snapshotText(message: unknown, index: unknown, kind: PartType): string | undefined {
  const content = record(message)?.content;
  if (!Array.isArray(content) || typeof index !== "number") return undefined;
  const block = record(content[index]);
  const value = kind === "reasoning" ? block?.thinking : block?.text;
  return typeof value === "string" ? value : undefined;
}

/**
 * `ordinal` is the part's position among parts of the same type in its message,
 * from 0: OpenChamber derives its own ids for text and reasoning parts from
 * exactly that (`<message>:text:<ordinal>`), so live events and a transcript
 * fetched later only merge into one part if the ordinals agree. The sse layer
 * reads it back from the trailing digits.
 */
function partId(sessionId: string, messageID: string, type: PartType, ordinal: number): string {
  return `part_${sessionId}_${messageID}_${type}_${ordinal}`;
}

export class TurnTranslator {
  readonly sessionId: string;
  readonly cwd: string;
  /** The model assistant messages are tagged with; follows the model omp reports. */
  model: ModelRef;
  readonly #host: TranslatorHost;
  readonly #fullForm: boolean;

  #parentId: string | undefined;
  /** The parent has no assistant answer yet: the next assistant message is its reply. */
  #parentFresh = false;
  #assistantId: string | undefined;
  #assistantStart: number | undefined;
  #lastAssistantId: string | undefined;
  #partType: PartType | undefined;
  #partId: string | undefined;
  #partStart: number | undefined;
  #partText = "";
  #partCount = 0;
  #ordinals = { text: 0, reasoning: 0 };
  #tools = new Map<string, { tool: string; state: ToolPartState }>();
  #tokens: TokenBreakdown = ZERO_TOKENS;
  #cost = 0;
  #telemetry: TurnTelemetry | undefined;
  #pendingError: { error?: string; stopReason?: string } | undefined;
  /** Full-form streams: characters already emitted per content block of the current message. */
  #streamed = new Map<number, number>();

  constructor(options: { sessionId: string; cwd: string; model: ModelRef; host?: TranslatorHost; fullForm?: boolean }) {
    this.sessionId = options.sessionId;
    this.cwd = options.cwd;
    this.model = { ...options.model };
    this.#host = options.host ?? {};
    this.#fullForm = options.fullForm === true;
  }

  /** The last assistant message this translator completed (what an idle recap summarizes). */
  get lastAssistantId(): string | undefined {
    return this.#assistantId ?? this.#lastAssistantId;
  }

  /** The user message the next assistant message answers (a prompt sent while idle). */
  setParent(messageID: string): void {
    this.#parentId = messageID;
    this.#parentFresh = true;
  }

  /** Ends the current run: the assistant message closes as stopped, aborted or failed. */
  finishRun(error?: string, stopReason?: string): void {
    this.#finalizePart();
    const failed = stopReason !== "aborted" && (stopReason === "error" || error !== undefined);
    if (failed) {
      this.#ensureStarted();
      const id = this.#assistantId!;
      if (this.#partCount === 0 && this.#tools.size === 0) {
        const now = Date.now();
        const text = error ? `⚠️ **Provider Error**: ${error}` : "⚠️ **Provider Error**: Turn ended with error.";
        this.#emitPart(id, partId(this.sessionId, id, "text", this.#ordinals.text++), "text", text, this.#assistantStart ?? now, now);
      }
      this.#closeAssistant("error", { message: error ?? "Turn ended with error" });
      emitSessionError(this.sessionId, { message: error ?? "Turn ended with error" }, this.cwd);
    } else if (this.#assistantId) {
      this.#closeAssistant(stopReason === "aborted" ? "aborted" : "stop");
    }
    this.#parentFresh = false;
    this.#pendingError = undefined;
  }

  handle(frame: OmpFrame): void {
    const type = frame.type;
    if (typeof type !== "string") return;
    switch (type) {
      case "agent_end": {
        if (frame.isTerminal === false) {
          this.#finalizePart();
          return;
        }
        const messages = Array.isArray(frame.messages) ? frame.messages : [];
        const last = record(messages.at(-1));
        const stopReason = (typeof last?.stopReason === "string" ? last.stopReason : undefined) ?? this.#pendingError?.stopReason;
        const error = errorMessageOf(frame.errorMessage) ?? errorMessageOf(frame.error) ?? errorMessageOf(last?.errorMessage)
          ?? errorMessageOf(last?.error) ?? this.#pendingError?.error;
        if (error && stopReason !== "aborted") {
          promptLogger.error({ sessionID: this.sessionId, stopReason, errorMessage: error, model: this.model }, "[turn] agent run ended with provider error");
        }
        this.finishRun(stopReason === "error" || (error && stopReason !== "aborted") ? error : undefined, stopReason);
        return;
      }
      case "turn_end": {
        const message = record(frame.message);
        const stopReason = typeof message?.stopReason === "string" ? message.stopReason : undefined;
        const error = errorMessageOf(message?.errorMessage) ?? errorMessageOf(frame.errorMessage);
        this.#pendingError = stopReason === "error" || (error && stopReason !== "aborted") ? { error, stopReason } : undefined;
        return;
      }
      case "turn_start":
        this.#pendingError = undefined;
        return;
      case "message_start":
        this.#onMessageStart(frame);
        return;
      case "message_end":
        this.#onMessageEnd(frame);
        return;
      case "message_update":
        this.#onMessageUpdate(frame);
        return;
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end":
        this.#onToolExecution(frame);
        return;
      case "custom": {
        const customType = typeof frame.customType === "string" ? frame.customType : "";
        if (customType === "tool_execution_start" || customType === "tool_execution_update" || customType === "tool_execution_end") {
          const payload = record(frame.data) ?? frame;
          this.#applyTool({ type: customType, ...payload }, getToolCallId(payload) ?? getToolCallId(frame), getToolName(payload) ?? getToolName(frame), customType === "tool_execution_end");
        }
        return;
      }
      case "irc_message": {
        const message = record(frame.message) ?? {};
        const card = ircMessageCard(message, typeof message.timestamp === "number" ? message.timestamp : Date.now());
        if (card) this.#emitTool(card.id, "irc", card.state);
        return;
      }
      case "auto_compaction_start":
      case "manual_compaction_start":
        this.#finalizePart();
        emitSessionCompactionStarted(this.sessionId, this.cwd);
        return;
      case "auto_compaction_end":
      case "manual_compaction_end": {
        this.#finalizePart();
        if (!frame.aborted) emitSessionCompacted(this.sessionId, this.cwd);
        const failure = type === "manual_compaction_end" && typeof frame.errorMessage === "string" ? frame.errorMessage.trim() : "";
        if (failure) this.notice(failure, frame.skipped ? "info" : "warning");
        return;
      }
      case "command_output": {
        const text = typeof frame.text === "string" ? frame.text.trim() : "";
        if (text) this.notice(text, "info");
        return;
      }
      case "extension_ui_request":
        this.#onUiRequest(frame);
        return;
    }
  }

  // ------------------------------------------------------------------ assembly

  #ensureStarted(): void {
    if (this.#assistantId) return;
    const start = Date.now();
    this.#assistantStart = start;
    if (this.#parentFresh && this.#parentId) {
      // `~` (RFC-3986 unreserved, above the base62 range OpenChamber ids use)
      // keeps the assistant id after its parent user id when both share the
      // same 12-hex turn token.
      const hex = timeHexOfMessageId(this.#parentId) ?? timeHexFromTimestamp(start);
      this.#assistantId = `msg_${hex}~${this.sessionId}_asst_${this.#parentId}`;
    } else {
      this.#assistantId = `msg_${timeHexFromTimestamp(start)}_${this.sessionId}_assistant_${start}`;
    }
    this.#parentFresh = false;
    this.#emitInfo();
  }

  #emitInfo(finish?: string, error?: unknown): void {
    const id = this.#assistantId;
    if (!id) return;
    const created = this.#assistantStart ?? Date.now();
    const model = this.model;
    emitMessageUpdated({
      info: {
        id,
        role: "assistant",
        sessionID: this.sessionId,
        parentID: this.#parentId,
        agent: "omp",
        mode: "primary",
        cost: this.#cost,
        path: { cwd: this.cwd, root: this.cwd },
        metadata: this.#telemetry ? { omp: this.#telemetry } : undefined,
        tokens: this.#tokens,
        model: { id: model.modelID, providerID: model.providerID, modelID: model.modelID, variant: model.variant },
        providerID: model.providerID,
        modelID: model.modelID,
        variant: model.variant,
        finish,
        error,
        time: { created, completed: finish ? Date.now() : undefined },
      },
    }, this.cwd);
  }

  #emitPart(messageID: string, id: string, type: PartType, text: string, start: number, end?: number, synthetic = false): void {
    emitMessagePartUpdated(this.sessionId, {
      id,
      type,
      text,
      ...(synthetic ? { synthetic: true } : {}),
      time: { start, end },
      messageID,
      sessionID: this.sessionId,
    }, this.cwd);
  }

  #finalizePart(): void {
    if (!this.#partType || !this.#partId || !this.#assistantId) return;
    this.#emitPart(this.#assistantId, this.#partId, this.#partType, this.#partText, this.#partStart ?? Date.now(), Date.now());
    this.#partType = undefined;
    this.#partId = undefined;
    this.#partStart = undefined;
    this.#partText = "";
  }

  #closeAssistant(finish: string, error?: unknown): void {
    this.#finalizePart();
    this.#emitInfo(finish, error);
    this.#lastAssistantId = this.#assistantId;
    this.#assistantId = undefined;
    this.#assistantStart = undefined;
    this.#partCount = 0;
    this.#ordinals = { text: 0, reasoning: 0 };
    this.#tools.clear();
    this.#tokens = ZERO_TOKENS;
    this.#cost = 0;
    this.#telemetry = undefined;
  }

  #delta(kind: PartType, text: string): void {
    this.#ensureStarted();
    const mid = this.#assistantId!;
    if (this.#partType !== kind) {
      this.#finalizePart();
      this.#partCount++;
      this.#partType = kind;
      this.#partId = partId(this.sessionId, mid, kind, this.#ordinals[kind]++);
      this.#partStart = Date.now();
      this.#partText = text;
      this.#emitPart(mid, this.#partId, kind, text, this.#partStart);
      return;
    }
    if (!text) return;
    this.#partText += text;
    emitMessagePartDelta(this.sessionId, mid, this.#partId!, text, this.cwd, kind);
  }

  /** A command's reply (notify, command output, declined compaction, failed resume). Only while a prompt awaits its answer. */
  notice(text: string, level: "info" | "warning" | "error"): void {
    if (!this.#assistantId && !this.#parentFresh) return;
    this.#ensureStarted();
    this.#finalizePart();
    const id = this.#assistantId!;
    const now = Date.now();
    this.#emitPart(id, partId(this.sessionId, id, "text", this.#ordinals.text++), "text", level === "info" ? text : `⚠️ ${text}`, now, now);
    this.#partCount++;
    this.#host.journalNotice?.(text, level);
  }

  #emitTool(callID: string, tool: string | undefined, state: ToolPartState): void {
    this.#ensureStarted();
    if (!this.#tools.has(callID)) this.#finalizePart();
    const valid = tool && tool !== "tool" ? tool : undefined;
    const entry = this.#tools.get(callID);
    if (entry) {
      if (valid) entry.tool = valid;
      entry.state = state;
    } else {
      this.#tools.set(callID, { tool: valid ?? "tool", state });
    }
    const effective = this.#tools.get(callID)!.tool;
    if (state.input) state.input = normalizeToolInput(effective, state.input);
    if (state.output !== undefined) state.output = normalizeToolOutput(effective, state.output);
    emitMessagePartUpdated(this.sessionId, {
      id: callID,
      type: "tool",
      callID,
      tool: effective,
      state,
      messageID: this.#assistantId!,
      sessionID: this.sessionId,
    }, this.cwd);
  }

  #emitTodos(todos: OpenCodeTodo[]): void {
    emitTodoUpdated(this.sessionId, todos, this.cwd);
    emitOpenChamberSessionTodos(this.sessionId, this.cwd, todos.map((todo) => ({ content: todo.content, status: todo.status })));
  }

  /** Reduces one tool frame into its part; `ending` frames of a todo tool also publish the todo list. */
  #applyTool(payload: Record<string, unknown>, callId: string | undefined, tool: string | undefined, ending: boolean): void {
    const toolCallId = callId ?? `tool_${randomUUID().replace(/-/g, "")}`;
    const existing = this.#tools.get(toolCallId);
    const resolved = tool ?? (existing && existing.tool !== "tool" ? existing.tool : undefined);
    const state = reduceToolPartState(existing?.state, payload, Date.now(), resolved);
    const todoEnd = isTodoTool(resolved) && (state.status === "completed" || ending);
    const todos = todoEnd
      ? extractTodosFromOmpDetails(
          payload.details
            ?? record(payload.data)?.details
            // omp's tool_execution_end carries the tool result as `result: { content, details }`.
            ?? record(payload.result)?.details,
          payload.result ?? payload.output,
        )
      : undefined;
    if (todos) attachTodosToState(state, todos);
    this.#emitTool(toolCallId, openCodeToolName(resolved, state.input), state);
    if (!todoEnd) return;
    if (todos) this.#emitTodos(todos);
    else void this.#host.readTodos?.().then((list) => list && this.#emitTodos(list)).catch(() => {});
  }

  // ------------------------------------------------------------------ frames

  #onMessageStart(frame: OmpFrame): void {
    const message = record(frame.message);
    if (message?.role === "assistant") {
      this.#streamed.clear();
      return;
    }
    if (message?.role === "developer") {
      this.#developer(message);
      return;
    }
    // A parent agent's steer (omp's IRC): the sender's words as a card, not the model-facing envelope or a user message.
    const steer = message?.role === "user"
      ? parentIrcCard(message.parentIrc, typeof message.timestamp === "number" ? message.timestamp : Date.now())
      : undefined;
    if (steer) {
      this.#emitTool(steer.id, "irc", steer.state);
      return;
    }
    if (message?.role !== "user") return;
    if (message.synthetic === true || message.attribution === "assistant") return;
    const hostMessageId = typeof message.hostMessageId === "string" && message.hostMessageId
      ? message.hostMessageId
      : typeof frame.hostMessageId === "string" && frame.hostMessageId ? frame.hostMessageId : undefined;
    // A user message without a host id is omp's own (a goal continuation): the
    // assistant reply stays part of the current exchange.
    if (!hostMessageId) return;
    // Without the delivery ACK OpenChamber keeps the message as a pending inbox
    // entry, pinned after the streaming assistant message.
    emitOpenCodeV2Event("session.inbox.delivered", { sessionID: this.sessionId, inboxID: hostMessageId }, this.cwd);
    this.#host.delivered?.(hostMessageId);
    // omp interrupted the running assistant message to apply a steer, and
    // records the interruption (`stopReason: aborted`) followed by a new
    // assistant message. Mirror that boundary instead of gluing both halves
    // into one OpenChamber step.
    if (this.#assistantId) this.#closeAssistant("aborted");
    this.setParent(hostMessageId);
  }

  /**
   * omp's own directive (resume's continue, a goal nudge) as a completed
   * `developer` tool card in the turn it drives; the transcript mapper
   * (omp/messages.ts#developerToolPart) builds the same part.
   */
  #developer(message: Record<string, unknown>): void {
    const at = typeof message.timestamp === "number" ? message.timestamp : Date.now();
    const content = message.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content) ? content.map((block) => typeof record(block)?.text === "string" ? record(block)!.text as string : JSON.stringify(block)).join("\n") : "";
    this.#emitTool(`developer_${at}`, "developer", {
      status: "completed",
      input: { description: "omp developer message" },
      output: text,
      time: { start: at, end: at },
    });
  }

  #onMessageEnd(frame: OmpFrame): void {
    const message = record(frame.message);
    if (message?.role !== "assistant") return;
    let changed = false;
    if (typeof message.provider === "string" && typeof message.model === "string"
      && (message.provider !== this.model.providerID || message.model !== this.model.modelID)) {
      this.model = { ...this.model, providerID: message.provider, modelID: message.model };
      changed = true;
    }
    const mapped = mapOmpUsageToTokens(message.usage, message.cost);
    if (hasTokenUsage(mapped.tokens)) {
      this.#tokens = mapped.tokens;
      changed = true;
    }
    if (mapped.cost > 0) {
      this.#cost += mapped.cost;
      changed = true;
    }
    const duration = nonnegative(message.duration);
    const ttft = nonnegative(message.ttft);
    const validTtft = ttft !== undefined && (duration === undefined || ttft <= duration);
    if (hasTokenUsage(mapped.tokens) || duration !== undefined || validTtft) {
      this.#telemetry = addTelemetry(this.#telemetry, {
        ...(hasTokenUsage(mapped.tokens) ? { turnUsage: mapped.tokens } : {}),
        ...(duration !== undefined ? { modelDurationMs: duration } : {}),
        ...(validTtft ? { ttftMs: ttft, ttftSamples: 1 } : {}),
      });
      changed = true;
    }
    if (changed) this.#emitInfo();
  }

  #onMessageUpdate(frame: OmpFrame): void {
    const event = record(frame.assistantMessageEvent);
    const eventType = typeof event?.type === "string" ? event.type : undefined;
    if (!event || !eventType) return;

    if (eventType === "text_end" || eventType === "thinking_end") {
      this.#finalizePart();
      return;
    }
    if (eventType === "text_delta" || eventType === "thinking_delta") {
      const kind: PartType = eventType === "thinking_delta" ? "reasoning" : "text";
      let text = typeof event.delta === "string" ? event.delta : "";
      if (this.#fullForm && typeof event.contentIndex === "number") {
        const snapshot = snapshotText(frame.message ?? event.partial, event.contentIndex, kind);
        if (snapshot !== undefined) {
          const sent = this.#streamed.get(event.contentIndex) ?? 0;
          text = snapshot.slice(sent);
          this.#streamed.set(event.contentIndex, snapshot.length);
        }
      }
      this.#delta(kind, text);
      return;
    }
    if (!eventType.startsWith("toolcall_") && eventType !== "toolCall" && eventType !== "tool_call") return;

    const callId = getToolCallId(event);
    const tool = getToolName(event);
    // Argument text arrives as a partial-JSON stream (`toolcall_delta`): it goes
    // out as a raw part delta and the tool card fills in as it streams.
    if (eventType === "toolcall_delta") {
      const delta = typeof event.delta === "string" ? event.delta : "";
      const known = callId ?? [...this.#tools.keys()].pop();
      if (!delta || !known || !this.#tools.has(known)) return;
      this.#ensureStarted();
      emitMessagePartDelta(this.sessionId, this.#assistantId!, known, delta, this.cwd, "raw");
      return;
    }
    this.#applyTool(event, callId, tool, eventType === "toolcall_end");
  }

  #onToolExecution(frame: OmpFrame): void {
    const payload = record(frame.payload) ? { type: frame.type, ...record(frame.payload)! } : frame;
    this.#applyTool(payload, getToolCallId(payload), getToolName(payload), frame.type === "tool_execution_end");
  }

  #onUiRequest(frame: OmpFrame): void {
    const id = String(frame.id ?? randomUUID());
    const method = String(frame.method ?? "confirm");
    const title = String(frame.title ?? "");
    const message = String(frame.message ?? "");
    if (method === "notify") {
      const text = message.trim();
      if (text) this.notice(text, frame.notifyType === "warning" || frame.notifyType === "error" ? frame.notifyType : "info");
      return;
    }
    const respond = this.#host.respond;
    if (!respond) return;
    if (method === "confirm") {
      this.#finalizePart();
      const request: PermissionRequest = {
        id,
        sessionID: this.sessionId,
        permission: title || "execute",
        patterns: [],
        metadata: { message, title, ...frame },
        always: [],
        tool: this.#assistantId ? { messageID: this.#assistantId, callID: id } : undefined,
        directory: this.cwd,
      };
      addPendingPermission(request, (res) => {
        emitPermissionReplied(request.sessionID, request.id, res.cancelled ? "reject" : "once", this.cwd);
        respond({ type: "extension_ui_response", id, ...(res.cancelled ? { cancelled: true } : { confirmed: res.confirmed ?? true }) });
      });
      emitPermissionAsked(toOpenCodePermissionRequest(request) as unknown as Record<string, unknown>, this.cwd);
      return;
    }
    if (method !== "select" && method !== "input") return;
    this.#finalizePart();
    const rawOptions = (Array.isArray(frame.options) ? frame.options : []) as Array<string | { label?: string; value?: string; description?: string }>;
    const request: QuestionRequest = {
      id,
      sessionID: this.sessionId,
      questions: [{
        question: message || title || "Input requested",
        header: title || "Prompt",
        options: rawOptions.map((option) => typeof option === "string"
          ? { label: option, description: "" }
          : { label: option.label ?? option.value ?? "", description: option.description ?? "" }),
        multiple: false,
        custom: method === "input",
      }],
      tool: this.#assistantId ? { messageID: this.#assistantId, callID: id } : undefined,
      directory: this.cwd,
    };
    addPendingQuestion(request, (res) => {
      if (res.cancelled) emitQuestionRejected(request.sessionID, request.id, this.cwd);
      else emitQuestionReplied(request.sessionID, request.id, [[res.value ?? ""]], this.cwd);
      emitFormSettled(request.sessionID, request.id, this.cwd);
      respond({ type: "extension_ui_response", id, value: res.value ?? "", ...(res.cancelled ? { cancelled: true } : {}) });
    });
    emitQuestionAsked(request as unknown as Record<string, unknown>, this.cwd);
    emitFormCreated(toOpenCodeFormRequest(request) as unknown as Record<string, unknown>, this.cwd);
  }
}
