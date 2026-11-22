/** Session-scoped route helpers: lookup, the "open elsewhere" refusal, staged-revert commit. */
import { backendForSession } from "../providers/registry";
import { commitRevert } from "../sessions/service";
import { sessionOwnedElsewhere } from "../sessions/status";
import { emitOpenCodeV2Event } from "../shared/sse";

/**
 * Resolves the owning backend + session for a session-scoped route. Falls
 * back to a directory-less store lookup to survive cwd key differences.
 */
export async function resolveSessionRoute(openCodeId: string, dir: string | undefined) {
  const backend = backendForSession(openCodeId);
  const session = (await backend.store.get(openCodeId, dir)) || (await backend.store.get(openCodeId));
  return { backend, session };
}

/**
 * A session a terminal omp has open must not be prompted from here: omp would
 * silently fork it. OpenChamber cannot ask for confirmation mid-send, so refuse
 * with a message that says what to do.
 */
export async function refuseIfOpenElsewhere(
  sessionID: string,
  session: NonNullable<Awaited<ReturnType<typeof resolveSessionRoute>>["session"]>,
): Promise<string | null> {
  if ((await sessionOwnedElsewhere(sessionID, session.directory, session.path)) === false) return null;
  return (
    "This session is open in another omp. Close that omp window and send again, or use \"Fork from here\" to continue in a copy."
  );
}

export type RevertCommitResult = "none" | "committed";

/**
 * Accepts the session's staged revert. The transcript already holds it (staging
 * navigated omp's leaf and journaled it), so only the marker goes. OpenChamber
 * stages a revert and then simply prompts (it never calls the commit route when
 * the user edits a message), so every prompt route runs this first.
 */
export async function commitStagedRevert(
  sessionID: string,
  session: NonNullable<Awaited<ReturnType<typeof resolveSessionRoute>>["session"]>,
): Promise<RevertCommitResult> {
  const target = session.revert?.messageID;
  if (!target || !(await commitRevert(session))) return "none";
  emitOpenCodeV2Event("session.revert.committed", { sessionID, to: target }, session.directory);
  const updated = await backendForSession(sessionID).store.get(sessionID, session.directory);
  if (updated) {
    emitOpenCodeV2Event("session.usage.updated", { sessionID, cost: updated.cost, tokens: updated.tokens }, session.directory);
  }
  return "committed";
}
