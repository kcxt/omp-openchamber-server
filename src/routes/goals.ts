/** Goal objective files and todo lists. */
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { goalObjectivePath } from "../adapters/openchamber/goal";
import { readSessionTodos } from "../omp/todo";
import { nextSessionTodosRevision } from "../shared/sse";
import type { RouteContext } from "../http/router";
import { readJson } from "../http/response";
import { resolveSessionRoute } from "../services/session-route";

// OpenChamber's own objective-file semantics (server/lib/session-goal/objectives.js):
// one `<session id>.md` under its data dir, trimmed and clamped, invalid ids rejected.
const OBJECTIVE_CHAR_LIMIT = 5_000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{4,128}$/;

const clamp = (content: unknown): string => String(content ?? "").trim().slice(0, OBJECTIVE_CHAR_LIMIT);

export async function handleGoals(ctx: RouteContext): Promise<Response | undefined> {
  const { req, p, dir, json, jsonError } = ctx;
  // Session todos page state (OpenChamber /api/session-todos/:id). The
  // client accepts either `off` (no todo feature for this session) or
  // `ready` with the item list, plus a revision it uses to drop stale reads.
  const sessionTodosMatch = p.match(/^\/session-todos\/([^/]+)$/);
  if (sessionTodosMatch && req.method === "GET") {
    try {
      const { session } = await resolveSessionRoute(decodeURIComponent(sessionTodosMatch[1]!), dir);
      if (!session) return jsonError("session not found", 404);
      const revision = nextSessionTodosRevision();
      const todos = await readSessionTodos(session.path);
      return json({
        revision,
        state: "ready",
        todos: todos.map((todo) => ({ content: todo.content, status: todo.status })),
      });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "session todos failed", 500);
    }
  }

  // Goal objective endpoints
  const goalObjMatch = p.match(/^\/(?:api\/)?goals\/objective\/([^/]+)$/);
  if (goalObjMatch) {
    const sessionId = decodeURIComponent(goalObjMatch[1]!);
    const valid = SESSION_ID_PATTERN.test(sessionId);
    const file = valid ? goalObjectivePath(sessionId) : "";

    if (req.method === "PUT") {
      if (!valid) return jsonError("invalid session id", 400);
      const body = (await readJson(req).catch(() => undefined)) as { content?: unknown } | undefined;
      const text = clamp(body?.content);
      if (!text) return jsonError("objective content is required", 400);
      try {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, text, "utf8");
        return json({ ok: true });
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "failed to write objective", 500);
      }
    }

    if (req.method === "GET") {
      if (!valid) return jsonError("objective not found", 404);
      try {
        return json({ content: clamp(await readFile(file, "utf8")) });
      } catch {
        return jsonError("objective not found", 404);
      }
    }

    if (req.method === "DELETE") {
      if (valid) await unlink(file).catch(() => undefined);
      return json({ ok: true });
    }
  }

  // Session todos
  const todoMatch = p.match(/^\/session\/([^/]+)\/todo$/);
  if (todoMatch && req.method === "GET") {
    try {
      const { session } = await resolveSessionRoute(todoMatch[1]!, dir);
      if (!session) return jsonError("session not found", 404);
      const todos = await readSessionTodos(session.path);
      return json(todos);
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "todo failed", 500);
    }
  }

  return undefined;
}
