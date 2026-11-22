import type { ToolPartState } from "../shared/types";

/**
 * Messages between omp agents (IRC) as a completed `irc` tool card, built the same way live
 * (sessions/turn-translator.ts) and from the transcript (omp/messages.ts). The model-facing envelope
 * (`<irc>Incoming IRC message from …`) is never shown; the body is what the sender wrote. A message this
 * session sent is not built here: it is the `write agent://<id>` call itself (shared/tool-normalize.ts).
 */
export interface IrcCard {
  id: string;
  state: ToolPartState & { time: { start: number; end?: number } };
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const text = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;

function card(id: string, description: string, body: string, at: number): IrcCard {
  return {
    id,
    state: { status: "completed", input: { description }, output: body, time: { start: at, end: at } },
  };
}

/** A parent's steer, consumed by a subagent: omp keeps the sender's own words in `parentIrc`. */
export function parentIrcCard(parentIrc: unknown, at: number): IrcCard | undefined {
  const value = record(parentIrc);
  const body = text(value?.body);
  if (!body) return undefined;
  return card(`irc_${at}`, `← ${text(value?.from) ?? "parent"}`, body, at);
}

/**
 * An `irc:*` custom message (`incoming`, `autoreply`, `relay`, `workpool`). `incoming` carries its body in
 * `details.message`, the others in `details.body`. Undefined for any other custom message, or one omp
 * marks as not displayed.
 */
export function ircMessageCard(message: { customType?: unknown; display?: unknown; details?: unknown; timestamp?: unknown }, at: number): IrcCard | undefined {
  const customType = text(message.customType);
  if (!customType?.startsWith("irc:") || message.display === false) return undefined;
  const details = record(message.details);
  const body = text(customType === "irc:incoming" ? details?.message : details?.body) ?? text(details?.message) ?? text(details?.body);
  if (!body) return undefined;
  const from = text(details?.from);
  const to = text(details?.to);
  const description = to ? `${from ?? "agent"} → ${to}` : `← ${from ?? "agent"}`;
  return card(`irc_${text(details?.id) ?? at}`, description, body, at);
}
