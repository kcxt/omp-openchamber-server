/**
 * OpenChamber "Add device" pairing: remote client records, one-time pairing
 * sessions, and the `/api/client-auth/*` routes, with the response shapes the
 * OpenChamber UI and mobile app parse.
 *
 * Tokens are minted, listed, revoked and redeemed here, but the sidecar does
 * NOT enforce them on other routes: it has no auth layer, and local
 * OpenChamber instances reach it without a token. Treat the listen address
 * (loopback or tailnet) as the access control.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";

type Json = Record<string, unknown>;

export interface ClientAuthRouteResult {
  status: number;
  data: unknown;
  headers?: Record<string, string>;
}

interface ClientRecord {
  id: string;
  label: string;
  tokenHash: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
  clientKind: string | null;
  dedupeKey: string | null;
  authMethod: string | null;
  pairingId: string | null;
  deviceName: string | null;
  devicePlatform: string | null;
  deviceModel: string | null;
  appVersion: string | null;
}

interface PairingSession {
  id: string;
  secretHash: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  cancelledAt: string | null;
  clientId: string | null;
  label: string | null;
  fingerprint: string;
  allowedClientKinds: string[];
}

const TOKEN_PREFIX = "oc_client_";
const MAX_LABEL = 80;
const PAIRING_TTL_MS = 10 * 60 * 1000;
const CLIENT_KINDS = ["mobile", "desktop"];
const REDEEM_ERROR = "Invalid or expired pairing session";
const REDEEM_WINDOW_MS = 10 * 60 * 1000;
const REDEEM_MAX_ATTEMPTS = 10;

const optString = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const nowIso = (): string => new Date().toISOString();

function safeEqualHex(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

const label = (value: unknown, fallback = "Remote client"): string => {
  const text = optString(value) ?? fallback;
  return text.length > MAX_LABEL ? text.slice(0, MAX_LABEL) : text;
};

function publicClient(client: ClientRecord): Json {
  const { tokenHash: _tokenHash, dedupeKey: _dedupeKey, ...rest } = client;
  return { ...rest, usesRelay: false, lastTransport: null };
}

function publicSession(session: PairingSession): Json {
  const { secretHash: _secretHash, ...rest } = session;
  return { ...rest, label: session.label ?? "Pair new device", createdByClientId: null, usesRelay: false };
}

const isPending = (session: PairingSession): boolean =>
  !session.usedAt && !session.cancelledAt && Date.parse(session.expiresAt) > Date.now();

function normalizeUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]" || host === "0.0.0.0";
  } catch {
    return true;
  }
}

const urlType = (url: string): "tunnel" | "lan" => (url.startsWith("https:") ? "tunnel" : "lan");

/** Serializes read-modify-write cycles on one JSON file and writes atomically. */
class JsonStore<T extends Json> {
  #queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string, private readonly empty: () => T) {}

  async #read(): Promise<T> {
    try {
      return { ...this.empty(), ...(JSON.parse(await readFile(this.path, "utf8")) as T) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.empty();
      throw error;
    }
  }

