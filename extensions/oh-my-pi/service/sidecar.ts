// Finding the omp sidecar. The host's `opencode` role (read-only, `provides: ["opencode"]`) reaches only the
// listed OpenCode reads, none of the sidecar's /api/omp routes, and hides the server's address. But it does
// reach `GET /api/session/:id`, whichever server this OpenChamber is connected to, and the sidecar publishes its
// own address there as `metadata.omp.sidecarUrl`. The service asks that, then calls the sidecar directly.

export type SidecarReason = 'bad-request' | 'no-session' | 'unreachable' | 'session-not-found' | 'not-omp' | 'failed';

export type SidecarLookup = { ok: true; url: string } | { ok: false; reason: SidecarReason };

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

export async function locateSidecar(sessionId: string): Promise<SidecarLookup> {
  const base = process.env.OPENCHAMBER_OPENCODE_URL;
  const token = process.env.OPENCHAMBER_SERVICE_TOKEN;
  // No fallback: another server would not be the one this OpenChamber uses.
  if (!base || !token) return { ok: false, reason: 'unreachable' };

  let response: Response;
  try {
    response = await fetch(`${base}/api/session/${encodeURIComponent(sessionId)}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
  if (response.status === 404) return { ok: false, reason: 'session-not-found' };
  if (!response.ok) return { ok: false, reason: 'failed' };

  const body = asRecord(await response.json().catch(() => null));
  // OpenCode v2 wraps the session as `{ data }`.
  const session = asRecord(body?.data) ?? body;
  const url = asRecord(asRecord(session?.metadata)?.omp)?.sidecarUrl;
  if (typeof url !== 'string' || !url.startsWith('http://')) return { ok: false, reason: 'not-omp' };
  return { ok: true, url };
}
