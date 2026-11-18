import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createOpenCodeEventStream, subscribeOpenCodeEvents, type OpenCodeEvent } from "../../shared/sse";
import { createEventHandler } from "./prompt";
import { toV2Message } from "./v2";
import { isTodoTool, normalizeOmpTodoStatus, extractTodosFromOmpDetails } from "../../providers/omp/todo";
import { mapRpcMessagesToOpenCodeRecords, type AgentMessage } from "../../providers/omp/messages";
import type { OmpRpcEvent } from "../../providers/omp/rpc";
import { createOmpTurnConnection } from "../../providers/omp/backend";

/** Minimal OmpRpcTransport that lets tests feed raw events through the omp normalizer. */
class FeedingTransport {
  #handler: ((e: OmpRpcEvent) => void) | undefined;
  request(_method: string, _params?: unknown): Promise<unknown> {
    return Promise.resolve();
  }
  switchSession(): Promise<unknown> {
    return Promise.resolve();
  }
  onEvent(handler: (e: OmpRpcEvent) => void): () => void {
    this.#handler = handler;
    return () => {
      this.#handler = undefined;
    };
  }
  kill(): void {}
  feed(event: OmpRpcEvent): void {
    this.#handler?.(event);
  }
}

function wireHandler(onComplete: () => void): FeedingTransport {
  const transport = new FeedingTransport();
  const conn = createOmpTurnConnection(transport, { openCodeId: SES_ID, cwd: CWD });
  conn.onEvent(createEventHandler(SES_ID, undefined, MODEL, onComplete, CWD));
  return transport;
}

const SES_ID = "ses_todo_test_session_12345";
const CWD = "/tmp/test-repo";
const MODEL = { providerID: "omp", modelID: "default", variant: "default" };

describe("todo parsing and normalization utilities", () => {
  it("correctly identifies todo tools", () => {
    expect(isTodoTool("todo")).toBe(true);
    expect(isTodoTool("TODO")).toBe(true);
    expect(isTodoTool("todowrite")).toBe(true);
    expect(isTodoTool("todoread")).toBe(true);
    expect(isTodoTool("todos")).toBe(true);
    expect(isTodoTool("bash")).toBe(false);
    expect(isTodoTool("read")).toBe(false);
    expect(isTodoTool(undefined)).toBe(false);
  });

  it("normalizes OMP task statuses to OpenCode status vocabulary", () => {
    expect(normalizeOmpTodoStatus("in_progress")).toBe("in_progress");
    expect(normalizeOmpTodoStatus("inprogress")).toBe("in_progress");
    expect(normalizeOmpTodoStatus("running")).toBe("in_progress");
    expect(normalizeOmpTodoStatus("active")).toBe("in_progress");

    expect(normalizeOmpTodoStatus("completed")).toBe("completed");
    expect(normalizeOmpTodoStatus("complete")).toBe("completed");
    expect(normalizeOmpTodoStatus("done")).toBe("completed");

    expect(normalizeOmpTodoStatus("abandoned")).toBe("cancelled");
    expect(normalizeOmpTodoStatus("cancelled")).toBe("cancelled");
    expect(normalizeOmpTodoStatus("canceled")).toBe("cancelled");
    expect(normalizeOmpTodoStatus("dropped")).toBe("cancelled");

    expect(normalizeOmpTodoStatus("pending")).toBe("pending");
    expect(normalizeOmpTodoStatus("blocked")).toBe("pending");
    expect(normalizeOmpTodoStatus("todo")).toBe("pending");
    expect(normalizeOmpTodoStatus(undefined)).toBe("pending");
  });

  it("extracts and flattens tasks from details.phases", () => {
    const rawDetails = {
      op: "init",
      phases: [
        {
          name: "Build",
          tasks: [
            { id: "task-1", content: "Write Three.js scene", status: "in_progress" },
            { id: "task-2", content: "Syntax check", status: "pending" },
          ],
        },
        {
          name: "Verify",
          tasks: [
            { content: "Smoke test in browser", status: "blocked", priority: "high" },
            { content: "Drop deprecated code", status: "abandoned" },
          ],
        },
      ],
    };

    const todos = extractTodosFromOmpDetails(rawDetails);
    expect(todos).toBeDefined();
    expect(todos).toHaveLength(4);

    expect(todos![0]).toEqual({
      id: "task-1",
      content: "Write Three.js scene",
      status: "in_progress",
      priority: "normal",
    });
    expect(todos![1]).toEqual({
      id: "task-2",
      content: "Syntax check",
      status: "pending",
      priority: "normal",
    });
    expect(todos![2]).toEqual({
      id: "todo_1_0",
      content: "Smoke test in browser",
      status: "pending",
      priority: "high",
    });
    expect(todos![3]).toEqual({
      id: "todo_1_1",
      content: "Drop deprecated code",
      status: "cancelled",
      priority: "normal",
    });
  });

  it("extracts tasks from direct array result", () => {
    const rawResult = [
      { id: "t1", content: "Step 1", status: "completed" },
      { id: "t2", content: "Step 2", status: "in_progress" },
    ];
    const todos = extractTodosFromOmpDetails(undefined, rawResult);
    expect(todos).toBeDefined();
    expect(todos).toHaveLength(2);
    expect(todos![0].status).toBe("completed");
    expect(todos![1].status).toBe("in_progress");
  });
});

