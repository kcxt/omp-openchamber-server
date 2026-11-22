// Pure reduction of what the sidecar publishes onto the OpenCode routes guests
// may read (`GET /api/session/:id` and `/message`) into the panel's view model.
// The sidecar writes `metadata.omp.context` per assistant message and
// `metadata.openchamber.context` per session (src/omp/context.ts).
// Messages are OpenCode v2 messages: `{ type, id, time: { created }, metadata, ... }`.

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** Context points, oldest first. */
export const pointsOf = (messages) => {
  const points = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const context = message?.metadata?.omp?.context;
    if (context && num(context.used) !== undefined && num(context.at) !== undefined) points.push(context);
  }
  return points.sort((a, b) => a.at - b.at);
};

/** Compactions in the history, with the size before and after the last one. */
export const compactionsOf = (messages) => {
  const list = (Array.isArray(messages) ? messages : []).filter((m) => m?.type === 'compaction');
  const last = list.at(-1);
  return {
    count: list.length,
    ...(last ? { lastAt: num(last.time?.created), tokensBefore: num(last.tokens?.input), tokensAfter: num(last.tokens?.output) } : {}),
  };
};

/**
 * `session` is the `/api/session/:id` record. Its `metadata.openchamber.context` is
 * the sidecar's own headline; the points give the curve and carry the window.
 */
export const summarize = (session, messages) => {
  const points = pointsOf(messages);
  const last = points.at(-1);
  const published = session?.metadata?.openchamber?.context;
  const used = num(published?.used) ?? num(last?.used);
  const window = num(published?.window) ?? num(last?.window);
  return {
    current: used === undefined ? null : {
      used,
      window,
      percent: window ? Math.min(100, (used / window) * 100) : undefined,
      nonMessage: num(published?.nonMessage) ?? num(last?.nonMessage),
    },
    history: points.map((p) => ({ at: p.at, used: p.used, window: num(p.window), epoch: num(p.compactionEpoch) })),
    cache: {
      read: points.reduce((sum, p) => sum + (num(p.cacheRead) ?? 0), 0),
      write: points.reduce((sum, p) => sum + (num(p.cacheWrite) ?? 0), 0),
      lastRead: num(last?.cacheRead) ?? 0,
      lastWrite: num(last?.cacheWrite) ?? 0,
    },
    compactions: compactionsOf(messages),
  };
};
