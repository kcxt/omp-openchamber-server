/** Git panel delegate and the per-session working-tree diff. */
import { handleGitRequest } from "../panels/git";
import type { RouteContext } from "../http/router";
import { resolveSessionRoute } from "../services/session-route";

export async function handleGit(ctx: RouteContext): Promise<Response | undefined> {
  const { req, url, p, dir, effectiveDir, json, jsonError } = ctx;
  const gitResponse = await handleGitRequest(req, url, effectiveDir);
  if (gitResponse) {
    return json(gitResponse.data, {
      status: gitResponse.status,
      headers: gitResponse.headers,
    });
  }

  const sessionDiffMatch = p.match(/^\/session\/([^/]+)\/diff$/);
  if (sessionDiffMatch && req.method === "GET") {
    const sessionID = decodeURIComponent(sessionDiffMatch[1]!);
    const { session } = await resolveSessionRoute(sessionID, dir);
    if (!session) return jsonError("session not found", 404);
    const rawContext = Number.parseInt(url.searchParams.get("context") ?? "3", 10);
    const context = Number.isFinite(rawContext) ? Math.max(0, Math.min(20, rawContext)) : 3;
    try {
      const proc = Bun.spawn(["git", "-C", session.directory, "diff", "--no-ext-diff", "--no-color", `--unified=${context}`, "HEAD", "--"], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const patch = await new Response(proc.stdout).text();
      await proc.exited;
      const diffs = patch.split(/^diff --git /m).slice(1).map((chunk) => {
        const fullPatch = `diff --git ${chunk}`;
        const header = fullPatch.slice(0, fullPatch.indexOf("\n"));
        const headerMatch = header.match(/^diff --git a\/(.+) b\/(.+)$/);
        const deleted = fullPatch.includes("deleted file mode ");
        const added = fullPatch.includes("new file mode ");
        const file = headerMatch?.[2] ?? headerMatch?.[1] ?? header.replace(/^diff --git /, "");
        return {
          file,
          patch: fullPatch,
          additions: fullPatch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++" )).length,
          deletions: fullPatch.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---" )).length,
          status: added ? "added" as const : deleted ? "deleted" as const : "modified" as const,
        };
      });
      return json({ data: diffs });
    } catch {
      return json({ data: [] });
    }
  }

  return undefined;
}
