/**
 * Tool-call state assembly from raw omp frames (`toolcall_*` assistant events,
 * `tool_execution_*`). Pure helpers used by the TurnTranslator.
 */
import type { ToolPartState } from "../shared/types";
import { editToolMetadata } from "../shared/edit-diff";
import { normalizeToolInput, normalizeToolOutput, splitBashFailure } from "../shared/tool-normalize";

const isBashTool = (name: string | undefined): boolean => name === "bash" || name === "shell";

function isRpcEventFrame(obj: Record<string, unknown>): boolean {
  if (typeof obj.type === "string" && (
    obj.type.startsWith("tool_execution_") ||
    obj.type.startsWith("toolcall_") ||
    obj.type === "message_update" ||
    obj.type === "message_start" ||
    obj.type === "message_end" ||
    obj.type === "agent_start" ||
    obj.type === "agent_end" ||
    obj.type === "turn_start" ||
    obj.type === "turn_end" ||
    obj.type === "auto_compaction_start" ||
    obj.type === "auto_compaction_end" ||
    obj.type === "manual_compaction_start" ||
    obj.type === "manual_compaction_end" ||
    obj.type === "command_output" ||
    obj.type === "custom"
  )) return true;
  if (typeof obj.customType === "string") return true;
  if ("partial" in obj || "contentIndex" in obj) return true;
  return false;
}

function parseToolInput(value: unknown, descriptionHint?: string): Record<string, unknown> | undefined {
  if (value == null) return undefined;
  let parsed: Record<string, unknown> | undefined;

  if (typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const hint = obj.intent ?? obj.i ?? (typeof obj.data === "object" && obj.data != null ? (obj.data as Record<string, unknown>).intent ?? (obj.data as Record<string, unknown>).i : undefined);
    if (typeof hint === "string" && hint.length > 0) {
      descriptionHint = hint;
    }

    if (obj.toolCall && typeof obj.toolCall === "object") {
      const tc = obj.toolCall as Record<string, unknown>;
      const inner = parseToolInput(tc.arguments ?? tc.args ?? tc.input, descriptionHint);
      if (inner) return inner;
    }
    if (obj.data && typeof obj.data === "object") {
      const d = obj.data as Record<string, unknown>;
      const inner = parseToolInput(d.args ?? d.arguments ?? d.input ?? d.parameters, descriptionHint);
      if (inner) return inner;
    }
    if (obj.args || obj.arguments || obj.input || obj.parameters || obj.params) {
      const innerObj = obj.args ?? obj.arguments ?? obj.input ?? obj.parameters ?? obj.params;
      const inner = parseToolInput(innerObj, descriptionHint);
      if (inner) return inner;
    }

    if (isRpcEventFrame(obj)) {
      return undefined;
    }

    parsed = { ...obj };
  } else if (typeof value === "string") {
    try {
      const p = JSON.parse(value);
      if (p != null && typeof p === "object" && !Array.isArray(p)) {
        if (!isRpcEventFrame(p as Record<string, unknown>)) {
          parsed = p as Record<string, unknown>;
        }
      }
    } catch { /* ignore */ }
  }

  if (parsed) {
    if (!parsed.description && (parsed.intent || parsed.i || descriptionHint)) {
      parsed.description = (parsed.intent ?? parsed.i ?? descriptionHint) as string;
    }
  }
  return parsed;
}

