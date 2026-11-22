// A scripted, local OpenAI-compatible chat-completions server (streaming). It is the only model
// endpoint a contract-test omp may talk to (PLAN.md §8): provider `fake`, apiKey `dummy`.
//
// The script format is the stub omp's (test/stub-omp/omp), so one scenario drives both binaries:
//   {"turns":[{"when":"<substring of the last user message>","steps":[...]}]}
// Steps: {"text"} {"thinking"} {"sleep":ms} {"hang":true} {"tool":"bash","args":{...}}.
// Steps are grouped into one assistant message each: content steps, then the tool calls they
// make; the next group is the model's reply after the tool results. The group served is the
// number of assistant messages after the last user message, so the server keeps no state.
// With no matching turn the reply is `Echo: <last user text>`.

export interface ScriptStep {
  text?: string;
  thinking?: string;
  sleep?: number;
  hang?: boolean;
  tool?: string;
  args?: Record<string, unknown>;
  /** Stub only: the scripted tool result text. */
  result?: string;
  /** Stub only: the script of a `task` call's subagent. */
  subagent?: { steps: ScriptStep[] };
  /** Stub only: how long a background `bash` job runs before it wakes the session. */
  asyncMs?: number;
  /** Stub only: the agent completes the active goal at this step (the real omp needs a `goal` tool call: `{tool:"goal", args:{op:"complete"}}`). */
  goalComplete?: boolean;
}
export interface ScriptTurn {
  when?: string;
  steps: ScriptStep[];
}
export interface Script {
  turns: ScriptTurn[];
}

export interface RecordedRequest {
  model: string;
  messages: Array<Record<string, any>>;
  tools: string[];
}

export function groupSteps(steps: ScriptStep[]): Array<{ content: ScriptStep[]; tools: ScriptStep[] }> {
  const groups: Array<{ content: ScriptStep[]; tools: ScriptStep[] }> = [];
  let cur = { content: [] as ScriptStep[], tools: [] as ScriptStep[] };
  for (const step of steps) {
    if (step.tool) cur.tools.push(step);
    else {
      if (cur.tools.length) {
        groups.push(cur);
        cur = { content: [], tools: [] };
      }
      cur.content.push(step);
    }
  }
  if (cur.content.length || cur.tools.length) groups.push(cur);
  return groups;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
  return "";
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class FakeProvider {
  readonly requests: RecordedRequest[] = [];
  script: Script = { turns: [] };
  /** Pause between streamed chunks, ms. */
  tick = 4;
  #server: ReturnType<typeof Bun.serve> | undefined;

  get port(): number {
    return this.#server!.port!;
  }
  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  start(): this {
    this.#server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 120,
      fetch: (req) => this.#handle(req),
    });
    return this;
  }

  stop(): void {
    void this.#server?.stop(true);
  }

  async #handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname.endsWith("/models")) {
      return Response.json({ object: "list", data: [{ id: "scripted", object: "model" }] });
    }
    if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
    const body = (await req.json()) as { model: string; messages: Array<Record<string, any>>; tools?: Array<{ function?: { name?: string } }> };
    this.requests.push({ model: body.model, messages: body.messages, tools: (body.tools ?? []).map((t) => t.function?.name ?? "") });

    let lastUser = -1;
    body.messages.forEach((m, i) => { if (m.role === "user") lastUser = i; });
    const prompt = lastUser >= 0 ? textOf(body.messages[lastUser]!.content) : "";
    const groupIndex = body.messages.slice(lastUser + 1).filter((m) => m.role === "assistant").length;
    const turn = this.script.turns.find((t) => !t.when || prompt.includes(t.when));
    const steps: ScriptStep[] = turn?.steps ?? [{ text: `Echo: ${prompt}` }];
    const group = groupSteps(steps)[groupIndex] ?? { content: [{ text: "ok" }], tools: [] };
    return this.#stream(req, body.model, group);
  }

  #stream(req: Request, model: string, group: { content: ScriptStep[]; tools: ScriptStep[] }): Response {
    const enc = new TextEncoder();
    const id = `chatcmpl-${crypto.randomUUID().slice(0, 8)}`;
    const tick = this.tick;
    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const aborted = () => req.signal.aborted;
        const send = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) => {
          if (aborted()) return;
          const chunk = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra };
          controller.enqueue(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        };
        try {
          send({ role: "assistant", content: "" });
          for (const step of group.content) {
            if (aborted()) break;
            if (step.sleep) { await sleep(step.sleep); continue; }
            if (step.hang) {
              while (!aborted()) await sleep(50);
              break;
            }
            const field = step.thinking !== undefined ? "reasoning_content" : "content";
            const full = String(step.thinking ?? step.text ?? "");
            for (const piece of full.match(/[\s\S]{1,6}/g) ?? []) {
              if (aborted()) break;
              send({ [field]: piece });
              await sleep(tick);
            }
          }
          group.tools.forEach((step, index) => {
            send({ tool_calls: [{ index, id: `call_${crypto.randomUUID().slice(0, 8)}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.args ?? {}) } }] });
          });
          if (!aborted()) {
            send({}, group.tools.length ? "tool_calls" : "stop", { usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
            controller.enqueue(enc.encode("data: [DONE]\n\n"));
          }
        } finally {
          try { controller.close(); } catch { /* client went away */ }
        }
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  }
}
