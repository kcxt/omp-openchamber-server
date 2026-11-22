/**
 * The fixed-width title slot omp keeps on a transcript's first line (written
 * only when the sidecar creates a session file; omp owns every later change),
 * and the low-signal filter shared with omp's own title rule.
 */

export const SESSION_TITLE_SLOT_BYTES = 256;
export const SESSION_TITLE_SLOT_ENTRY_TYPE = "title";

export type SessionTitleSource = "auto" | "user";

export interface SessionTitleUpdate {
  title?: string;
  source?: SessionTitleSource;
  updatedAt?: string;
}

export interface SessionTitleSlotEntry {
  type: typeof SESSION_TITLE_SLOT_ENTRY_TYPE;
  v: 1;
  title: string;
  source?: SessionTitleSource;
  updatedAt: string;
  pad: string;
}

const utf8Encoder = new TextEncoder();

function byteLength(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}

function titleSlotLine(
  title: string,
  source: SessionTitleSource | undefined,
  updatedAt: string,
  pad: string,
): string {
  const slot: SessionTitleSlotEntry = source
    ? { type: SESSION_TITLE_SLOT_ENTRY_TYPE, v: 1, title, source, updatedAt, pad }
    : { type: SESSION_TITLE_SLOT_ENTRY_TYPE, v: 1, title, updatedAt, pad };
  return `${JSON.stringify(slot)}\n`;
}

function truncateTitleForSlot(
  title: string,
  source: SessionTitleSource | undefined,
  updatedAt: string,
): string {
  const codePoints = [...title];
  let low = 0;
  let high = codePoints.length;
  let best = "";

  while (low <= high) {
    const mid = (low + high) >>> 1;
    const candidate = codePoints.slice(0, mid).join("");
    if (byteLength(titleSlotLine(candidate, source, updatedAt, "")) <= SESSION_TITLE_SLOT_BYTES) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return best;
}

/** Serialize the fixed-width first-line title slot, exactly 256 UTF-8 bytes including newline. */
export function serializeTitleSlot(options: SessionTitleUpdate): string {
  const updatedAt = options.updatedAt || new Date().toISOString();
  const title = truncateTitleForSlot(options.title ?? "", options.source, updatedAt);
  const unpadded = titleSlotLine(title, options.source, updatedAt, "");
  const padBytes = SESSION_TITLE_SLOT_BYTES - byteLength(unpadded);
  if (padBytes < 0) throw new Error("Session title slot metadata exceeds fixed slot size");
  const line = titleSlotLine(title, options.source, updatedAt, " ".repeat(padBytes));
  if (byteLength(line) !== SESSION_TITLE_SLOT_BYTES) {
    throw new Error("Session title slot serialization failed to produce fixed-width output");
  }
  return line;
}

/** Greeting / filler tokens matching OMP CLI filter. */
export const FILLER_TITLE_TOKENS = new Set<string>([
  "hi", "hii", "hiii", "hiya", "hey", "heya", "hello", "helo", "hullo",
  "yo", "ya", "sup", "wassup", "whatsup", "howdy", "greetings", "hola",
  "ciao", "aloha", "gm", "gn", "good", "morning", "afternoon", "evening",
  "night", "day", "thanks", "thank", "thx", "ty", "tysm", "cheers",
  "please", "pls", "plz", "ok", "okay", "okey", "k", "kk", "yep", "yes",
  "yeah", "yup", "nope", "no", "nah", "sure", "cool", "nice", "great",
  "awesome", "perfect", "lol", "lmao", "haha", "hehe", "test", "tests",
  "testing", "ping", "pong", "there", "you", "u", "hmm", "hmmm", "um",
  "uh", "so", "well", "anyway",
]);

export const TITLE_WORD = /[\p{L}\p{N}]+/gu;

/** Check if input is low-signal (greetings, acks, numbers, pure punctuation). */
export function isLowSignalTitleInput(message: string): boolean {
  const tokens = message.toLowerCase().match(TITLE_WORD);
  if (!tokens || tokens.length === 0) return true;
  return tokens.every((token) => FILLER_TITLE_TOKENS.has(token) || /^\d+$/.test(token));
}
