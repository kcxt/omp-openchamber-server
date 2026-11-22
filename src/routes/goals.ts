/** Todo lists and omp's goal. */
import { readSessionTodos } from "../omp/todo";
import { readTranscriptGoal } from "../omp/goal";
import { Registry } from "../sessions/registry";
import { nextSessionTodosRevision } from "../shared/sse";
import type { RouteContext } from "../http/router";
import { resolveSessionRoute } from "../services/session-route";

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

  // omp's goal for the Oh-My-Pi extension: the live child's state, else what the transcript last journalled.
  const ompGoalMatch = p.match(/^\/omp\/goal\/([^/]+)$/);
  if (ompGoalMatch && req.method === "GET") {
    try {
      const sessionId = decodeURIComponent(ompGoalMatch[1]!);
      const { session } = await resolveSessionRoute(sessionId, dir);
      if (!session) return jsonError("session not found", 404);
      const runtime = Registry.get(session.id, session.directory);
      // A completed goal leaves omp's state; its record stays in the transcript.
      const goal = (runtime && await runtime.getGoal()) ?? await readTranscriptGoal(runtime?.transcriptPath ?? session.path);
      return json({ sessionId: session.id, live: runtime !== undefined, goal });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "goal lookup failed", 500);
    }
  }
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
