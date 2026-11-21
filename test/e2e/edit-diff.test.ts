import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { editToolMetadata } from "../../src/shared/edit-diff";
import { startStack, type Stack } from "./stack";

// omp's diff: context/removed lines carry the old line number, added lines the new one,
// blank lines separate hunks.
const OMP_DIFF = [
  " 59|            if clock != 0 {",
  " 60|                if i == 0 {",
  "",
  " 71|                }",
  "-72|            } else if d[3] == 0xfc {",
  "+72|            } else if d[3] == 0xfc && label.name_len == 0 {",
  "+73|                // first name only",
  " 73|                for &c in &d[5..18] {",
  "-74|                    if c == b'\\n' {",
  "+75|                    if c == b'\\n' || full {",
  " 75|                        break;",
  "",
  " 90|    done",
].join("\n");

describe("editToolMetadata", () => {
  test("converts omp's numbered diff to unified hunks with correct old/new starts", () => {
    const meta = editToolMetadata({ path: "src/a.rs", op: "update", diff: OMP_DIFF })!;
    const patch = meta.diff as string;
    expect(patch.split("\n").slice(0, 2)).toEqual(["--- a/src/a.rs", "+++ b/src/a.rs"]);
    expect(patch).toContain("@@ -59,2 +59,2 @@");
    expect(patch).toContain("@@ -71,5 +71,6 @@");
    expect(patch).toContain("@@ -90,1 +91,1 @@");
    expect(patch).toContain("+            } else if d[3] == 0xfc && label.name_len == 0 {");
    expect((meta.files as any[])[0].filePath).toBe("src/a.rs");
  });

  test("a batch yields one file entry per path and no combined diff", () => {
    const meta = editToolMetadata({ perFileResults: [
      { path: "a.txt", op: "update", diff: "-1|x\n+1|y" },
      { path: "b.txt", op: "create", diff: "+1|z" },
    ] })!;
    expect((meta.files as any[]).map((f) => f.filePath)).toEqual(["a.txt", "b.txt"]);
    expect(meta.diff).toBeUndefined();
    expect((meta.files as any[])[1].patch).toContain("--- /dev/null");
  });

  test("replace-mode input without a result diff still yields a patch", () => {
    const meta = editToolMetadata(undefined, { path: "a.txt", old_text: "foo\n", new_text: "bar\nbaz\n" })!;
    expect(meta.diff).toContain("@@ -1,1 +1,2 @@");
    expect(meta.diff).toContain("-foo\n+bar\n+baz");
  });

  test("nothing to show without a diff or old/new text", () => {
    expect(editToolMetadata({ path: "a.txt" }, { input: "@a.txt\n..." })).toBeUndefined();
  });
});

let stack: Stack;
beforeAll(async () => { stack = await startStack(); });
afterAll(() => stack.stop());

describe("an edit tool call reaches OpenChamber with a diff", () => {
  test("hashline-style call: metadata comes from the result's details", async () => {
    stack.script([{ when: "edit it", steps: [
      { tool: "edit", args: { input: "@a.txt\n+1|y" }, result: "[a.txt#ABCD]\n1:y",
        details: { path: "a.txt", op: "update", diff: "-1|x\n+1|y", firstChangedLine: 1 } },
      { text: "Edited." },
    ] }]);
    const dir = `directory=${encodeURIComponent(stack.project)}`;
    const id = (await stack.http(`/session?${dir}`, { json: {} })).body.data.id;
    expect((await stack.http(`/session/${id}/prompt_async?${dir}`, { json: { parts: [{ type: "text", text: "edit it" }] } })).status).toBeLessThan(300);
    let tool: any;
    for (let i = 0; i < 100 && !tool?.state?.metadata; i++) {
      await Bun.sleep(200);
      const blocks = ((await stack.http(`/session/${id}/message?${dir}`)).body.data as any[]).flatMap((m) => m.content ?? []);
      tool = blocks.find((c) => c.type === "tool" && c.name === "edit" && c.state?.status === "completed");
    }
    expect(tool.state.metadata.files[0].patch).toContain("@@ -1,1 +1,1 @@\n-x\n+y");
  });
});
