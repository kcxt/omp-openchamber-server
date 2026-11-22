/**
 * omp's `/btw` side questions, read-only. omp checkpoints every turn into
 * `<session file without .jsonl>/btw-history/entry-<id>.json` (session/btw-history.ts);
 * the sidecar only reads that store, never writes it. A record is a topic: its
 * own first turn plus `followUps`; `leafId` is the transcript entry the topic
 * was asked at.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { timeHexFromTimestamp } from "../../shared/message-id";

export type BtwStatus = "running" | "complete" | "cancelled" | "error" | "interrupted";

export interface BtwTurn {
  question: string;
  answer: string;
  status: BtwStatus;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

export interface BtwTopic extends BtwTurn {
  id: string;
  leafId: string | null;
  followUps?: BtwTurn[];
}

const STATUSES = new Set<string>(["running", "complete", "cancelled", "error", "interrupted"]);

function isTurn(value: unknown): value is BtwTurn {
  const turn = value as Record<string, unknown> | null;
  return !!turn && typeof turn === "object"
    && typeof turn.question === "string" && typeof turn.answer === "string"
    && typeof turn.status === "string" && STATUSES.has(turn.status)
    && typeof turn.createdAt === "number" && typeof turn.updatedAt === "number";
}

function isTopic(value: unknown): value is BtwTopic {
  const topic = value as Record<string, unknown> | null;
  return isTurn(value) && typeof topic!.id === "string" && topic!.id.length > 0
    && (topic!.leafId === null || typeof topic!.leafId === "string")
    && (topic!.followUps === undefined || (Array.isArray(topic!.followUps) && topic!.followUps.every(isTurn)));
}

/** Where omp keeps a session's side questions. */
export function btwHistoryDirectory(transcriptPath: string): string {
  return join(transcriptPath.replace(/\.jsonl$/, ""), "btw-history");
}

/**
 * A turn the store still says `running` is only live while omp's process is: streamed
 * text is not checkpointed, so a stale `running` turn is one a dead process left.
 */
const RUNNING_STALE_MS = 5 * 60_000;

function recovered(topic: BtwTopic): BtwTopic {
  const fix = <T extends BtwTurn>(turn: T): T =>
    turn.status === "running" && Date.now() - turn.updatedAt > RUNNING_STALE_MS ? { ...turn, status: "interrupted" } : turn;
  return { ...fix(topic), ...(topic.followUps ? { followUps: topic.followUps.map(fix) } : {}) };
}

/** The session's topics, oldest first. */
export async function readBtwTopics(transcriptPath: string): Promise<BtwTopic[]> {
  const directory = btwHistoryDirectory(transcriptPath);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const topics: BtwTopic[] = [];
  for (const name of names.sort()) {
    if (!/^entry-.+\.json$/.test(name)) continue;
    try {
      const parsed = JSON.parse(await readFile(join(directory, name), "utf8")) as unknown;
      if (isTopic(parsed)) topics.push(recovered(parsed));
    } catch {
      // A torn or foreign file loses its topic, not the transcript.
    }
  }
  return topics.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

export function btwTurns(topic: BtwTopic): BtwTurn[] {
  return [topic, ...(topic.followUps ?? [])];
}

export interface AsideIds {
  userId: string;
  assistantId: string;
}

/**
 * Ids of one turn's two messages, derived from omp's topic id so a live stream and
 * a later transcript read agree. `~` sorts the answer after its question.
 */
export function asideMessageIds(sessionId: string, topicId: string, turnIndex: number, createdAt: number): AsideIds {
  const hex = timeHexFromTimestamp(createdAt);
  return {
    userId: `msg_${hex}_${sessionId}_aside_${topicId}_${turnIndex}`,
    assistantId: `msg_${hex}~${sessionId}_aside_${topicId}_${turnIndex}`,
  };
}

/** What the answer message says. */
export function asideAnswerText(turn: BtwTurn): string {
  switch (turn.status) {
    case "complete":
      return turn.answer;
    case "error":
      return `⚠️ ${turn.error ?? "The side question failed."}${turn.answer ? `\n\n${turn.answer}` : ""}`;
    case "cancelled":
      return turn.answer ? `${turn.answer}\n\n(cancelled)` : "(cancelled)";
    case "interrupted":
      return turn.answer ? `${turn.answer}\n\n(interrupted)` : "(interrupted)";
    case "running":
      return turn.answer || "…";
  }
}

/** The user message OpenChamber shows for a side question. */
export function asideQuestionText(turn: BtwTurn): string {
  return `/aside ${turn.question}`;
}