  /** Runs `fn` on the current state; its changes are persisted unless it throws. */
  update<R>(fn: (state: T) => R | Promise<R>): Promise<R> {
    const run = this.#queue.then(async () => {
      const state = await this.#read();
      const result = await fn(state);
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temp = `${this.path}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
      await rename(temp, this.path);
      return result;
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  read(): Promise<T> {
    const run = this.#queue.then(() => this.#read());
    this.#queue = run.catch(() => undefined);
    return run;
  }
}

export interface ClientAuthOptions {
  /** Directory the stores live in (created on first write). */
  dataDir: string;
  /** Display name devices show for this server. */
  serverLabel: string;
  /** Port the sidecar listens on, for advertised URLs. */
  port: number;
  /** Address the sidecar is bound to. */
  bindHost: string;
}

export function createClientAuthRuntime(options: ClientAuthOptions) {
  const clients = new JsonStore<{ clients: ClientRecord[] }>(join(options.dataDir, "remote-clients.json"), () => ({ clients: [] }));
  const pairings = new JsonStore<{ sessions: PairingSession[] }>(join(options.dataDir, "pairing-sessions.json"), () => ({ sessions: [] }));
  const redeemAttempts = new Map<string, { count: number; first: number }>();

  /**
   * URLs another device can reach this sidecar on, best first. Only addresses
   * the socket is actually listening on qualify: a wildcard bind exposes every
   * interface, a specific bind exposes that address alone, a loopback bind none.
   */
  const directUrls = (requestUrl: URL): string[] => {
    const urls: string[] = [];
    const push = (host: string | undefined) => {
      if (!host) return;
      const url = `http://${host.includes(":") ? `[${host}]` : host}:${options.port}`;
      if (!urls.includes(url)) urls.push(url);
    };
    const wildcard = options.bindHost === "0.0.0.0" || options.bindHost === "::";
    const loopback = ["127.0.0.1", "localhost", "::1"].includes(options.bindHost);
    if (loopback) return urls;
    // The address the caller already reached us on is the one known to route from its network.
    if (!isLoopbackUrl(requestUrl.origin) && (wildcard || requestUrl.hostname === options.bindHost)) push(requestUrl.hostname);
    if (!wildcard) {
      push(options.bindHost);
      return urls;
    }
    for (const list of Object.values(networkInterfaces())) {
      for (const entry of list ?? []) {
        if (entry.family === "IPv4" && !entry.internal) push(entry.address);
      }
    }
    return urls;
  };

  const createClient = (input: Json & { label?: unknown; fallbackLabel?: unknown }): Promise<{ client: Json; token: string }> =>
    clients.update((state) => {
      const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
      const dedupeKey = optString(input.dedupeKey);
      const existing = dedupeKey ? state.clients.find((entry) => entry.dedupeKey === dedupeKey) : undefined;
      const record: ClientRecord = {
        id: randomBytes(12).toString("hex"),
        label: label(optString(input.label) ?? existing?.label ?? input.fallbackLabel),
        tokenHash: sha256(token),
        createdAt: nowIso(),
        lastUsedAt: null,
        revokedAt: null,
        expiresAt: null,
        clientKind: optString(input.clientKind),
        dedupeKey,
        authMethod: optString(input.authMethod),
        pairingId: optString(input.pairingId),
        deviceName: optString(input.deviceName),
        devicePlatform: optString(input.devicePlatform),
        deviceModel: optString(input.deviceModel),
        appVersion: optString(input.appVersion),
      };
      // A dedupe-keyed mint replaces the device's previous record.
      if (dedupeKey) state.clients = state.clients.filter((entry) => entry.dedupeKey !== dedupeKey);
      state.clients.push(record);
      return { client: publicClient(record), token };
    });

  const redeem = (body: Json) => {
    const pairingId = optString(body.pairingId);
    const secret = optString(body.secret);
    const kind = optString(body.clientKind) ?? "mobile";
    if (!pairingId || !secret) throw new Error(REDEEM_ERROR);
    return pairings.update(async (state) => {
      const session = state.sessions.find((entry) => entry.id === pairingId);
      if (!session || !isPending(session) || !session.allowedClientKinds.includes(kind) || !safeEqualHex(session.secretHash, sha256(secret))) {
        throw new Error(REDEEM_ERROR);
      }
      const created = await createClient({
        label: session.label,
        fallbackLabel: optString(body.clientLabel) ?? optString(body.deviceName) ?? "Remote client",
        clientKind: kind,
        dedupeKey: optString(body.dedupeKey) ?? `pairing:${session.id}`,
        authMethod: "pairing",
        pairingId: session.id,
        deviceName: body.deviceName,
        devicePlatform: body.devicePlatform,
        deviceModel: body.deviceModel,
        appVersion: body.appVersion,
      });
      session.usedAt = nowIso();
      session.clientId = (created.client.id as string) ?? null;
      return { session, created };
    });
  };

  const readJson = async (req: Request): Promise<Json> => {
    try {
      const parsed = (await req.json()) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Json) : {};
    } catch {
      return {};
    }
  };

  const noStore = { "Cache-Control": "no-store" };

  async function handle(req: Request, url: URL, path: string, remoteAddress: string): Promise<ClientAuthRouteResult | null> {
    if (!path.startsWith("/api/client-auth/")) return null;
    const route = path.slice("/api/client-auth/".length);
    const method = req.method;

    if (route === "clients") {
      if (method === "GET") return { status: 200, data: { clients: (await clients.read()).clients.map(publicClient) } };
      if (method === "POST") {
        const body = await readJson(req);
        const created = await createClient({ label: body.label, fallbackLabel: "Remote client", clientKind: body.clientKind, dedupeKey: body.dedupeKey });
        return { status: 201, data: created, headers: noStore };
      }
      if (method === "DELETE") {
        const purged = await clients.update((state) => {
          const before = state.clients.length;
          state.clients = state.clients.filter((entry) => !entry.revokedAt);
          return before - state.clients.length;
        });
        return { status: 200, data: { purged } };
      }
      return null;
    }

    const clientMatch = /^clients\/([^/]+)$/.exec(route);
    if (clientMatch && method === "DELETE") {
      const id = decodeURIComponent(clientMatch[1]!);
      const revoked = await clients.update((state) => {
        const record = state.clients.find((entry) => entry.id === id);
        if (!record) return null;
        record.revokedAt ??= nowIso();
        return publicClient(record);
      });
      return revoked ? { status: 200, data: { revoked: true, client: revoked } } : { status: 404, data: { revoked: false, error: "Client not found" } };
    }

    if (route === "pairing/transports" && method === "GET") {
      const lan = directUrls(url).find((entry) => !isLoopbackUrl(entry)) ?? null;
      return { status: 200, data: { local: `http://127.0.0.1:${options.port}`, lan, relayAvailable: false }, headers: noStore };
    }

    if (route === "connection/candidates" && method === "GET") {
      const candidates = directUrls(url).map((entry) => ({ type: "lan", url: entry, priority: 10 }));
      return { status: 200, data: { label: options.serverLabel, candidates }, headers: noStore };
    }

    if (route === "pairing/sessions") {
      if (method === "GET") {
        const state = await pairings.read();
        return { status: 200, data: { pending: state.sessions.filter(isPending).map(publicSession) }, headers: noStore };
      }
      if (method === "POST") {
        const body = await readJson(req);
        const kinds = Array.isArray(body.allowedClientKinds) ? body.allowedClientKinds.filter((kind): kind is string => CLIENT_KINDS.includes(kind as string)) : [];
        const secret = randomBytes(32).toString("base64url");
        const session: PairingSession = {
          id: `pair_${randomBytes(12).toString("hex")}`,
          secretHash: sha256(secret),
          createdAt: nowIso(),
          expiresAt: new Date(Date.now() + PAIRING_TTL_MS).toISOString(),
          usedAt: null,
          cancelledAt: null,
          clientId: null,
          label: optString(body.label) ? label(body.label) : null,
          fingerprint: randomBytes(4).toString("hex").toUpperCase().replace(/^(.{4})(.{4})$/, "$1-$2"),
          allowedClientKinds: kinds.length > 0 ? [...new Set(kinds)] : [...CLIENT_KINDS],
        };
        await pairings.update((state) => {
          const cutoff = Date.now() - PAIRING_TTL_MS;
          // Drop sessions that can no longer matter before adding the new one.
          state.sessions = state.sessions.filter((entry) => {
            const inactive = Date.parse(entry.usedAt ?? entry.cancelledAt ?? "");
            return Number.isFinite(inactive) ? inactive >= cutoff : Date.parse(entry.expiresAt) > Date.now();
          });
          state.sessions.push(session);
        });
        const preferred = normalizeUrl(body.serverUrl);
        const origin = normalizeUrl(url.origin);
        // The creator's own origin is loopback when browsing locally, which is
        // useless to another device: advertise a reachable address instead.
        const reachable = [preferred, origin, ...directUrls(url)].filter((entry): entry is string => !!entry && !isLoopbackUrl(entry));
        const direct = body.includeDirect === false ? [] : [...new Set(reachable)];
        const candidates = direct.map((entry, index) => ({ type: urlType(entry), url: entry, priority: 10 * (index + 1) }));
        return {
          status: 201,
          data: { pairing: { ...publicSession(session), secret }, server: { label: options.serverLabel, candidates } },
          headers: noStore,
        };
      }
      return null;
    }

    const cancelMatch = /^pairing\/sessions\/([^/]+)$/.exec(route);
    if (cancelMatch && method === "DELETE") {
      const id = decodeURIComponent(cancelMatch[1]!);
      const cancelled = await pairings.update((state) => {
        const session = state.sessions.find((entry) => entry.id === id);
        if (!session) return false;
        session.cancelledAt ??= nowIso();
        return true;
      });
      return cancelled ? { status: 200, data: { cancelled: true } } : { status: 404, data: { cancelled: false, error: "Pairing session not found" } };
    }

    if (route === "pairing/redeem" && method === "POST") {
      const body = await readJson(req);
      const key = `${remoteAddress}:${optString(body.pairingId) ?? "missing"}`;
      const now = Date.now();
      for (const [entryKey, entry] of redeemAttempts) if (now - entry.first >= REDEEM_WINDOW_MS) redeemAttempts.delete(entryKey);
      const attempts = redeemAttempts.get(key) ?? { count: 0, first: now };
      if (attempts.count >= REDEEM_MAX_ATTEMPTS) {
        return { status: 429, data: { error: REDEEM_ERROR }, headers: { "Retry-After": String(Math.max(1, Math.ceil((attempts.first + REDEEM_WINDOW_MS - now) / 1000))) } };
      }
      attempts.count += 1;
      redeemAttempts.set(key, attempts);
      try {
        const { session, created } = await redeem(body);
        redeemAttempts.delete(key);
        const advertised = normalizeUrl(url.origin);
        return {
          status: 200,
          data: {
            ok: true,
            server: { label: options.serverLabel, url: advertised, fingerprint: session.fingerprint },
            client: created.client,
            clientToken: created.token,
          },
          headers: noStore,
        };
      } catch (error) {
        if (error instanceof Error && error.message === REDEEM_ERROR) return { status: 400, data: { error: REDEEM_ERROR } };
        throw error;
      }
    }

    return null;
  }

  return { handle };
}

export type ClientAuthRuntime = ReturnType<typeof createClientAuthRuntime>;
