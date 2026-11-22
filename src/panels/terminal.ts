/**
 * OpenChamber integrated terminal (v3 binary-JSON WebSocket protocol plus the
 * HTTP command plane), backed by Bun's built-in PTY (`Bun.spawn({ terminal })`).
 *
 * Sessions are owned here, not by omp: they are the user's own shells, they
 * outlive page reloads, and they are reaped when idle and unattached.
 */
import { randomUUID } from "node:crypto";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { basename, resolve } from "node:path";
import { emitOpenCodeEvent } from "../shared/sse";
import { logger } from "../shared/logger";

type Json = Record<string, unknown>;

export interface TerminalRouteResult {
  status: number;
  data: unknown;
}

/** The slice of Bun's ServerWebSocket this module needs. */
export interface TerminalSocket {
  send(data: Uint8Array): number;
  close(): void;
  terminate?(): void;
  readonly readyState: number;
  getBufferedAmount?(): number;
}

const CONTROL_TAG_JSON = 0x01;
const CONTROL_TAG_GZIP_JSON = 0x02;
const GZIP_MIN_BYTES = 4 * 1024;
const MAX_INPUT_CHARS = 64 * 1024;
const MAX_SESSIONS = 20;
const MAX_HISTORY_CHARS = 512 * 1024;
const OUTPUT_BATCH_MS = 12;
const MAX_OUTPUT_BATCH_CHARS = 32_768;
const MAX_SOCKET_BUFFER_BYTES = 4 * 1024 * 1024;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const TERMINATION_GRACE_MS = 2_000;

const SHELL_IDS = ["bash", "zsh", "sh", "fish", "pwsh", "powershell", "dash", "ksh", "nu"] as const;
type ShellId = (typeof SHELL_IDS)[number];
const isShellId = (value: string): value is ShellId => (SHELL_IDS as readonly string[]).includes(value);

interface Purpose {
  type: "terminal" | "project-action";
  actionId?: string;
  executionId?: string;
}

interface Session {
  id: string;
  cwd: string;
  cols: number;
  rows: number;
  status: "running" | "exited";
  exitCode: number | null;
  signal: number | null;
  mode: "interactive" | "command";
  command: string | null;
  purpose: Purpose;
  shell: string;
  loginShell: boolean;
  proc: ReturnType<typeof Bun.spawn> | null;
  sequence: number;
  history: string;
  pendingOutput: { raw: string[]; replay: string[]; chars: number } | null;
  outputTimer: ReturnType<typeof setTimeout> | null;
  createdAt: number;
  lastActivity: number;
  themeMode: "light" | "dark";
  background?: string;
  foreground?: string;
  retired: boolean;
}

interface Attachment {
  initializing: boolean;
  pending: Json[];
}

interface Connection {
  socket: TerminalSocket;
  attachments: Map<string, Attachment>;
}

// ----------------------------------------------------------------- shells