function formatToolOutput(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;

  if (Array.isArray(value)) {
    if (value.length === 0) return "";

    const isContentBlockArray = value.every(
      (item) =>
        item != null &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        (("type" in item && (item.type === "text" || item.type === "thinking" || item.type === "tool_result" || item.type === "image")) ||
         ("text" in item && typeof (item as Record<string, unknown>).text === "string" && !("status" in item && "content" in item)))
    );

    if (isContentBlockArray) {
      return value
        .map((block) => {
          if (!block || typeof block !== "object") return String(block);
          const b = block as Record<string, unknown>;
          if (typeof b.text === "string") return b.text;
          if (typeof b.thinking === "string") return b.thinking;
          if (typeof b.content === "string") return b.content;
          if (typeof b.output === "string") return b.output;
          return JSON.stringify(block);
        })
        .join("\n");
    }

    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    if (obj.data && typeof obj.data === "object") {
      const d = obj.data as Record<string, unknown>;
      return formatToolOutput(d.result ?? d.output ?? d.partialResult ?? d.partial_result ?? d.content);
    }
    if ("result" in obj || "partialResult" in obj || "partial_result" in obj || "output" in obj || "content" in obj) {
      const inner = obj.result ?? obj.partialResult ?? obj.partial_result ?? obj.output ?? obj.content;
      return formatToolOutput(inner);
    }
    if (obj.type === "text" && typeof obj.text === "string") {
      return obj.text;
    }
    if (typeof obj.text === "string" && Object.keys(obj).length === 1) {
      return obj.text;
    }
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getToolError(obj: Record<string, unknown>): string | undefined {
  const d = (typeof obj.data === "object" && obj.data != null ? obj.data : obj) as Record<string, unknown>;
  const value = d.error ?? d.errorMessage ?? d.error_message ?? obj.error ?? obj.errorMessage ?? obj.error_message;
  if (typeof value === "string" && value.length > 0) return value;
  if (d.isError === true || d.is_error === true || d.error === true || obj.isError === true || obj.is_error === true || obj.error === true) {
    const detail = d.output ?? d.content ?? d.result ?? obj.output ?? obj.content ?? obj.result ?? "tool error";
    if (typeof detail === "string") return detail;
    const formatted = formatToolOutput(detail);
    return formatted ?? "tool error";
  }
  return undefined;
}

export function getToolCallId(obj: Record<string, unknown>): string | undefined {
  if (typeof obj.toolCall === "object" && obj.toolCall != null) {
    const id = getToolCallId(obj.toolCall as Record<string, unknown>);
    if (id) return id;
  }
  if (typeof obj.data === "object" && obj.data != null) {
    const id = getToolCallId(obj.data as Record<string, unknown>);
    if (id) return id;
  }
  if (
    typeof obj.partial === "object" &&
    obj.partial != null &&
    Array.isArray((obj.partial as { content?: unknown[] }).content)
  ) {
    const content = (obj.partial as { content: unknown[] }).content;
    const idx = typeof obj.contentIndex === "number" ? obj.contentIndex : 0;
    const block = content[idx];
    if (block && typeof block === "object") {
      const id = getToolCallId(block as Record<string, unknown>);
      if (id) return id;
    }
  }
  const value = obj.toolCallId ?? obj.tool_call_id ?? obj.callId ?? obj.call_id ?? obj.id ?? obj.toolCallID;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function getToolName(obj: Record<string, unknown>): string | undefined {
  if (typeof obj.toolCall === "object" && obj.toolCall != null) {
    const name = getToolName(obj.toolCall as Record<string, unknown>);
    if (name) return name;
  }
  if (typeof obj.data === "object" && obj.data != null) {
    const name = getToolName(obj.data as Record<string, unknown>);
    if (name) return name;
  }
  if (
    typeof obj.partial === "object" &&
    obj.partial != null &&
    Array.isArray((obj.partial as { content?: unknown[] }).content)
  ) {
    const content = (obj.partial as { content: unknown[] }).content;
    const idx = typeof obj.contentIndex === "number" ? obj.contentIndex : 0;
    const block = content[idx];
    if (block && typeof block === "object") {
      const name = getToolName(block as Record<string, unknown>);
      if (name) return name;
    }
  }
  const value = obj.name ?? obj.tool ?? obj.toolName ?? obj.tool_name ?? obj.function;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function reduceToolPartState(
  current: ToolPartState | undefined,
  event: Record<string, unknown>,
  now = Date.now(),
  toolName?: string,
): ToolPartState {
  const state: ToolPartState = current ? { ...current } : { status: "pending" };
  if (state.time) state.time = { ...state.time };
  const type = ((event.type ?? event.customType) as string) || "";
  const resolvedToolName = toolName ?? getToolName(event);

  const intentHint =
    (typeof event.intent === "string" && event.intent.length > 0 ? event.intent : undefined) ??
    (typeof event.i === "string" && event.i.length > 0 ? event.i : undefined) ??
    (typeof event.data === "object" && event.data != null
      ? (typeof (event.data as Record<string, unknown>).intent === "string" ? (event.data as Record<string, unknown>).intent as string : undefined) ??
        (typeof (event.data as Record<string, unknown>).i === "string" ? (event.data as Record<string, unknown>).i as string : undefined)
      : undefined) ??
    (typeof event.toolCall === "object" && event.toolCall != null
      ? (typeof (event.toolCall as Record<string, unknown>).intent === "string" ? (event.toolCall as Record<string, unknown>).intent as string : undefined) ??
        (typeof (event.toolCall as Record<string, unknown>).i === "string" ? (event.toolCall as Record<string, unknown>).i as string : undefined)
      : undefined);

  const rawInput =
    event.arguments ??
    event.args ??
    event.input ??
    event.parameters ??
    (typeof event.toolCall === "object" && event.toolCall != null
      ? (event.toolCall as Record<string, unknown>).arguments ??
        (event.toolCall as Record<string, unknown>).args ??
        (event.toolCall as Record<string, unknown>).input ??
        (event.toolCall as Record<string, unknown>).parameters
      : undefined) ??
    (typeof event.data === "object" && event.data != null
      ? (event.data as Record<string, unknown>).args ??
        (event.data as Record<string, unknown>).arguments ??
        (event.data as Record<string, unknown>).input ??
        (event.data as Record<string, unknown>).parameters
      : undefined);

  const input = rawInput != null ? parseToolInput(rawInput, intentHint) : undefined;
  if (input && Object.keys(input).length > 0) {
    const normalizedInput = normalizeToolInput(resolvedToolName, input);
    state.input = { ...state.input, ...normalizedInput };
  }

  const rawDetails =
    event.details ??
    (typeof event.data === "object" && event.data != null
      ? (event.data as Record<string, unknown>).details
      : undefined);

  if (
    type === "toolcall_start" ||
    type === "toolcall_delta" ||
    type === "toolcall_end" ||
    type === "toolCall" ||
    type === "tool_call"
  ) {
    if (type !== "toolcall_delta" && !state.time) {
      state.time = { start: now };
    }
  } else if (type === "tool_execution_start") {
    state.status = "running";
    if (!state.time) state.time = { start: now };
  } else if (type === "tool_execution_update") {
    if (state.status === "completed" || state.status === "error") {
      return state;
    }
    state.status = "running";
    const output = formatToolOutput(event.output ?? event.content ?? event.result ?? event.partialResult ?? event.partial_result ?? (typeof event.data === "object" && event.data != null ? event.data : undefined));
    if (output != null) {
      const normalizedOutput = normalizeToolOutput(resolvedToolName, output, rawDetails);
      if (
        (resolvedToolName === "bash" || resolvedToolName === "shell" || resolvedToolName === "terminal" || resolvedToolName === "exec") &&
        state.output &&
        normalizedOutput &&
        !normalizedOutput.startsWith(state.output)
      ) {
        state.output = state.output + "\n" + normalizedOutput;
      } else {
        state.output = normalizedOutput;
      }
    }
  } else if (type === "tool_execution_end") {
    const error = getToolError(event);
    if (error) {
      state.status = "error";
      state.error = error;
    } else {
      state.status = "completed";
    }
    const output = formatToolOutput(event.output ?? event.content ?? event.result ?? (typeof event.data === "object" && event.data != null ? event.data : undefined));
    if (output != null) {
      state.output = normalizeToolOutput(resolvedToolName, output, rawDetails);
    }
    const failure = error && isBashTool(resolvedToolName) ? splitBashFailure(error) : undefined;
    if (failure) {
      state.error = failure.error;
      state.output = failure.output;
    }
    if (!error && resolvedToolName?.toLowerCase() === "edit") {
      // omp's tool_execution_end carries the tool result as `result: { content, details }`.
      const resultDetails = typeof event.result === "object" && event.result != null && !Array.isArray(event.result)
        ? (event.result as Record<string, unknown>).details
        : undefined;
      const metadata = editToolMetadata(rawDetails ?? resultDetails, state.input);
      if (metadata) state.metadata = { ...state.metadata, ...metadata };
    }
    if (!state.time) state.time = { start: now };
    state.time.end = now;
  }

  return state;
}
