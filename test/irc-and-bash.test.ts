import { describe, expect, test } from "bun:test";
import { ircMessageCard, parentIrcCard } from "../src/omp/irc";
import { ircPeer, normalizeToolInput, splitBashFailure } from "../src/shared/tool-normalize";
import { openCodeToolName } from "../src/omp/todo";
import { mapRpcMessagesToOpenCodeRecords, type AgentMessage } from "../src/omp/messages";

describe("a failed bash command", () => {
  test("the exit notice becomes the error and the output stays the result", () => {
    expect(splitBashFailure("a\nb\n\nCommand exited with code 2")).toEqual({ output: "a\nb", error: "Exit code 2" });
    expect(splitBashFailure("Command exited with code 127")).toEqual({ output: "", error: "Exit code 127" });
  });
  test("a timeout, an abort or a notice mid-output is left alone", () => {
    expect(splitBashFailure("out\n\n[Command aborted]")).toBeUndefined();
    expect(splitBashFailure("Command exited with code 1\nmore output")).toBeUndefined();
  });
});

describe("messages between agents", () => {
  test("a write to agent://<id> is an irc card carrying the body; a file write is not", () => {
    expect(ircPeer("agent://HttpSplit")).toEqual({ to: "HttpSplit", progress: false });
    expect(ircPeer("agent://HttpSplit?progress")).toEqual({ to: "HttpSplit", progress: true });
    expect(ircPeer("src/a.ts")).toBeNull();

    const input = normalizeToolInput("write", { path: "agent://Reviewer?progress", content: "half way" })!;
    expect(input).toMatchObject({ ircTo: "Reviewer", content: "half way", description: "→ Reviewer (progress)" });
    expect(openCodeToolName("write", input)).toBe("irc");
    expect(openCodeToolName("write", normalizeToolInput("write", { path: "a.txt", content: "x" }))).toBe("write");
  });

  test("a received message shows the sender's words, not the model-facing envelope", () => {
    const card = ircMessageCard({ customType: "irc:incoming", details: { id: "m1", from: "Lead", message: "ship it" } }, 5)!;
    expect(card.state).toMatchObject({ status: "completed", input: { description: "← Lead" }, output: "ship it" });
    expect(ircMessageCard({ customType: "irc:incoming", display: false, details: { from: "Lead", message: "x" } }, 5)).toBeUndefined();
    expect(ircMessageCard({ customType: "host-resume", details: { message: "x" } }, 5)).toBeUndefined();
    expect(parentIrcCard({ from: "Main", body: "status?" }, 7)?.state.output).toBe("status?");
  });

  test("history shows both as cards in the turn they arrived in, never as user messages", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "go" }], hostMessageId: "msg_u1", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "working" }], stopReason: "stop", timestamp: 2 },
      { role: "custom", customType: "irc:incoming", display: true, details: { id: "m1", from: "Lead", message: "ship it" }, timestamp: 3 },
      { role: "user", content: "<irc>envelope</irc>", parentIrc: { from: "Main", body: "status?" }, attribution: "agent", steering: true, timestamp: 4 },
    ] as unknown as AgentMessage[];
    const records = mapRpcMessagesToOpenCodeRecords(messages, "ses_x");
    expect(records.map((r) => r.info.role)).toEqual(["user", "assistant"]);
    const cards = records[1]!.parts.filter((p) => p.type === "tool" && p.tool === "irc");
    expect(cards.map((p) => (p as { state: { output?: string } }).state.output)).toEqual(["ship it", "status?"]);
  });
});
