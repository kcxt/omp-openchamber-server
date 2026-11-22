/** Goal objective files and todo lists. */
import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { readSessionTodos } from "../providers/omp/todo";
import { nextSessionTodosRevision } from "../shared/sse";
import type { RouteContext } from "../http/router";
import { readJson } from "../http/response";
import { resolveSessionRoute } from "../services/session-route";

export async function handleGoals(ctx: RouteContext): Promise<Response | undefined> {
  const { req, p, dir, json, jsonError } = ctx;
  // Session todos page state (OpenChamber /api/session-todos/:id). The
  // client accepts either `off` (no todo feature for this session) or
  // `ready` with the item list, plus a revision it uses to drop stale reads.
  const sessionTodosMatch = p.match(/^\/session-todos\/([^/]+)$/);
  if (sessionTodosMatch && req.method === "GET") {
    try {
      const { backend, session } = await resolveSessionRoute(decodeURIComponent(sessionTodosMatch[1]!), dir);
      if (!session) return jsonError("session not found", 404);
      const revision = nextSessionTodosRevision();
      if (!backend.capabilities.todo) return json({ revision, state: "off" });
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
    const sessionId = decodeURIComponent(goalObjMatch[1]);
    const home = Bun.env.HOME || process.env.HOME || "/tmp";
    const ocDataDir = Bun.env.OPENCHAMBER_DATA_DIR || process.env.OPENCHAMBER_DATA_DIR;
    const ocGoalsDir = ocDataDir ? join(ocDataDir, "goals") : join(home, ".config", "openchamber", "goals");
    const ompGoalsDir = join(home, ".omp", "goals");

    const ocGoalPath = join(ocGoalsDir, `${sessionId}.md`);
    const ompGoalPath = join(ompGoalsDir, `${sessionId}.txt`);

    if (req.method === "PUT") {
      try {
        await mkdir(ocGoalsDir, { recursive: true });
        await mkdir(ompGoalsDir, { recursive: true });
        const body = (await readJson(req)) as { content?: string } | undefined;
        const text = body?.content ?? "";
        await Bun.write(ocGoalPath, text);
        await Bun.write(ompGoalPath, text);
        return json({ ok: true });
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "failed to write objective", 500);
      }
    }

    if (req.method === "GET") {
      try {
        const ocFile = Bun.file(ocGoalPath);
        if (await ocFile.exists()) {
          const content = await ocFile.text();
          return json({ content });
        }
        const ompFile = Bun.file(ompGoalPath);
        if (await ompFile.exists()) {
          const content = await ompFile.text();
          return json({ content });
        }
        return jsonError("objective not found", 404);
      } catch {
        return jsonError("objective not found", 404);
      }
    }

    if (req.method === "DELETE") {
      try {
        await unlink(ocGoalPath).catch(() => {});
        await unlink(ompGoalPath).catch(() => {});
      } catch {
        // ignore
      }
      return json({ ok: true });
    }
  }

  // Session todos
  const todoMatch = p.match(/^\/session\/([^/]+)\/todo$/);
  if (todoMatch && req.method === "GET") {
    try {
      const { backend, session } = await resolveSessionRoute(todoMatch[1], dir);
      if (!session) return jsonError("session not found", 404);
      if (!backend.capabilities.todo) return json([]);
      const todos = await readSessionTodos(session.path);
      return json(todos);
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "todo failed", 500);
    }
  }

  return undefined;
}
