/** Response helpers shared by every route module. */

export function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  if (origin) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "authorization, content-type, x-opencode-directory, accept, *",
    };
  }
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type, x-opencode-directory, accept, *",
  };
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function numberOr(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export interface Responders {
  json(data: unknown, init?: ResponseInit): Response;
  jsonError(message: string, status: number): Response;
  noContent(): Response;
  /** The last JSON body produced for this request, kept for the access log. */
  lastBody(): unknown;
}

/** Responders bound to one request's CORS headers. */
export function createResponders(cors: Record<string, string>): Responders {
  let body: unknown;
  const json = (data: unknown, init?: ResponseInit): Response => {
    body = data;
    return Response.json(data, { ...init, headers: { ...cors, ...(init?.headers ?? {}) } });
  };
  return {
    json,
    jsonError: (message, status) => json({ error: message }, { status }),
    noContent: () => new Response(null, { status: 204, headers: cors }),
    lastBody: () => body,
  };
}
