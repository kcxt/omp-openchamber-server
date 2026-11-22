/**
 * OpenChamber's own "Session goal" is not served: omp's goal mode is, through
 * the `/goal` command. Should OpenChamber's goal loop run anyway (the feature
 * re-enabled in its settings), its progress check would spend a small-model
 * call per idle; the sidecar answers it without a model instead.
 */

/**
 * Whether `prompt` is OpenChamber's goal progress check
 * (server/lib/session-goal/audit.js `buildSmallModelAuditPrompt`).
 */
export function isGoalAuditPrompt(prompt: string): boolean {
  return prompt.startsWith("You check the progress of an AI coding agent. Answer three yes/no questions");
}

/** The check's answer: waiting for the user, so OpenChamber's loop parks its goal as blocked and sends nothing. */
export const GOAL_AUDIT_REPLY = JSON.stringify({ all_done: false, remaining: false, needs_user: true });
