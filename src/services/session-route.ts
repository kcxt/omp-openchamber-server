/** Session-scoped route helpers: lookup, the "open elsewhere" refusal, staged-revert commit. */
import { backendForSession } from "../providers/registry";
import { discardSession } from "../sessions/service";
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

export type RevertCommitResult = "none" | "committed" | "cleared" | "boundary-missing";

/**
 * Applies the session's staged revert: the boundary message and everything
 * after it leave the transcript, and the omp child, which still holds them in
 * memory, is dropped so the next turn reloads the cut transcript. OpenChamber
 * stages a revert and then simply prompts (it never calls the commit route when
 * the user edits a message), so every prompt route runs this first.
 */
export async function commitStagedRevert(
  sessionID: string,
  backend: ReturnType<typeof backendForSession>,
  session: NonNullable<Awaited<ReturnType<typeof resolveSessionRoute>>["session"]>,
): Promise<RevertCommitResult> {
  const target = session.revert?.messageID;
  if (!target) return "none";
  discardSession(sessionID, session.directory);
  const committed = await backend.store.commitRevert(sessionID, target, session.directory);
  if (!committed) {
    // A staged revert whose boundary message is no longer in the transcript can
    // never be committed, and the client commits it before every new prompt
    // (goals included), so it would wedge the session. Nothing is left to
    // truncate: drop the stale marker instead.
    const transcript = await backend.store.transcript?.(sessionID, session.directory).catch(() => null);
    if (!transcript || transcript.some((message) => message.info.id === target)) return "boundary-missing";
    await backend.store.update(sessionID, { revert: null }, session.directory);
    emitOpenCodeV2Event("session.revert.cleared", { sessionID }, session.directory);
    return "cleared";
  }
  emitOpenCodeV2Event("session.revert.committed", { sessionID, to: target }, session.directory);
  const updated = await backend.store.get(sessionID, session.directory);
  if (updated) {
    emitOpenCodeV2Event("session.usage.updated", { sessionID, cost: updated.cost, tokens: updated.tokens }, session.directory);
  }
  return "committed";
}