function isExecutable(path: string | null | undefined): path is string {
  if (!path) return false;
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function shellIdOf(path: string): ShellId | null {
  const id = basename(path).toLowerCase();
  return isShellId(id) ? id : null;
}

function loginArgs(shell: string): string[] | null {
  const id = shellIdOf(shell);
  if (id === "bash" || id === "zsh" || id === "ksh") return ["-l"];
  if (id === "fish" || id === "nu") return ["--login"];
  if (id === "pwsh") return ["-Login"];
  return null;
}

function resolveShell(preference: string): { id: string; executable: string } {
  const id = preference.trim().toLowerCase();
  if (id === "auto") {
    for (const candidate of [process.env.OPENCHAMBER_TERMINAL_SHELL, process.env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"]) {
      const found = candidate ? (candidate.includes("/") ? candidate : Bun.which(candidate)) : null;
      if (isExecutable(found)) return { id: shellIdOf(found) ?? basename(found), executable: found };
    }
    throw new Error("No executable shell found");
  }
  const found = Bun.which(id);
  if (!isShellId(id) || !isExecutable(found)) throw new Error(`Terminal shell "${preference}" is not available`);
  return { id, executable: found };
}

function listShells(): Array<{ id: string; name: string; supportsLogin: boolean }> {
  const seen = new Map<string, string>();
  let configured: string[] = [];
  try {
    configured = readFileSync("/etc/shells", "utf8").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  } catch {
    /* no /etc/shells */
  }
  for (const entry of [...configured, ...SHELL_IDS.map((id) => Bun.which(id) ?? "")]) {
    const id = entry ? shellIdOf(entry) : null;
    if (id && !seen.has(id) && isExecutable(entry)) seen.set(id, entry);
  }
  const shells = [...seen].map(([id, executable]) => ({ id, name: id, supportsLogin: loginArgs(executable) !== null }));
  // "auto" resolves to the environment's shell; the picker lists it first.
  let autoSupportsLogin = false;
  try {
    autoSupportsLogin = loginArgs(resolveShell("auto").executable) !== null;
  } catch {
    /* no shell at all: list the rest */
  }
  return [{ id: "auto", name: "Auto", supportsLogin: autoSupportsLogin }, ...shells];
}

function launchArgs(executable: string, mode: "interactive" | "command", command: string | null, login: boolean): string[] {
  const id = shellIdOf(executable);
  const loginFlags = login ? loginArgs(executable) : [];
  if (!loginFlags) throw new Error(`Terminal shell "${id ?? executable}" does not support login mode`);
  if (mode === "interactive") return loginFlags;
  const text = (command ?? "").trim();
  if (!text) throw new Error("Terminal command is required");
  if (id === "nu") return [...loginFlags, "-c", text];
  if (id === "pwsh" || id === "powershell") return [...loginFlags, "-Command", text];
  return [...loginFlags, "-i", "-c", text];
}

// ------------------------------------------------------- terminal queries

function hexToOsc(color: string | undefined): string | null {
  const match = color && /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return null;
  const hex = match[1]!;
  const channel = (offset: number) => hex.slice(offset, offset + 2).repeat(2);
  return `rgb:${channel(0)}/${channel(2)}/${channel(4)}`;
}

// Queries a renderer would answer. The PTY answers them itself so a shell
// that asks during startup never waits on a client that has not attached yet.
const OSC_COLOR_QUERY = /\x1b\](10|11);\?(?:\x07|\x1b\\)/g;
const DA1_QUERY = /\x1b\[0?c/g;
const DSR_QUERY = /\x1b\[[56]n/g;

function answerQueries(session: Session, data: string): void {
  if (!session.proc?.terminal) return;
  let reply = "";
  for (const match of data.matchAll(OSC_COLOR_QUERY)) {
    const color = hexToOsc(match[1] === "11" ? session.background : session.foreground);
    if (color) reply += `\x1b]${match[1]};${color}\x1b\\`;
  }
  if (DA1_QUERY.test(data)) reply += "\x1b[?62;c";
  DA1_QUERY.lastIndex = 0;
  if (reply) {
    try {
      session.proc.terminal.write(reply);
    } catch {
      /* exited */
    }
  }
}

/** Replay history must not contain queries, or a re-attaching renderer would answer them again as typed input. */
function stripQueries(data: string): string {
  return data.replace(OSC_COLOR_QUERY, "").replace(DA1_QUERY, "").replace(DSR_QUERY, "");
}

// ---------------------------------------------------------------- runtime

const signalNumber = (signal: string | number | null | undefined): number | null =>
  typeof signal === "number" ? signal : signal ? ((osConstants.signals as Record<string, number>)[signal] ?? null) : null;

function frame(message: Json, gzip = false): Uint8Array {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  if (gzip && json.length >= GZIP_MIN_BYTES) {
    return Buffer.concat([Buffer.from([CONTROL_TAG_GZIP_JSON]), Bun.gzipSync(json)]);
  }
  return Buffer.concat([Buffer.from([CONTROL_TAG_JSON]), json]);
}

function readFrame(raw: unknown): Json | null {
  if (typeof raw === "string") return null;
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
  if (buffer.length < 2 || buffer[0] !== CONTROL_TAG_JSON) return null;
  try {
    const parsed = JSON.parse(buffer.subarray(1).toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Json) : null;
  } catch {
    return null;
  }
}

const validSize = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max;

function normalizePurpose(value: unknown): Purpose {
  if (value && typeof value === "object") {
    const purpose = value as Json;
    if (purpose.type === "project-action") {
      const ok = (entry: unknown): entry is string => typeof entry === "string" && entry.trim().length > 0 && entry.length <= 256;
      if (ok(purpose.actionId) && ok(purpose.executionId)) {
        return { type: "project-action", actionId: purpose.actionId, executionId: purpose.executionId };
      }
      throw new Error("Invalid terminal purpose");
    }
  }
  return { type: "terminal" };
}

class TerminalError extends Error {
  constructor(message: string, readonly status = 400, readonly code?: string) {
    super(message);
  }
}

export function createTerminalRuntime() {
  const sessions = new Map<string, Session>();
  const pendingCreates = new Map<string, Promise<Session>>();
  const connections = new Map<TerminalSocket, Connection>();
  let shuttingDown = false;

  const announce = () => emitOpenCodeEvent("openchamber:terminal-sessions-changed", {});

  const send = (socket: TerminalSocket, message: Json, gzip = false): boolean => {
    if (socket.readyState !== 1) return false;
    try {
      const bytes = frame(message, gzip);
      if ((socket.getBufferedAmount?.() ?? 0) + bytes.length > MAX_SOCKET_BUFFER_BYTES) {
        (socket.terminate ?? socket.close).call(socket);
        return false;
      }
      socket.send(bytes);
      return true;
    } catch {
      return false;
    }
  };

  const publish = (session: Session, event: Json): void => {
    session.sequence += 1;
    const message = { ...event, v: 3, s: session.id, q: session.sequence };
    for (const connection of connections.values()) {
      const attachment = connection.attachments.get(session.id);
      if (!attachment) continue;
      if (attachment.initializing) attachment.pending.push(message);
      else send(connection.socket, message);
    }
  };

  const flushOutput = (session: Session): void => {
    if (session.outputTimer) clearTimeout(session.outputTimer);
    session.outputTimer = null;
    const output = session.pendingOutput;
    if (!output) return;
    session.pendingOutput = null;
    const raw = output.raw.join("");
    const replay = output.replay.join("");
    publish(session, { t: "output", d: raw, ...(raw !== replay ? { r: replay } : {}) });
  };

  const discardOutput = (session: Session): void => {
    if (session.outputTimer) clearTimeout(session.outputTimer);
    session.outputTimer = null;
    session.pendingOutput = null;
  };

  const openOutputWindow = (session: Session): void => {
    session.outputTimer = setTimeout(() => {
      session.outputTimer = null;
      if (!session.pendingOutput) return;
      flushOutput(session);
      openOutputWindow(session);
    }, OUTPUT_BATCH_MS);
  };

  const onData = (session: Session, proc: Session["proc"], data: string): void => {
    if (session.retired || session.proc !== proc) return;
    answerQueries(session, data);
    const replay = stripQueries(data);
    session.history += replay;
    if (session.history.length > MAX_HISTORY_CHARS) session.history = session.history.slice(-MAX_HISTORY_CHARS);
    session.lastActivity = Date.now();
    const output = (session.pendingOutput ??= { raw: [], replay: [], chars: 0 });
    output.raw.push(data);
    output.replay.push(replay);
    output.chars += data.length;
    if (output.chars >= MAX_OUTPUT_BATCH_CHARS) flushOutput(session);
    else if (!session.outputTimer) {
      // Output after a quiet spell goes out at once so a keystroke echo never waits for the timer.
      flushOutput(session);
      openOutputWindow(session);
    }
  };

  const spawn = (session: Session, options: { shell: string; login: boolean }): void => {
    const { id, executable } = resolveShell(options.shell);
    const args = launchArgs(executable, session.mode, session.command, options.login);
    const env: Record<string, string | undefined> = {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      COLORFGBG: session.themeMode === "light" ? "0;15" : "15;0",
    };
    for (const name of ["NODE_CHANNEL_FD", "BASH_XTRACEFD", "BASH_ENV", "ENV", "ELECTRON_RUN_AS_NODE", "ARGV0"]) delete env[name];

    const decoder = new TextDecoder();
    let proc: Session["proc"] = null;
    proc = Bun.spawn([executable, ...args], {
      cwd: session.cwd,
      env,
      terminal: {
        cols: session.cols,
        rows: session.rows,
        data(_terminal, bytes) {
          const text = decoder.decode(bytes, { stream: true });
          if (text) onData(session, proc, text);
        },
      },
    });
    session.proc = proc;
    session.shell = id;
    session.loginShell = options.login;
    session.status = "running";
    session.exitCode = null;
    session.signal = null;
    const started = proc;
    void started.exited.then((code) => {
      if (session.retired || session.proc !== started) return;
      flushOutput(session);
      session.status = "exited";
      session.exitCode = typeof code === "number" ? code : null;
      session.signal = signalNumber(started.signalCode);
      session.proc = null;
      publish(session, { t: "exit", exitCode: session.exitCode, signal: session.signal });
      if (sessions.get(session.id) === session) announce();
    });
  };

  /** SIGTERM the whole job (the shell leads its own session), SIGKILL after a grace period. */
  const terminate = (proc: Session["proc"], force = false): Promise<void> => {
    if (!proc) return Promise.resolve();
    const send = (signal: NodeJS.Signals) => {
      try {
        process.kill(-proc.pid, signal);
      } catch {
        try {
          proc.kill(signal);
        } catch {
          /* gone */
        }
      }
    };
    if (force) {
      send("SIGKILL");
      return Promise.resolve();
    }
    send("SIGHUP");
    send("SIGTERM");
    return new Promise((done) => {
      const timer = setTimeout(() => {
        send("SIGKILL");
        done();
      }, TERMINATION_GRACE_MS);
      void proc.exited.then(() => {
        clearTimeout(timer);
        done();
      });
    });
  };

  const validateCwd = (cwd: unknown): string => {
    if (typeof cwd !== "string" || !cwd.trim()) throw new TerminalError("cwd is required");
    try {
      if (!statSync(cwd).isDirectory()) throw new TerminalError("Invalid working directory");
    } catch (error) {
      if (error instanceof TerminalError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      throw new TerminalError("Invalid working directory", 400, code === "ENOENT" || code === "ENOTDIR" ? "TERMINAL_CWD_MISSING" : undefined);
    }
    return cwd;
  };

  const applyAppearance = (session: Session, body: Json): void => {
    if (body.themeMode === "light" || body.themeMode === "dark") session.themeMode = body.themeMode;
    if (typeof body.terminalBackground === "string") session.background = body.terminalBackground;
    if (typeof body.terminalForeground === "string") session.foreground = body.terminalForeground;
  };

  const findRunningAction = (cwd: string, purpose: Purpose): Session | null => {
    if (purpose.type !== "project-action") return null;
    for (const session of sessions.values()) {
      if (session.status === "running" && resolve(session.cwd) === cwd && session.purpose.type === "project-action" && session.purpose.actionId === purpose.actionId) {
        return session;
      }
    }
    return null;
  };

  const create = async (body: Json): Promise<Session> => {
    if (shuttingDown) throw new TerminalError("Terminal runtime is shutting down", 503);
    const cols = body.cols ?? 80;
    const rows = body.rows ?? 24;
    if (!validSize(cols, 1000) || !validSize(rows, 500)) throw new TerminalError("Invalid terminal dimensions");
    const login = body.loginShell ?? false;
    if (typeof login !== "boolean") throw new TerminalError("Invalid terminal login mode");
    const shellPreference = typeof body.shell === "string" ? body.shell : "auto";
    if (shellPreference.trim().toLowerCase() !== "auto" && !isShellId(shellPreference.trim().toLowerCase())) throw new TerminalError("Invalid terminal shell");
    const mode: "interactive" | "command" = body.mode === "command" || (body.mode === undefined && typeof body.command === "string") ? "command" : "interactive";
    const command = mode === "command" ? (typeof body.command === "string" ? body.command.trim() : "") : null;
    if (mode === "command" && (!command || command.length > MAX_INPUT_CHARS)) throw new TerminalError("Terminal command is required");
    let purpose: Purpose;
    try {
      purpose = normalizePurpose(body.purpose);
    } catch (error) {
      throw new TerminalError((error as Error).message);
    }
    const id = typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : randomUUID();
    if (id.length > 128) throw new TerminalError("Invalid terminal session id");
    const cwd = validateCwd(body.cwd);
    const resolvedCwd = resolve(cwd);

    const existing = sessions.get(id);
    if (existing?.status === "running") {
      if (resolve(existing.cwd) !== resolvedCwd) throw new TerminalError("Terminal session belongs to a different working directory");
      if (existing.purpose.type !== purpose.type) throw new TerminalError("Terminal session is already running with a different purpose");
      if (existing.mode !== mode || existing.command !== command) throw new TerminalError("Terminal session is already running with a different mode or command");
      applyAppearance(existing, body);
      return existing;
    }
    const running = findRunningAction(resolvedCwd, purpose);
    if (running) {
      applyAppearance(running, body);
      return running;
    }
    const pending = pendingCreates.get(id);
    if (pending) return pending;
    if (!existing && sessions.size + pendingCreates.size >= MAX_SESSIONS) throw new TerminalError("Maximum terminal sessions reached", 429);

    const creation = (async () => {
      const session: Session = existing ?? {
        id, cwd, cols, rows, status: "running", exitCode: null, signal: null, mode, command, purpose,
        shell: "auto", loginShell: login, proc: null, sequence: 0, history: "", pendingOutput: null, outputTimer: null,
        createdAt: Date.now(), lastActivity: Date.now(), themeMode: "dark", retired: false,
      };
      Object.assign(session, { cwd, cols, rows, mode, command, purpose, history: "", retired: false, lastActivity: Date.now() });
      discardOutput(session);
      applyAppearance(session, body);
      try {
        spawn(session, { shell: shellPreference, login });
      } catch (error) {
        throw new TerminalError(error instanceof Error ? error.message : "Failed to start terminal");
      }
      sessions.set(id, session);
      // A finished project action is replaced by its next execution.
      if (purpose.type === "project-action") {
        for (const [otherId, other] of sessions) {
          if (otherId !== id && other.status === "exited" && resolve(other.cwd) === resolvedCwd && other.purpose.type === "project-action" && other.purpose.actionId === purpose.actionId) {
            other.retired = true;
            sessions.delete(otherId);
            closeAttachments(otherId, "REPLACED", "Terminal was replaced");
          }
        }
      }
      announce();
      return session;
    })();
    pendingCreates.set(id, creation);
    try {
      return await creation;
    } finally {
      if (pendingCreates.get(id) === creation) pendingCreates.delete(id);
    }
  };

  const closeAttachments = (sessionId: string, code: string, message: string): void => {
    for (const connection of connections.values()) {
      if (!connection.attachments.delete(sessionId)) continue;
      send(connection.socket, { t: "error", v: 3, s: sessionId, code, message, fatal: true });
    }
  };

  const remove = async (session: Session, force = false): Promise<void> => {
    sessions.delete(session.id);
    announce();
    flushOutput(session);
    session.retired = true;
    closeAttachments(session.id, force ? "KILLED" : "CLOSED", force ? "Terminal was killed" : "Terminal closed");
    const proc = session.proc;
    session.proc = null;
    await terminate(proc, force);
  };

  const describe = (session: Session): Json => ({
    sessionId: session.id,
    cols: session.cols,
    rows: session.rows,
    status: session.status,
    mode: session.mode,
    purpose: session.purpose,
  });

  const snapshot = (session: Session): Json => ({
    t: "snapshot", v: 3, s: session.id, q: session.sequence, history: session.history,
    cols: session.cols, rows: session.rows, status: session.status, exitCode: session.exitCode, signal: session.signal,
    mode: session.mode, purpose: session.purpose, runtime: "bun", ptyBackend: "bun-terminal",
  });

  // ------------------------------------------------------------- websocket

  const idleSweep = setInterval(() => {
    const now = Date.now();
    for (const session of [...sessions.values()]) {
      const attached = [...connections.values()].some((connection) => connection.attachments.has(session.id));
      if (!attached && now - session.lastActivity > IDLE_TIMEOUT_MS) {
        sessions.delete(session.id);
        session.retired = true;
        discardOutput(session);
        closeAttachments(session.id, "IDLE_TIMEOUT", "Terminal expired after being idle");
        void terminate(session.proc, true);
        session.proc = null;
        announce();
      }
    }
  }, 5 * 60 * 1000);
  idleSweep.unref();

  const ws = {
    open(socket: TerminalSocket): void {
      connections.set(socket, { socket, attachments: new Map() });
      send(socket, { t: "hello", v: 3 });
    },
    message(socket: TerminalSocket, raw: unknown): void {
      const connection = connections.get(socket);
      if (!connection) return;
      if (typeof raw === "string") {
        send(socket, { t: "error", v: 3, code: "BAD_FRAME", message: "Binary control frame required", fatal: false });
        return;
      }
      const message = readFrame(raw);
      if (!message || message.v !== 3 || typeof message.t !== "string") {
        send(socket, { t: "error", v: 3, code: "BAD_FRAME", message: "Invalid terminal frame", fatal: false });
        return;
      }
      if (message.t === "ping") return void send(socket, { t: "pong", v: 3 });
      if (message.t === "hello") return;
      const id = typeof message.s === "string" ? message.s : "";
      if (!id) return void send(socket, { t: "error", v: 3, code: "BAD_FRAME", message: "Session id required", fatal: false });
      if (message.t === "detach") {
        connection.attachments.delete(id);
        return;
      }
      const session = sessions.get(id);
      if (!session) return void send(socket, { t: "error", v: 3, s: id, code: "SESSION_NOT_FOUND", message: "Terminal session not found", fatal: true });
      if (message.t === "attach") {
        // Register before snapshotting so concurrent output is buffered, then dropped if the snapshot already covers it.
        const attachment: Attachment = { initializing: true, pending: [] };
        connection.attachments.set(id, attachment);
        flushOutput(session);
        const initial = snapshot(session);
        send(socket, initial, message.z === 1);
        for (const event of attachment.pending) if ((event.q as number) > (initial.q as number)) send(socket, event);
        attachment.pending.length = 0;
        attachment.initializing = false;
        return;
      }
      if (message.t === "write") {
        if (typeof message.d !== "string" || !message.d || message.d.length > MAX_INPUT_CHARS) {
          return void send(socket, { t: "error", v: 3, s: id, code: "BAD_INPUT", message: "Invalid terminal input", fatal: false });
        }
        if (session.status !== "running" || !session.proc?.terminal) {
          return void send(socket, { t: "error", v: 3, s: id, code: "NOT_RUNNING", message: "Terminal is not running", fatal: false });
        }
        try {
          session.proc.terminal.write(message.d);
          session.lastActivity = Date.now();
        } catch {
          send(socket, { t: "error", v: 3, s: id, code: "WRITE_FAILED", message: "Failed to write to terminal", fatal: false });
        }
      }
    },
    close(socket: TerminalSocket): void {
      connections.delete(socket);
    },
  };

  // ------------------------------------------------------------------ http

  const fail = (error: unknown, fallback: string): TerminalRouteResult => {
    if (error instanceof TerminalError) {
      return { status: error.status, data: { error: error.message, ...(error.code ? { code: error.code } : {}) } };
    }
    return { status: 400, data: { error: error instanceof Error ? error.message : fallback } };
  };

  async function handleHttp(req: Request, url: URL, path: string): Promise<TerminalRouteResult | null> {
    if (path !== "/api/terminal" && !path.startsWith("/api/terminal/")) return null;
    const body = async (): Promise<Json> => {
      try {
        const parsed = (await req.json()) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Json) : {};
      } catch {
        return {};
      }
    };

    if (path === "/api/terminal/shells" && req.method === "GET") return { status: 200, data: listShells() };

    if (path === "/api/terminal/sessions" && req.method === "GET") {
      const rawCwd = url.searchParams.get("cwd")?.trim();
      const filter = rawCwd ? resolve(rawCwd) : null;
      const list = [...sessions.values()]
        .filter((session) => !filter || resolve(session.cwd) === filter)
        .map((session) => ({
          sessionId: session.id, cwd: session.cwd, status: session.status, createdAt: session.createdAt, mode: session.mode, purpose: session.purpose,
        }));
      return { status: 200, data: { sessions: list } };
    }

    if (path === "/api/terminal/touch" && req.method === "POST") {
      const ids = (await body()).sessionIds;
      const now = Date.now();
      let touched = 0;
      for (const id of Array.isArray(ids) ? ids : []) {
        const session = typeof id === "string" ? sessions.get(id) : undefined;
        if (session) {
          session.lastActivity = now;
          touched += 1;
        }
      }
      return { status: 200, data: { touched } };
    }

    if (path === "/api/terminal/create" && req.method === "POST") {
      try {
        return { status: 200, data: describe(await create(await body())) };
      } catch (error) {
        return fail(error, "Failed to create terminal session");
      }
    }

    if (path === "/api/terminal/force-kill" && req.method === "POST") {
      const { sessionId, cwd } = await body();
      const killed: string[] = [];
      for (const [id, session] of [...sessions]) {
        if (typeof sessionId === "string" ? id !== sessionId : typeof cwd === "string" && session.cwd !== cwd) continue;
        killed.push(id);
        void remove(session, true);
      }
      return { status: 200, data: { success: true, killedCount: killed.length, killedSessionIds: killed } };
    }

    const match = /^\/api\/terminal\/([^/]+)(?:\/(resize|appearance|restart))?$/.exec(path);
    if (!match) return null;
    const id = decodeURIComponent(match[1]!);
    const action = match[2];
    const session = sessions.get(id);

    if (!action && req.method === "DELETE") {
      if (!session) {
        const pending = pendingCreates.get(id);
        if (!pending) return { status: 404, data: { error: "Terminal session not found" } };
        await pending.then((created) => remove(created), () => undefined);
        return { status: 200, data: { success: true } };
      }
      await remove(session);
      return { status: 200, data: { success: true } };
    }
    if (!action || req.method !== "POST") return null;
    if (!session) return { status: 404, data: { error: "Terminal session not found" } };
    const payload = await body();

    if (action === "resize") {
      const { cols, rows } = payload;
      if (!validSize(cols, 1000) || !validSize(rows, 500)) return { status: 400, data: { error: "Invalid terminal dimensions" } };
      try {
        if (session.status === "running") session.proc?.terminal?.resize(cols, rows);
        session.cols = cols;
        session.rows = rows;
        return { status: 200, data: { success: true, cols, rows } };
      } catch (error) {
        return { status: 500, data: { error: error instanceof Error ? error.message : "Failed to resize terminal" } };
      }
    }

    if (action === "appearance") {
      applyAppearance(session, payload);
      return { status: 200, data: { success: true } };
    }

    // restart
    if (session.mode === "command") return { status: 400, data: { error: "Command-mode terminal sessions cannot be restarted" } };
    try {
      const cwd = validateCwd(payload.cwd ?? session.cwd);
      const cols = payload.cols ?? session.cols;
      const rows = payload.rows ?? session.rows;
      if (!validSize(cols, 1000) || !validSize(rows, 500)) throw new TerminalError("Invalid terminal dimensions");
      const login = payload.loginShell ?? false;
      if (typeof login !== "boolean") throw new TerminalError("Invalid terminal login mode");
      const previous = session.proc;
      flushOutput(session);
      Object.assign(session, { cwd, cols, rows, history: "" });
      applyAppearance(session, payload);
      session.proc = null; // the old child's exit must not publish an `exit` for the replacement
      spawn(session, { shell: typeof payload.shell === "string" ? payload.shell : "auto", login });
      void terminate(previous);
      publish(session, { t: "restarted", history: "" });
      announce();
      return { status: 200, data: { sessionId: session.id, cols, rows, status: session.status } };
    } catch (error) {
      return fail(error, "Failed to restart terminal");
    }
  }

  async function shutdown(): Promise<void> {
    shuttingDown = true;
    clearInterval(idleSweep);
    const running = [...sessions.values()];
    sessions.clear();
    for (const session of running) {
      session.retired = true;
      discardOutput(session);
    }
    for (const connection of connections.values()) connection.socket.close();
    connections.clear();
    await Promise.allSettled(running.map((session) => terminate(session.proc)));
    if (running.length > 0) logger.info(`[terminal] closed ${running.length} session(s)`);
  }

  return { handleHttp, ws, shutdown };
}

export type TerminalRuntime = ReturnType<typeof createTerminalRuntime>;
export const TERMINAL_WS_PATH = "/api/terminal/ws";
