/**
 * Chronologically sortable message ids.
 *
 * OpenChamber orders messages by lexicographic id comparison: the server-side
 * goal token accounting advances an `lastAccountedMessageID` cursor with
 * `id <= cursor` / `id > cursor`, and the revert/compaction tail filters make
 * the same assumption. That only works when ids sort in creation order, which
 * OpenChamber's own `ascendingId` guarantees (`msg_<12hex><base62>`, the hex
 * encoding `Date.now()*0x1000 + counter`).
 *
 * omp message ids are random 8-hex, so any id the sidecar derives from one is
 * unorderable and the goal cursor stalls mid-session (the reported "stuck at
 * ~800k" symptom). Every id the sidecar mints therefore leads with the same
 * 12-hex time-sortable token OpenChamber uses, so sidecar ids interleave with
 * OpenChamber's and sort chronologically.
 */

const ID_RANDOM_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ID_RANDOM_LENGTH = 14;
const HEX_TIME_LENGTH = 12;

let lastMintTimestamp = 0;
let mintCounter = 0;

function randomBase62(length: number): string {
  const bytes = new Uint8Array(length);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = "";
  for (let i = 0; i < length; i++) out += ID_RANDOM_CHARS[bytes[i] % ID_RANDOM_CHARS.length];
  return out;
}

function hexFromSortable(sortable: bigint): string {
  const bytes = new Uint8Array(6);
  for (let i = 0; i < 6; i++) bytes[i] = Number((sortable >> BigInt(40 - 8 * i)) & BigInt(0xff));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A fresh, strictly increasing 12-hex token for ids minted once and then
 * persisted (live user-message ids). Mirrors OpenChamber's `ascendingId`
 * encoding so the ids sort on the same scale.
 */
export function timeSortableHex(timestamp = Date.now()): string {
  if (timestamp !== lastMintTimestamp) {
    lastMintTimestamp = timestamp;
    mintCounter = 0;
  }
  mintCounter += 1;
  return hexFromSortable(BigInt(Math.max(0, Math.floor(timestamp))) * BigInt(0x1000) + BigInt(mintCounter));
}

/**
 * A deterministic 12-hex token derived only from a timestamp. Used for ids the
 * transcript mapper re-derives on every reload: it must be byte-identical
 * across reloads (no live counter) or OpenChamber would see id churn and
 * duplicate the message. Ties within the same millisecond are broken by the
 * stable omp id appended after the token.
 */
export function timeHexFromTimestamp(timestamp: number): string {
  const ms = Number.isFinite(timestamp) ? Math.max(0, Math.floor(timestamp)) : 0;
  return hexFromSortable(BigInt(ms) * BigInt(0x1000));
}

/**
 * The leading 12-hex time token embedded in a message id (`msg_<12hex>…`),
 * or `undefined` for ids minted before this scheme (e.g. `msg_ses_…_…`).
 */
export function timeHexOfMessageId(id: string | undefined): string | undefined {
  if (typeof id !== "string") return undefined;
  const match = /^msg_([0-9a-f]{12})/.exec(id);
  return match ? match[1] : undefined;
}

/** Mint a random suffix for freshly created ids. */
export function randomIdSuffix(): string {
  return randomBase62(ID_RANDOM_LENGTH);
}

export const MESSAGE_HEX_TIME_LENGTH = HEX_TIME_LENGTH;
