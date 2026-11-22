/**
 * `/aside` as OpenChamber sees it: omp's `btw_record` / `btw_delta` frames of a
 * side question become a user message (`/aside <question>`) and an assistant
 * message whose text streams and is finalised by the terminal record. A side
 * question is an ephemeral turn: it opens no run, so nothing here touches the
 * session's busy/idle status. Ids derive from omp's topic id
 * (`omp/btw-history.ts`), so a later transcript read lands on the
 * same messages.
 */
import {
  asideAnswerText,
  asideMessageIds,
  asideQuestionText,
  btwTurns,
  type AsideIds,
  type BtwTopic,
  type BtwTurn,
} from "../omp/btw-history";
import { emitMessagePartDelta, emitMessagePartUpdated, emitMessageUpdated, emitOpenCodeV2Event } from "../shared/sse";

const ZERO_TOKENS = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
const MODEL = { id: "omp", providerID: "omp", modelID: "omp", variant: "default" };

interface LiveTurn {
  turnIndex: number;
  ids: AsideIds;
  createdAt: number;
}

export class AsideStream {
  readonly #sessionId: string;
  readonly #cwd: string;
  /** Turns whose answer is streaming, by topic id (output assembly). */
  readonly #live = new Map<string, LiveTurn>();

  constructor(sessionId: string, cwd: string) {
    this.#sessionId = sessionId;
    this.#cwd = cwd;
  }

  /** A side question is still being answered. */
  get active(): boolean {
    return this.#live.size > 0;
  }

  /** A topic's lifecycle snapshot: its latest turn started, finished, was cancelled or failed. */
  onRecord(topic: BtwTopic): void {
    const turns = btwTurns(topic);
    const turnIndex = turns.length - 1;
    const turn = turns[turnIndex]!;
    let live = this.#live.get(topic.id);
    if (!live || live.turnIndex !== turnIndex) {
      live = { turnIndex, ids: asideMessageIds(this.#sessionId, topic.id, turnIndex, turn.createdAt), createdAt: turn.createdAt };
      this.#live.set(topic.id, live);
      this.#start(topic.id, live, turn);
    }
    if (turn.status === "running") return;
    this.#live.delete(topic.id);
    this.#finish(topic.id, live, turn);
  }

  onDelta(topicId: string, delta: string): void {
    const live = this.#live.get(topicId);
    if (!live || !delta) return;
    emitMessagePartDelta(this.#sessionId, live.ids.assistantId, this.#answerPartId(live), delta, this.#cwd, "text");
  }

  #answerPartId(live: LiveTurn): string {
    return `part_${this.#sessionId}_${live.ids.assistantId}_text_0`;
  }

  #assistantInfo(topicId: string, live: LiveTurn, turn: BtwTurn, finished: boolean): Record<string, unknown> {
    const failed = turn.status === "error";
    return {
      id: live.ids.assistantId,
      role: "assistant",
      sessionID: this.#sessionId,
      parentID: live.ids.userId,
      agent: "omp",
      mode: "aside",
      cost: 0,
      path: { cwd: this.#cwd, root: this.#cwd },
      metadata: { aside: { recordId: topicId, turn: live.turnIndex, status: turn.status } },
      tokens: ZERO_TOKENS,
      model: MODEL,
      providerID: MODEL.providerID,
      modelID: MODEL.modelID,
      variant: MODEL.variant,
      ...(finished ? { finish: failed ? "error" : "stop" } : {}),
      ...(finished && failed ? { error: { message: turn.error ?? "The side question failed." } } : {}),
      time: { created: live.createdAt, ...(finished ? { completed: turn.updatedAt } : {}) },
    };
  }

  #start(topicId: string, live: LiveTurn, turn: BtwTurn): void {
    const { userId } = live.ids;
    // The same echo a prompt gets: the inbox item, the message, its part, then the delivery ACK.
    emitOpenCodeV2Event("session.inbox.enqueued", {
      sessionID: this.#sessionId,
      inboxID: userId,
      item: { type: "user", delivery: "queue", payload: { text: asideQuestionText(turn), files: [] } },
    }, this.#cwd);
    emitMessageUpdated({
      info: { id: userId, sessionID: this.#sessionId, role: "user", agent: "omp", model: MODEL, time: { created: live.createdAt, completed: live.createdAt } },
    }, this.#cwd);
    emitMessagePartUpdated(this.#sessionId, {
      id: `part_${this.#sessionId}_${userId}_0`,
      type: "text",
      text: asideQuestionText(turn),
      messageID: userId,
      sessionID: this.#sessionId,
    }, this.#cwd);
    emitOpenCodeV2Event("session.inbox.delivered", { sessionID: this.#sessionId, inboxID: userId }, this.#cwd);

    emitMessageUpdated({ info: this.#assistantInfo(topicId, live, turn, false) }, this.#cwd);
    emitMessagePartUpdated(this.#sessionId, {
      id: this.#answerPartId(live),
      type: "text",
      text: "",
      time: { start: live.createdAt },
      messageID: live.ids.assistantId,
      sessionID: this.#sessionId,
    }, this.#cwd);
  }

  #finish(topicId: string, live: LiveTurn, turn: BtwTurn): void {
    emitMessagePartUpdated(this.#sessionId, {
      id: this.#answerPartId(live),
      type: "text",
      text: asideAnswerText(turn),
      time: { start: live.createdAt, end: turn.updatedAt },
      messageID: live.ids.assistantId,
      sessionID: this.#sessionId,
    }, this.#cwd);
    emitMessageUpdated({ info: this.#assistantInfo(topicId, live, turn, true) }, this.#cwd);
  }
}
