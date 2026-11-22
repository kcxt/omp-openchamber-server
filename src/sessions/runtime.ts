/**
 * One driven session: an omp `--mode rpc` child that holds the session's
 * lease, a state machine driven only by omp frames and child exit, and the
 * TurnTranslators that turn its stream into OpenCode events.
 *
 * Busy is the parent's own work (PLAN §3.1): `active` from an accepted prompt
 * or `agent_start` until the run's terminal `agent_end`, and through the gap
 * before a run omp has already decided to start (a goal continuation:
 * `get_state.isSettled === false` with no pending async work). Background
 * subagents and async jobs leave the parent `idle`; their child sessions are
 * busy instead.
 */
import { RpcChild } from "../omp/rpc-child";
import type { ChildRecord } from "../omp/supervisor";
import { readOmpConfigSmallModel } from "../adapters/openchamber/small-model";
import { clearSessionApprovals } from "../adapters/openchamber/approvals";
import { readSessionIdSync, toOpenCodeSessionId } from "../store/sessions";
import { readTranscriptSummary } from "../omp/transcript-reader";
import { extractTodosFromOmpDetails } from "../omp/todo";
import { parseGoal } from "../omp/goal";
import type { BackendCredentials, BackendGoalOp, BackendGoalSnapshot, ImageContent, ModelRef } from "../shared/types";
import { logger, promptLogger } from "../shared/logger";
import {
  emitOpenCodeV2Event,
  emitSessionCreated,
  emitSessionError,
  emitSessionIdle,
  emitSessionStatus,
  emitSessionUpdated,
} from "../shared/sse";
import { TurnTranslator, type OmpFrame } from "./turn-translator";
import { AsideStream } from "./aside";
import type { BtwTopic } from "../omp/btw-history";

export type RuntimeState = "starting" | "idle" | "active" | "aborting" | "closed";
export type CloseReason = "idle" | "deleted" | "shutdown" | "crash" | "abort" | "replaced";

export interface StateChange {
  state: RuntimeState;
  previous: RuntimeState;
  /** The change ends a run the user stopped. */
  aborted?: boolean;
}

export interface ModelPick {
  providerID: string;
  modelID: string;
  /** OpenChamber's effort pick; `default` (or none) leaves omp's level alone. */
  variant?: string;
}

export interface PromptInput {
  message: string;
  images?: ImageContent[];
  /** OpenChamber's client message id; omp stores it on the user entry (P1). */
  hostMessageId: string;
  /** Joins a live run at the next turn boundary (`steer`) or after it (`queue`). */
  delivery?: "steer" | "queue";
}

/** Queued input `abort_and_restore_queue` withdrew, with the inbox ids it was announced under. */
export interface Withdrawn {
  steering: string[];
  followUp: string[];
  inboxIDs: string[];
}

export type SubagentStatus = "running" | "completed" | "failed" | "aborted";

export interface SubagentInfo {
  id: string;
  childSessionId?: string;
  status: SubagentStatus;
  agent: string;
  description: string;
  sessionFile?: string;
  startedAt: number;
  endedAt?: number;
}

export interface BackgroundJob {
  id: string;
  sessionID: string;
  status: "running";
  title?: string;
  time: { started: number };
  kind: "subagent" | "shell";
  childSessionID?: string;
  agent?: string;
  description?: string;
  shellID?: string;
  command?: string;
}

/** Another omp process holds the session's lease (P3 `claimLease` refused). */
export class OwnedElsewhereError extends Error {
  constructor() {
    super("This session is open in another omp. Close that omp window and send again, or use \"Fork from here\" to continue in a copy.");
    this.name = "OwnedElsewhereError";
  }
}

interface SubagentEntry extends SubagentInfo {
  translator?: TurnTranslator;
  /** subagent_event frames that arrived before the child session id was known. */
  buffered: OmpFrame[];
  /** Settles once `childSessionId` is known. */
  resolved?: Promise<void>;
  failure?: string;
}

/** How long Esc waits for the parent run to stop before the child is killed (§3.4). */
export const ABORT_DEADLINE_MS = 5_000;
/** While active with no run streaming (a pending start or goal continuation), omp's state is re-read this often. */
const DUE_POLL_MS = 1_000;
const CRASH_MESSAGE = "The omp process exited unexpectedly; send another message to restart the session.";

/**
 * How long an idle, settled omp child keeps its session after omp owes no
 * idle maintenance. omp owns a session through a lease held for as long as
 * its process lives, so an idle child that lingers blocks a terminal omp
 * resuming the same session. 0 keeps children until the sidecar stops.
 */