describe("todo.updated SSE event emission during live turns", () => {
  let events: OpenCodeEvent[] = [];
  let unsub: (() => void) | null = null;

  beforeEach(() => {
    events = [];
    unsub = subscribeOpenCodeEvents((e) => events.push(e));
  });

  afterEach(() => {
    unsub?.();
    unsub = null;
  });

  it("emits todo.updated when todo tool execution ends with phases details", () => {
    const transport = wireHandler(() => {});

    const phases = [
      {
        name: "Build",
        tasks: [
          { id: "task_1", content: "Write HTML", status: "in_progress" },
          { id: "task_2", content: "Check JS", status: "pending" },
        ],
      },
    ];

    // Tool execution start
    transport.feed({
      type: "tool_execution_start",
      payload: {
        toolCallId: "call_todo_1",
        tool: "todo",
      },
    } as unknown as OmpRpcEvent);

    // Tool execution end with phases details
    transport.feed({
      type: "tool_execution_end",
      payload: {
        toolCallId: "call_todo_1",
        tool: "todo",
        details: { phases },
      },
    } as unknown as OmpRpcEvent);

    const todoEvents = events.filter((e) => e.type === "todo.updated");
    expect(todoEvents).toHaveLength(1);
    expect(todoEvents[0].directory).toBe(CWD);

    const props = todoEvents[0].properties as { sessionID: string; todos: any[] };
    expect(props.sessionID).toBe(SES_ID);
    expect(props.todos).toHaveLength(2);
    expect(props.todos[0]).toEqual({
      id: "task_1",
      content: "Write HTML",
      status: "in_progress",
      priority: "normal",
    });
    expect(props.todos[1]).toEqual({
      id: "task_2",
      content: "Check JS",
      status: "pending",
      priority: "normal",
    });
  });

  it("emits todo.updated when nested message_update toolcall completes", () => {
    const transport = wireHandler(() => {});

    const phases = [
      {
        name: "Verify",
        tasks: [
          { id: "task_3", content: "Browser smoke test", status: "completed" },
        ],
      },
    ];

    transport.feed({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        toolCallId: "call_todo_2",
        tool: "todo",
        details: { phases },
      },
    } as unknown as OmpRpcEvent);

    const todoEvents = events.filter((e) => e.type === "todo.updated");
    expect(todoEvents).toHaveLength(1);
    const props = todoEvents[0].properties as { sessionID: string; todos: any[] };
    expect(props.sessionID).toBe(SES_ID);
    expect(props.todos[0].status).toBe("completed");
  });

  it("does not emit todo.updated for non-todo tools like bash or read", () => {
    const transport = wireHandler(() => {});

    transport.feed({
      type: "tool_execution_start",
      payload: {
        toolCallId: "call_bash_1",
        tool: "bash",
      },
    } as unknown as OmpRpcEvent);

    transport.feed({
      type: "tool_execution_end",
      payload: {
        toolCallId: "call_bash_1",
        tool: "bash",
        output: "done",
      },
    } as unknown as OmpRpcEvent);

    const todoEvents = events.filter((e) => e.type === "todo.updated");
    expect(todoEvents).toHaveLength(0);
  });
});