function childIdleMs(): number {
  const configured = Number(process.env.OC_CHILD_IDLE_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : 120_000;
}

/** omp `set_thinking_level` accepts these; anything else stays on omp's own level. */
const ompThinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function ompThinkingLevel(variant: string | undefined): string | undefined {
  const level = variant?.trim().toLowerCase();
  if (!level) return undefined;
  if (level === "none") return "off";
  return ompThinkingLevels.has(level) ? level : undefined;
}

/** OpenChamber's "default" effort: no pick of its own, omp's default for the model applies. */
function isDefaultVariant(variant: string | undefined): boolean {
  const level = variant?.trim().toLowerCase();
  return !level || level === "default";
}

/**
 * omp's default level for the model it runs: the catalog's `thinking.defaultLevel`
 * (carried on `get_state.model`), else omp's own fallback, high. omp clamps
 * the level to what the model supports (a model without reasoning stays off).
 */
function defaultThinkingLevel(model: Record<string, unknown> | undefined): string {
  const declared = record(model?.thinking)?.defaultLevel;
  return typeof declared === "string" && ompThinkingLevels.has(declared) ? declared : "high";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function texts(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((item) => typeof record(item)?.text === "string" ? [record(item)!.text as string] : []) : [];
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class SessionRuntime {
  readonly sessionId: string;
  readonly cwd: string;
  /** Fingerprint of caller-owned credentials this child was spawned with, if any. */
  readonly credentialFingerprint?: string;
  readonly #child: RpcChild;
  readonly #translator: TurnTranslator;
  #state: RuntimeState = "starting";
  #transcriptPath: string;
  #chain: Promise<unknown> = Promise.resolve();

  /** A run is streaming (between `agent_start` and its terminal `agent_end`). */
  #runLive = false;
  /** A prompt was accepted and its run has not started yet. */
  #awaitingRun = false;
  /** omp has a parent run due (goal continuation) or its state could not be read since the last run ended. */
  #due = false;
  #dueGeneration = 0;
  /** Commands that keep the session busy while they run (compaction). */
  #busyCommands = 0;
  /** Client ids of prompts omp accepted and has not journaled yet, in send order (output assembly). */
  #undelivered: string[] = [];
  /** Collects `command_output` while the runtime runs a command itself (`/move`). */
  #capture?: string[];
  readonly #aside: AsideStream;

  #pollTimer?: ReturnType<typeof setTimeout>;
  #releaseTimer?: ReturnType<typeof setTimeout>;
  /** The title last published to OpenChamber (output dedupe only: omp's `session_info_update` is the source). */
  #publishedTitle?: string;
  #unsubscribe: () => void;
  #stateListeners = new Set<(change: StateChange) => void>();
  #recapListeners = new Set<(recap: string, createdAt: number, forMessageID: string | undefined) => void>();
  #subagents = new Map<string, SubagentEntry>();

  private constructor(child: RpcChild, init: { sessionId: string; cwd: string; transcriptPath: string; credentialFingerprint?: string }) {
    this.sessionId = init.sessionId;
    this.cwd = init.cwd;
    this.credentialFingerprint = init.credentialFingerprint;
    this.#transcriptPath = init.transcriptPath;
    this.#child = child;
    this.#aside = new AsideStream(init.sessionId, init.cwd);
    this.#translator = new TurnTranslator({
      sessionId: init.sessionId,
      cwd: init.cwd,
      model: { providerID: "omp", modelID: "omp", variant: "default" },
      host: {
        respond: (frame) => child.sendFrame(frame),
        readTodos: async () => extractTodosFromOmpDetails({ phases: (await this.#getState())?.todoPhases }) ?? undefined,
        journalNotice: (text, level) => this.#journalNotice(text, level),
        delivered: (id) => {
          this.#undelivered = this.#undelivered.filter((entry) => entry !== id);
        },
      },
    });
    this.#unsubscribe = child.onEvent((frame) => this.#onFrame(frame as OmpFrame));
  }

  /**
   * Spawns a child and opens the session with `switch_session { claimLease }`.
   * The runtime is returned in `starting`; `ready` settles once the session is
   * open (rejecting with OwnedElsewhereError when another omp holds it).
   */
  static async spawn(init: {
    sessionId: string;
    cwd: string;
    transcriptPath: string;
    credential?: BackendCredentials;
    credentialFingerprint?: string;
  }): Promise<SessionRuntime> {
    const child = await RpcChild.spawn(init.cwd, 3, { autoTitle: true, label: init.sessionId, ...(init.credential ? { credential: init.credential } : {}) });
    const runtime = new SessionRuntime(child, init);
    try {
      await runtime.#open();
    } catch (err) {
      runtime.close("crash");
      throw err;
    }
    child.annotate({ sessionId: init.sessionId, transcriptPath: runtime.#transcriptPath, credentialFingerprint: init.credentialFingerprint });
    return runtime;
  }

  /**
   * Takes over a supervised child a previous sidecar left running (`omp/supervisor.ts`). Nothing is
   * cached across the handover: busy/idle, the model, the title and running subagents are read back
   * from omp, and a run still streaming keeps the session busy until its own `agent_end`.
   */
  static async adopt(record: ChildRecord): Promise<SessionRuntime> {
    if (!record.sessionId || !record.transcriptPath) throw new Error(`${record.unit} has no session`);
    const child = await RpcChild.attach(record);
    const runtime = new SessionRuntime(child, {
      sessionId: record.sessionId,
      cwd: record.cwd,
      transcriptPath: record.transcriptPath,
      credentialFingerprint: record.credentialFingerprint,
    });
    try {
      await runtime.#reattach();
    } catch (err) {
      runtime.close("crash");
      throw err;
    }
    return runtime;
  }

  get state(): RuntimeState {
    return this.#state;
  }

  /** The transcript omp writes, from `get_state.sessionFile` after every run. */
  get transcriptPath(): string {
    return this.#transcriptPath;
  }

  /** The model omp runs, as last reported by omp. */
  get model(): ModelRef {
    return { ...this.#translator.model };
  }

  onStateChange(fn: (change: StateChange) => void): () => void {
    this.#stateListeners.add(fn);
    return () => this.#stateListeners.delete(fn);
  }

  /** omp produced an idle recap (P4 `recap` frame). */
  onRecap(fn: (recap: string, createdAt: number, forMessageID: string | undefined) => void): () => void {
    this.#recapListeners.add(fn);
    return () => this.#recapListeners.delete(fn);
  }

  // ------------------------------------------------------------------ commands

  /** Sends a prompt; resolves once omp accepted it (not when the run ends). */
  prompt(input: PromptInput): Promise<void> {
    return this.#serial(async () => {
      this.#assertOpen();
      if (this.#state === "idle") this.#translator.setParent(input.hostMessageId);
      this.#undelivered.push(input.hostMessageId);
      // A behaviour is always given: omp ignores it when idle, and a run omp
      // starts on its own (a goal continuation) can never refuse the prompt.
      const data = await this.#child.request("prompt", {
        message: input.message,
        ...(input.images?.length ? { images: input.images } : {}),
        hostMessageId: input.hostMessageId,
        streamingBehavior: input.delivery === "steer" ? "steer" : "followUp",
      });
      if (record(data)?.agentInvoked === false) {
        // Handled locally (builtin command): omp journals nothing and starts no run.
        this.#undelivered = this.#undelivered.filter((entry) => entry !== input.hostMessageId);
        if (!this.#runLive) this.#translator.finishRun();
      } else if (!this.#runLive) {
        this.#awaitingRun = true;
      }
      this.#recompute();
    });
  }

  /**
   * P5 `resume`: omp's `.` continue, on this session or one of its subagents.
   * With `hostMessageId` omp journals a `host-resume` marker first; when there
   * is nothing to resume, the refusal becomes the marker's reply (a notice), so
   * the transcript never ends on a dangling user message.
   */
  resume(options: { hostMessageId?: string; subagentId?: string }): Promise<void> {
    return this.#serial(async () => {
      this.#assertOpen();
      const own = !options.subagentId;
      if (own && this.#state === "idle" && options.hostMessageId) this.#translator.setParent(options.hostMessageId);
      try {
        await this.#child.request("resume", {
          ...(options.subagentId ? { subagentId: options.subagentId } : {}),
          ...(options.hostMessageId ? { hostMessageId: options.hostMessageId } : {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message.replace(/^RPC resume: /, "") : String(err);
        if (!own || !options.hostMessageId || this.#runLive) throw new Error(message);
        this.#translator.notice(message, "warning");
        this.#translator.finishRun();
        return;
      }
      if (own && !this.#runLive) {
        this.#awaitingRun = true;
        this.#recompute();
      }
    });
  }

  /**
   * Esc (§3.4): withdraws queued input and stops the parent run and its
   * synchronous subagents. Background subagents keep running. The child is
   * killed only when the parent run is still streaming at the deadline.
   */
  async abort(): Promise<Withdrawn> {
    const none: Withdrawn = { steering: [], followUp: [], inboxIDs: [] };
    if (this.#state === "closed" || this.#state === "starting") return none;
    if (this.#state !== "active") {
      // Nothing of the parent's runs; a queue an earlier abort stranded is still withdrawn.
      const data = await this.#child.request("abort_and_restore_queue", {}).catch(() => undefined);
      return this.#withdrawn(data);
    }
    this.#setState("aborting");
    const deadline = Date.now() + ABORT_DEADLINE_MS;
    let withdrawn = none;
    try {
      withdrawn = this.#withdrawn(await this.#child.request("abort_and_restore_queue", {}, ABORT_DEADLINE_MS));
      // The response is written after the run's agent_end; confirm omp stopped streaming.
      for (;;) {
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`omp still streaming ${ABORT_DEADLINE_MS}ms after abort`);
        if (!this.#runLive) {
          const state = await this.#getState(left);
          if (state && state.isStreaming !== true) break;
        }
        await sleep(Math.min(100, left));
      }
    } catch (err) {
      promptLogger.error({ err, sessionID: this.sessionId }, "[abort] the parent run did not stop; killing the omp child");
      this.close("abort");
      return withdrawn;
    }
    this.#awaitingRun = false;
    this.#due = false;
    this.#dueGeneration++;
    this.#undelivered = [];
    this.#setState(this.#runLive ? "active" : "idle", { aborted: true });
    return withdrawn;
  }

  /** Compacts the session through its own child. Refused while a run is live. */
  compact(): Promise<void> {
    return this.#serial(async () => {
      this.#assertOpen();
      if (this.#runLive || this.#awaitingRun) throw new Error("session is busy; wait for the turn to finish before compacting");
      this.#busyCommands++;
      this.#recompute();
      try {
        // Summarising calls a model; the default request deadline is far too short.
        await this.#child.request("compact", {}, 10 * 60_000);
      } finally {
        this.#busyCommands--;
        this.#recompute();
      }
    });
  }

  /**
   * Applies a model pick: `set_model` when omp runs another model, then the
   * effort (omp resets it on a model switch). A pick of `default` sends omp's
   * default level for the model, so the UI's pick is what runs.
   * Throws when omp refuses the model.
   */
  setModel(pick: ModelPick): Promise<void> {
    return this.#serial(async () => {
      this.#assertOpen();
      let live = record((await this.#getState())?.model);
      if (live?.provider !== pick.providerID || live?.id !== pick.modelID) {
        try {
          await this.#child.request("set_model", { provider: pick.providerID, modelId: pick.modelID });
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          throw new Error(`could not switch to ${pick.providerID}/${pick.modelID}: ${reason}`);
        }
        if (isDefaultVariant(pick.variant)) live = record((await this.#getState())?.model);
      }
      const level = isDefaultVariant(pick.variant) ? defaultThinkingLevel(live) : ompThinkingLevel(pick.variant);
      let variant = pick.variant ?? "default";
      if (level) {
        await this.#child.request("set_thinking_level", { level }).catch((err) => {
          variant = this.#translator.model.variant;
          this.#reportProblem(err, `omp rejected the reasoning effort "${level}"`);
        });
      }
      this.#translator.model = { providerID: pick.providerID, modelID: pick.modelID, variant };
    });
  }

  goal(op: BackendGoalOp, input?: { objective?: string; tokenBudget?: number }): Promise<void> {
    return this.#serial(async () => {
      this.#assertOpen();
      await this.#child.request("goal", {
        op,
        ...(input?.objective !== undefined ? { objective: input.objective } : {}),
        ...(input?.tokenBudget !== undefined ? { token_budget: input.tokenBudget } : {}),
      });
    });
  }

  async getGoal(): Promise<BackendGoalSnapshot | null> {
    return parseGoal(record((await this.#getState())?.goal)?.goal);
  }

  /**
   * Revert / redo (§3.9): `navigate_tree` moves omp's leaf in memory only, so
   * the `host-revert` entry appended on the new leaf is what makes the branch
   * durable (a child that dies now, or another omp opening the file, sees it).
   * `entryId` is a user message to rewind past (omp moves the leaf to its
   * parent), or the abandoned leaf on redo.
   */
  navigateTo(entryId: string, journal: { action: "revert" | "redo"; messageID: string }): Promise<void> {
    return this.#serial(async () => {
      this.#assertOpen();
      if (this.#state !== "idle") throw new Error("session is busy; wait for the turn to finish");
      await this.#child.request("navigate_tree", { entryId });
      await this.#child.request("append_custom_entry", { customType: "host-revert", data: journal });
    });
  }

  /**
   * omp's `fork` (whole history, or up to `entryId`) or `branch` (before the
   * user message `entryId`). The child moves onto the new transcript, so the
   * runtime names it, reports where it is and closes: the original session is
   * opened afresh by its next prompt, the fork by its own.
   */
  fork(target?: { entryId: string; before: boolean }, name?: string): Promise<{ transcriptPath: string; sessionId: string }> {
    return this.#serial(async () => {
      this.#assertOpen();
      if (this.#state !== "idle") throw new Error("session is busy; wait for the turn to finish");
      await this.#child.request(target?.before ? "branch" : "fork", target ? { entryId: target.entryId } : {});
      const state = await this.#getState();
      if (typeof state?.sessionFile !== "string" || typeof state.sessionId !== "string") throw new Error("omp did not report the forked session");
      if (name) await this.#child.request("set_session_name", { name });
      this.close("replaced");
      return { transcriptPath: state.sessionFile, sessionId: state.sessionId };
    });
  }

  /**
   * omp's builtin `/move <dir>` (R5): no model call, same session id, the
   * transcript moves to the directory's bucket. A refusal arrives only as
   * `command_output` with `success: true`, so the reply text is the verdict.
   * On success the child (re-scoped to the new directory) is closed.
   */
  move(directory: string): Promise<{ transcriptPath: string }> {
    return this.#serial(async () => {
      this.#assertOpen();
      if (this.#state !== "idle") throw new Error("Cannot move while the session is running.");
      const before = this.#transcriptPath;
      const replies: string[] = [];
      this.#capture = replies;
      try {
        await this.#child.request("prompt", { message: `/move ${directory}` });
      } finally {
        this.#capture = undefined;
      }
      const text = replies.join("\n").trim();
      const state = await this.#getState();
      const moved = typeof state?.sessionFile === "string" ? state.sessionFile : undefined;
      if (!/^Moved to /i.test(text) || !moved || moved === before) throw new Error(text || "omp did not move the session");
      this.#transcriptPath = moved;
      this.close("replaced");
      return { transcriptPath: moved };
    });
  }

  /** omp's `set_session_name`: the title slot of the transcript is omp's to write. */
  setName(name: string): Promise<void> {
    return this.#serial(async () => {
      this.#assertOpen();
      await this.#child.request("set_session_name", { name });
    });
  }

  /**
   * `/aside`: omp's `btw`, an ephemeral side turn that runs beside the main
   * conversation (even mid-run), opens no run and never changes this runtime's
   * state. The answer arrives as `btw_record` / `btw_delta` frames.
   */
  async btw(question: string): Promise<BtwTopic> {
    this.#assertOpen();
    const data = record(await this.#child.request("btw", { question }));
    return data?.record as BtwTopic;
  }

  /** Runs a shell command in the session's child (`/session/:id/shell`). */
  bash(command: string): Promise<unknown> {
    this.#assertOpen();
    return this.#child.request("bash", { command }, 10 * 60_000);
  }

  // ------------------------------------------------------------------ subagents

  subagents(): SubagentInfo[] {
    return [...this.#subagents.values()].map(({ translator: _t, buffered: _b, failure: _f, resolved: _r, ...info }) => info);
  }

  subagentByChild(childSessionId: string): SubagentInfo | undefined {
    return this.subagents().find((entry) => entry.childSessionId === childSessionId);
  }

  steerSubagent(subagentId: string, message: string): Promise<unknown> {
    this.#assertOpen();
    return this.#child.request("steer_subagent", { subagentId, message });
  }

  /**
   * `/switch` on a subagent's session: omp switches that subagent alone and persists nothing. A `default`
   * effort sends no level, so omp applies the model's default for the subagent.
   * Throws when omp refuses the subagent or the model.
   */
  async setSubagentModel(subagentId: string, pick: ModelPick): Promise<void> {
    this.#assertOpen();
    const level = isDefaultVariant(pick.variant) ? undefined : ompThinkingLevel(pick.variant);
    try {
      await this.#child.request("set_subagent_model", {
        subagentId,
        provider: pick.providerID,
        modelId: pick.modelID,
        ...(level ? { level } : {}),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message.replace(/^RPC set_subagent_model: /, "") : String(err);
      throw new Error(`could not switch to ${pick.providerID}/${pick.modelID}: ${reason}`);
    }
    const entry = this.#subagents.get(subagentId);
    if (entry?.translator) entry.translator.model = { providerID: pick.providerID, modelID: pick.modelID, variant: pick.variant ?? "default" };
  }

  cancelSubagent(subagentId: string): Promise<unknown> {
    this.#assertOpen();
    return this.#child.request("cancel_subagent", { subagentId });
  }

  /** Background work running in this session: subagents, and async jobs omp reports as pending. */
  async jobs(): Promise<BackgroundJob[]> {
    // A job names its child session, whose id comes from the artifact header omp writes just after `started`.
    await Promise.all([...this.#subagents.values()].filter((entry) => entry.status === "running").map((entry) => entry.resolved));
    const running = this.subagents().filter((entry) => entry.status === "running" && entry.childSessionId);
    const jobs: BackgroundJob[] = running.map((entry) => ({
      id: entry.id,
      sessionID: this.sessionId,
      status: "running",
      title: entry.id,
      time: { started: entry.startedAt },
      kind: "subagent",
      childSessionID: entry.childSessionId!,
      agent: entry.agent,
      description: entry.description,
    }));
    if (running.length === 0 && this.#state !== "closed") {
      const state = await this.#getState();
      if (state?.hasPendingAsyncWork === true) {
        jobs.push({
          id: `${this.sessionId}:async`,
          sessionID: this.sessionId,
          status: "running",
          title: "Background job",
          time: { started: Date.now() },
          kind: "shell",
          shellID: `${this.sessionId}:async`,
          command: "omp background job",
        });
      }
    }
    return jobs;
  }

  // ------------------------------------------------------------------ lifecycle

  /**
   * The sidecar is going away and this child stays: no kill, nothing is announced as ended. A new
   * sidecar adopts it (`adopt`). Unsupervised children cannot outlive the sidecar and are closed.
   */
  release(): void {
    if (this.#state === "closed") return;
    if (!this.#child.record) return this.close("shutdown");
    this.#state = "closed";
    clearTimeout(this.#pollTimer);
    clearTimeout(this.#releaseTimer);
    this.#unsubscribe();
    this.#child.release();
    logger.debug({ sessionID: this.sessionId }, "[runtime] released to the next sidecar");
  }

  close(reason: CloseReason): void {
    if (this.#state === "closed") return;
    const previous = this.#state;
    this.#state = "closed";
    clearTimeout(this.#pollTimer);
    clearTimeout(this.#releaseTimer);
    this.#unsubscribe();
    this.#child.kill();
    clearSessionApprovals(this.sessionId);
    for (const entry of this.#subagents.values()) {
      if (entry.status === "running") this.#endChild(entry, "aborted");
    }
    logger.debug({ sessionID: this.sessionId, reason }, "[runtime] closed");
    for (const listener of this.#stateListeners) listener({ state: "closed", previous, aborted: reason === "abort" });
  }

  // ------------------------------------------------------------------ internals

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#chain.then(fn);
    this.#chain = result.catch(() => {});
    return result;
  }

  #assertOpen(): void {
    if (this.#state === "closed" || !this.#child.isAlive()) throw new Error("the omp child for this session has exited");
  }

  /** Logs a failure and shows it in OpenChamber's chat view as a session error. */
  #reportProblem(err: unknown, what: string): void {
    const reason = err instanceof Error ? err.message : String(err);
    promptLogger.error({ err, sessionID: this.sessionId }, `[runtime] ${what}`);
    emitSessionError(this.sessionId, { message: `${what}: ${reason}` }, this.cwd);
  }

  /** omp named the session (`session_info_update`): tell OpenChamber, once per distinct title. */
  #publishTitle(raw: unknown): void {
    const title = typeof raw === "string" ? raw.trim() : "";
    if (!title || title === this.#publishedTitle) return;
    this.#publishedTitle = title;
    emitSessionUpdated({ id: this.sessionId, title, time: { updated: Date.now() } }, this.cwd);
    emitOpenCodeV2Event("session.renamed", { sessionID: this.sessionId, title }, this.cwd);
  }

  async #getState(timeoutMs?: number): Promise<Record<string, unknown> | undefined> {
    if (!this.#child.isAlive()) return undefined;
    try {
      return record(await this.#child.request("get_state", {}, timeoutMs));
    } catch {
      return undefined;
    }
  }

  async #open(): Promise<void> {
    const sessionPath = this.#transcriptPath;
    const claim = async (extra: Record<string, unknown> = {}) => {
      try {
        await this.#child.request("switch_session", { sessionPath, claimLease: true, ...extra });
      } catch (err) {
        if (err instanceof Error && /owned by another omp|session_busy/i.test(err.message)) throw new OwnedElsewhereError();
        throw err;
      }
    };
    try {
      await claim();
    } catch (error) {
      // The session's last model can no longer be restored (typically a local
      // provider whose server is down). Open it on the cheap role (smol, then
      // tiny) or the child's own model instead of failing every prompt.
      if (!(error instanceof Error) || !error.message.includes("Could not restore model")) throw error;
      const role = readOmpConfigSmallModel();
      const model = record((await this.#getState())?.model);
      const provider = role?.providerID ?? model?.provider;
      const modelId = role?.modelID ?? model?.id;
      if (typeof provider !== "string" || typeof modelId !== "string") throw error;
      logger.warn({ sessionPath, provider, modelId }, `[omp] ${error.message}; opening the session on ${provider}/${modelId}`);
      await claim({ provider, modelId });
    }
    const state = await this.#getState();
    if (typeof state?.sessionFile === "string") this.#transcriptPath = state.sessionFile;
    const model = record(state?.model);
    if (typeof model?.provider === "string" && typeof model.id === "string") {
      this.#translator.model = { providerID: model.provider, modelID: model.id, variant: typeof state?.thinkingLevel === "string" ? state.thinkingLevel : "default" };
    }
    this.#publishedTitle = (await readTranscriptSummary(this.#transcriptPath).catch(() => null))?.title;
    this.#state = "idle";
    for (const listener of this.#stateListeners) listener({ state: "idle", previous: "starting" });
    this.#recompute();
    this.#armRelease();
  }

  async #reattach(): Promise<void> {
    const state = await this.#getState();
    if (!state) throw new Error("the adopted omp child did not report its state");
    if (typeof state.sessionFile === "string") this.#transcriptPath = state.sessionFile;
    const model = record(state.model);
    if (typeof model?.provider === "string" && typeof model.id === "string") {
      this.#translator.model = { providerID: model.provider, modelID: model.id, variant: typeof state.thinkingLevel === "string" ? state.thinkingLevel : "default" };
    }
    this.#publishedTitle = (await readTranscriptSummary(this.#transcriptPath).catch(() => null))?.title;
    // Subagents the previous sidecar was following: re-announced as started, so their child sessions are followed again.
    const snapshot = record(await this.#child.request("get_subagents").catch(() => undefined));
    for (const entry of Array.isArray(snapshot?.subagents) ? snapshot.subagents : []) {
      const sub = record(entry);
      if (!sub || (sub.status !== "running" && sub.status !== "pending")) continue;
      this.#onSubagentFrame({ type: "subagent_lifecycle", payload: { id: sub.id, agent: sub.agent, description: sub.description, sessionFile: sub.sessionFile, status: "started" } } as OmpFrame);
    }
    this.#runLive = state.isStreaming === true;
    this.#state = "idle";
    for (const listener of this.#stateListeners) listener({ state: "idle", previous: "starting" });
    this.#recompute();
    // A run omp decided to start while no sidecar was attached (a goal continuation) is found the same way a run's end finds it.
    if (!this.#runLive) void this.#checkDue();
    this.#armRelease();
  }

  #onFrame(frame: OmpFrame): void {
    if (this.#state === "closed") return;
    switch (frame.type) {
      case "subagent_lifecycle":
      case "subagent_progress":
      case "subagent_event":
        this.#onSubagentFrame(frame);
        return;
      case "btw_record":
        this.#aside.onRecord(frame.record as BtwTopic);
        return;
      case "btw_delta":
        if (typeof frame.recordId === "string" && typeof frame.delta === "string") this.#aside.onDelta(frame.recordId, frame.delta);
        return;
      case "recap": {
        const text = typeof frame.recap === "string" ? frame.recap.trim() : "";
        const createdAt = typeof frame.createdAt === "number" ? frame.createdAt : Date.now();
        if (text) for (const listener of this.#recapListeners) listener(text, createdAt, this.#translator.lastAssistantId);
        return;
      }
      case "rpc_process_closed":
        this.#onExit();
        return;
    }
    // A command the runtime itself sent (`/move`): its reply is the answer, not a notice.
    if (frame.type === "command_output" && this.#capture) {
      if (typeof frame.text === "string") this.#capture.push(frame.text);
      return;
    }
    // The translator first: a run's closing events go out before the idle they lead to.
    this.#translator.handle(frame);
    if (frame.type === "session_info_update") this.#publishTitle(frame.title);
    switch (frame.type) {
      case "agent_start":
        this.#runLive = true;
        this.#awaitingRun = false;
        this.#due = false;
        this.#dueGeneration++;
        break;
      case "agent_end":
        if (frame.isTerminal === false) break;
        this.#runLive = false;
        // Until omp says otherwise, a next run may be due (goal continuation): no idle in between.
        this.#due = true;
        void this.#checkDue();
        break;
      case "prompt_result":
        if (!this.#runLive) {
          this.#awaitingRun = false;
          if (frame.agentInvoked === false) this.#translator.finishRun();
        }
        break;
      case "session_settled":
        if (!this.#runLive) {
          this.#awaitingRun = false;
          this.#due = false;
          this.#dueGeneration++;
          for (const entry of this.#subagents.values()) if (entry.status === "running") this.#endChild(entry, "completed");
        }
        break;
    }
    this.#recompute();
  }

  /** After a run: is another parent run due (`!isSettled` with no async work pending), or is the parent idle? */
  async #checkDue(): Promise<void> {
    const generation = ++this.#dueGeneration;
    const state = await this.#getState();
    if (generation !== this.#dueGeneration || this.#runLive || this.#state === "closed") return;
    // Unreadable state is not idle: keep the session busy and ask again.
    if (state) {
      if (typeof state.sessionFile === "string") this.#transcriptPath = state.sessionFile;
      // R10: a run is due iff omp is not settled with no async work pending and nothing queued
      // (queued input with nothing running is a stretch a plain abort stranded, not a due run).
      this.#due = state.isStreaming === true
        || (state.isSettled === false && state.hasPendingAsyncWork !== true && Number(state.queuedMessageCount ?? 0) === 0);
      if (this.#awaitingRun && state.isStreaming !== true && state.isSettled === true) this.#awaitingRun = false;
    }
    this.#recompute();
  }

  #recompute(): void {
    if (this.#state === "closed" || this.#state === "aborting" || this.#state === "starting") return;
    const busy = this.#runLive || this.#awaitingRun || this.#due || this.#busyCommands > 0;
    this.#setState(busy ? "active" : "idle");
    clearTimeout(this.#pollTimer);
    if (busy && !this.#runLive && this.#busyCommands === 0) {
      this.#pollTimer = setTimeout(() => void this.#checkDue(), DUE_POLL_MS);
      this.#pollTimer.unref?.();
    }
  }

  #setState(next: RuntimeState, extra: { aborted?: boolean } = {}): void {
    if (this.#state === next || this.#state === "closed") return;
    const previous = this.#state;
    this.#state = next;
    if (next === "idle") {
      this.#undelivered = [];
      this.#armRelease();
    } else {
      clearTimeout(this.#releaseTimer);
    }
    for (const listener of this.#stateListeners) listener({ state: next, previous, ...extra });
  }

  /**
   * Idle release (§3.2): once idle, settled (no background work in the child)
   * and owing no idle maintenance (P4), the child waits OC_CHILD_IDLE_MS more
   * and closes. Unreadable state keeps it.
   */
  #armRelease(): void {
    clearTimeout(this.#releaseTimer);
    const ms = childIdleMs();
    if (ms === 0 || this.#state !== "idle") return;
    const releasable = async (): Promise<{ ok: boolean; retryMs: number }> => {
      const state = await this.#getState();
      if (this.#state !== "idle" || !state) return { ok: false, retryMs: 5_000 };
      // A side question still streaming dies with the child.
      if (this.#aside.active) return { ok: false, retryMs: 5_000 };
      const owed = record(state.idleMaintenance);
      if (owed) {
        const due = Math.max(Number(owed.recapDueAt) || 0, Number(owed.compactionDueAt) || 0);
        return { ok: false, retryMs: Math.max(1_000, Math.min(due - Date.now() + 500, 60_000)) };
      }
      return { ok: state.isSettled === true, retryMs: 5_000 };
    };
    const schedule = (delay: number, fn: () => void) => {
      clearTimeout(this.#releaseTimer);
      if (this.#state !== "idle") return;
      this.#releaseTimer = setTimeout(fn, delay);
      this.#releaseTimer.unref?.();
    };
    const check = async () => {
      const first = await releasable();
      if (!first.ok) return schedule(first.retryMs, () => void check());
      schedule(ms, () => void (async () => {
        const second = await releasable();
        if (second.ok) this.close("idle");
        else schedule(second.retryMs, () => void check());
      })());
    };
    void check();
  }

  #onExit(): void {
    if (this.#state === "closed") return;
    promptLogger.error({ sessionID: this.sessionId, state: this.#state }, "[runtime] omp child exited unexpectedly");
    if (this.#state === "active" || this.#state === "aborting") this.#translator.finishRun(CRASH_MESSAGE, "error");
    this.close("crash");
  }

  /**
   * omp withdraws every user prompt it has queued and not yet journaled, so
   * the withdrawn inbox items are exactly the undelivered ones; no matching
   * by text.
   */
  #withdrawn(data: unknown): Withdrawn {
    const value = record(data);
    const steering = texts(value?.steering);
    const followUp = texts(value?.followUp);
    if (steering.length + followUp.length === 0) return { steering, followUp, inboxIDs: [] };
    const inboxIDs = this.#undelivered.splice(0);
    return { steering, followUp, inboxIDs };
  }

  /**
   * omp keeps no record of a command's notify message; journaling it as a
   * custom entry (P2) keeps the reply in the transcript, so it survives a
   * refetch and the turn does not read as unanswered.
   */
  #journalNotice(text: string, level: string): void {
    if (!this.#child.isAlive()) return;
    void this.#child
      .request("append_custom_entry", { customType: "oc-notice", data: { text, level } })
      .catch((err) => this.#reportProblem(err, "could not keep a command's reply in the transcript"));
  }

  /** Journals a command the sidecar ran itself (`/goal …`) as a user message (P2 `host-command`, rendered like `host-resume`). */
  async journalUserCommand(text: string, hostMessageId: string): Promise<void> {
    await this.#child.request("append_custom_entry", { customType: "host-command", data: { text, hostMessageId } });
  }

  // ------------------------------------------------------------------ subagent stream

  #onSubagentFrame(frame: OmpFrame): void {
    const payload = record(frame.payload) ?? {};
    if (frame.type === "subagent_event") {
      const id = typeof payload.id === "string" ? payload.id : "";
      const event = record(payload.event);
      const entry = this.#subagents.get(id);
      if (!entry || !event) return;
      if (entry.translator) entry.translator.handle(event);
      else entry.buffered.push(event);
      return;
    }
    const progress = record(payload.progress);
    const id = String((frame.type === "subagent_progress" ? progress?.id : undefined) ?? payload.id ?? "");
    if (!id) return;
    const sessionFile = typeof payload.sessionFile === "string" ? payload.sessionFile : typeof progress?.sessionFile === "string" ? progress.sessionFile : undefined;
    let entry = this.#subagents.get(id);
    if (!entry) {
      const agent = String(payload.agent ?? "task");
      const description = typeof payload.description === "string" && payload.description.trim()
        ? payload.description.trim()
        : typeof payload.assignment === "string" && payload.assignment.trim() ? payload.assignment.trim().split("\n")[0]! : `Subagent (${agent})`;
      entry = { id, agent, description, sessionFile, status: "running", startedAt: Date.now(), buffered: [] };
      this.#subagents.set(id, entry);
      entry.resolved = this.#resolveChild(entry);
    } else if (sessionFile && !entry.sessionFile) {
      entry.sessionFile = sessionFile;
    }
    const status = String((frame.type === "subagent_lifecycle" ? payload.status : progress?.status) ?? "");
    if ((status === "started" || status === "running") && entry.status !== "running") {
      // A finished subagent revived (P5 `resume { subagentId }`): its child session is busy again.
      entry.status = "running";
      entry.endedAt = undefined;
      if (entry.childSessionId) emitSessionStatus(entry.childSessionId, { type: "busy" }, this.cwd);
      return;
    }
    if (status === "completed" || status === "failed" || status === "error" || status === "aborted") {
      if (entry.status !== "running") return;
      const failure = record(payload.error)?.message ?? payload.error ?? progress?.error;
      this.#endChild(entry, status === "completed" ? "completed" : status === "aborted" ? "aborted" : "failed", typeof failure === "string" ? failure : undefined);
    }
  }

  /** The child's OpenCode id comes from its artifact transcript header, which omp writes shortly after `started`. */
  async #resolveChild(entry: SubagentEntry): Promise<void> {
    let ompId: string | undefined;
    for (let attempt = 0; attempt < 60 && !ompId && this.#state !== "closed"; attempt++) {
      if (entry.sessionFile) ompId = readSessionIdSync(entry.sessionFile);
      if (!ompId) await sleep(50);
    }
    if (this.#state === "closed") return;
    const childId = toOpenCodeSessionId(ompId ?? entry.id);
    entry.childSessionId = childId;
    const model = this.#translator.model;
    entry.translator = new TurnTranslator({ sessionId: childId, cwd: this.cwd, model, fullForm: true });
    emitSessionCreated({
      id: childId,
      slug: childId,
      projectID: "global",
      directory: this.cwd,
      path: entry.sessionFile ?? "",
      title: entry.id,
      parentID: this.sessionId,
      // OpenChamber knows only the `omp` agent: omp's own agent type ("task", …) here makes it drop the
      // session's model/effort for its own defaults. The type stays on the job and the description.
      agent: "omp",
      model: { id: model.modelID, providerID: model.providerID, modelID: model.modelID, variant: model.variant },
      version: "0.0.0",
      time: { created: entry.startedAt, updated: Date.now() },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }, this.cwd);
    emitSessionStatus(childId, { type: "busy" }, this.cwd);
    for (const event of entry.buffered.splice(0)) entry.translator.handle(event);
    if (entry.status !== "running") this.#publishChildEnd(entry);
  }

  #endChild(entry: SubagentEntry, status: Exclude<SubagentStatus, "running">, failure?: string): void {
    entry.status = status;
    entry.endedAt = Date.now();
    entry.failure = failure;
    if (entry.childSessionId) this.#publishChildEnd(entry);
  }

  #publishChildEnd(entry: SubagentEntry): void {
    const childId = entry.childSessionId!;
    if (entry.status === "failed") {
      entry.translator?.finishRun(entry.failure ?? "Subagent failed", "error");
      emitSessionError(childId, { message: entry.failure ?? "Subagent failed" }, this.cwd);
    } else {
      entry.translator?.finishRun(undefined, entry.status === "aborted" ? "aborted" : undefined);
    }
    emitSessionStatus(childId, { type: "idle" }, this.cwd);
    emitSessionIdle(childId, this.cwd);
    emitSessionUpdated({ id: childId, parentID: this.sessionId, time: { updated: Date.now() } }, this.cwd);
  }
}