describe("omp's todo tool as OpenChamber's todo panel", () => {
  const phases = [
    {
      name: "Build",
      tasks: [
        { id: "task_1", content: "Write HTML", status: "in_progress" },
        { id: "task_2", content: "Check JS", status: "pending" },
      ],
    },
  ];
  const todoList = [
    { id: "task_1", content: "Write HTML", status: "in_progress", priority: "normal" },
    { id: "task_2", content: "Check JS", status: "pending", priority: "normal" },
  ];

  /** OpenChamber's own gate: a completed `todowrite` content item carrying `input.todos`. */
  const matchesOpenChamberTodoCall = (item: Record<string, any>) =>
    item?.type === "tool"
    && item?.name === "todowrite"
    && item?.state?.status === "completed"
    && Array.isArray(item?.state?.input?.todos);

  it("names every live todo part todowrite and carries the produced list on it", () => {
    const events: OpenCodeEvent[] = [];
    const unsub = subscribeOpenCodeEvents((e) => events.push(e));
    const transport = wireHandler(() => {});

    transport.feed({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_start",
        toolCallId: "call_present",
        tool: "todo",
        arguments: { op: "init", list: [{ phase: "Build", items: ["Write HTML", "Check JS"] }] },
      },
    } as unknown as OmpRpcEvent);
    transport.feed({
      type: "tool_execution_start",
      payload: { toolCallId: "call_present", tool: "todo" },
    } as unknown as OmpRpcEvent);
    transport.feed({
      type: "tool_execution_end",
      payload: { toolCallId: "call_present", tool: "todo", output: "2 tasks", details: { op: "init", phases } },
    } as unknown as OmpRpcEvent);
    unsub();

    const toolParts = events
      .filter((e) => e.type === "message.part.updated")
      .map((e) => (e.properties as { part?: Record<string, any> }).part)
      .filter((part) => part?.type === "tool");
    expect(toolParts.length).toBeGreaterThanOrEqual(3);
    expect(toolParts.every((part) => part.tool === "todowrite")).toBe(true);

    const completed = toolParts.at(-1)!;
    expect(completed.state.status).toBe("completed");
    expect(completed.state.input.op).toBe("init");
    expect(completed.state.input.todos).toEqual(todoList);
    expect(completed.state.metadata.todos).toEqual(todoList);
  });

  it("streams todowrite through OpenChamber's wire events, list included", async () => {
    const stream = createOpenCodeEventStream(CWD, { isOpenChamber: true });
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const transport = wireHandler(() => {});

    transport.feed({
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_start", toolCallId: "call_wire", tool: "todo", arguments: { op: "view" } },
    } as unknown as OmpRpcEvent);
    transport.feed({
      type: "tool_execution_start",
      payload: { toolCallId: "call_wire", tool: "todo" },
    } as unknown as OmpRpcEvent);
    transport.feed({
      type: "tool_execution_end",
      payload: { toolCallId: "call_wire", tool: "todo", output: "2 tasks", details: { op: "view", phases } },
    } as unknown as OmpRpcEvent);

    const frames: Array<Record<string, any>> = [];
    for (let i = 0; i < 20 && !frames.some((f) => f.type === "session.tool.success"); i++) {
      const chunk = await reader.read();
      if (chunk.done) break;
      for (const frame of decoder.decode(chunk.value).split("\n\n")) {
        if (frame.startsWith("data: ")) frames.push(JSON.parse(frame.slice(6)));
      }
    }
    await reader.cancel();

    const started = frames.find((f) => f.type === "session.tool.input.started");
    const called = frames.find((f) => f.type === "session.tool.called");
    const success = frames.find((f) => f.type === "session.tool.success");
    expect(started?.data?.name).toBe("todowrite");
    expect(called?.data?.name).toBe("todowrite");
    expect(success?.data?.name).toBe("todowrite");
    expect(success?.data?.metadata?.todos).toEqual(todoList);
    expect(success?.location?.directory).toBe(CWD);
  });

  it("serves the transcript's todo call as a completed todowrite item OpenChamber can read", () => {
    const rawMessages: AgentMessage[] = [
      { id: "u1", role: "user", content: "track this work" },
      {
        id: "a1",
        role: "assistant",
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        content: [
          {
            type: "toolCall",
            id: "call_page",
            name: "todo",
            arguments: { op: "init", list: [{ phase: "Build", items: ["Write HTML", "Check JS"] }] },
          },
        ],
      },
      {
        id: "t1",
        role: "toolResult",
        toolCallId: "call_page",
        toolName: "todo",
        content: "2 tasks in 1 phase",
        details: { op: "init", phases },
        isError: false,
      },
    ];

    const records = mapRpcMessagesToOpenCodeRecords(rawMessages, "ses_todo_page_test");
    const assistant = records.find((record) => record.info.role === "assistant");
    expect(assistant).toBeDefined();
    const part = assistant!.parts.find((candidate): candidate is Extract<typeof candidate, { type: "tool" }> => candidate.type === "tool");
    expect(part?.state.status).toBe("completed");
    // omp's own op input stays intact; the list the call produced rides with it.
    expect((part?.state.input as Record<string, unknown>).op).toBe("init");
    expect((part?.state.input as Record<string, unknown>).todos).toEqual(todoList);

    const wire = toV2Message(assistant!) as { content?: Array<Record<string, any>> };
    const item = wire.content?.find((entry) => entry.type === "tool");
    expect(item).toBeDefined();
    expect(matchesOpenChamberTodoCall(item!)).toBe(true);
    expect(item!.state.input.todos).toEqual(todoList);
  });
});
