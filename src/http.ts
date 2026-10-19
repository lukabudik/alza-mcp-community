import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { AlzaBrowser } from "./infra/browser.js";
import { ImpersonateTransport } from "./infra/impersonate-transport.js";
import { ConfigurationError } from "./infra/errors.js";
import { InitializeGuardTransport } from "./infra/initialize-guard.js";
import { log } from "./infra/logger.js";
import { buildServer, type BuildResult } from "./server.js";
import { TOOLSET_DEFS, type LockedToolsets } from "./tools/toolsets.js";

/**
 * MCP Streamable HTTP transport (issue #16).
 *
 * Security model — a networked endpoint can be reached by more than one client,
 * so the HTTP mode is deliberately stricter than stdio:
 *
 *  - Every MCP session (`Mcp-Session-Id`) gets its OWN `McpServer` built by
 *    `buildServer`: its own toolset enable/disable state, its own `MobileApi`
 *    (OAuth access/refresh tokens, PKCE verifier) and its own `MobileAccount`
 *    (one-time mutation / checkout confirmation tokens). Nothing account-related
 *    is shared between sessions.
 *  - Only the read-only, anonymous `catalog` and `pc_builder` toolsets are usable
 *    by default (pc_builder only reads public catalog pages). Every other
 *    toolset (auth, basket/checkout, account, orders/payments, reviews/
 *    subscriptions, chat, raw mobile reads) is LOCKED: still listed by
 *    `list_toolsets` with the reason, but `set_toolset` refuses to enable it.
 *    The operator opts in with `ALZA_HTTP_ENABLE_ACCOUNT=1`.
 *  - With the account opt-in, each session also gets its own browser context
 *    and its own Chrome-fingerprint sidecar (both lazy), because both keep a
 *    cookie jar for Alza and must not carry one user's cookies into another
 *    user's requests. In catalog-only mode they are shared (public reads only).
 *  - `ALZA_TOKEN_FILE` (a single-user OAuth token store) is never auto-loaded in
 *    HTTP mode unless the operator additionally sets `ALZA_HTTP_ALLOW_TOKEN_FILE=1`
 *    — meant for a single-user localhost setup only; every session then starts
 *    signed in as that one account.
 *  - Binds to 127.0.0.1 by default and validates `Host`/`Origin` against an
 *    allow-list (DNS-rebinding protection for a localhost server).
 */

export const ACCOUNT_LOCK_REASON =
  "Disabled on the Streamable HTTP transport: a networked MCP endpoint can be reached by more than one client, and these tools sign in to and act on a real Alza account (orders, payments, credentials). " +
  "The server operator can opt in with ALZA_HTTP_ENABLE_ACCOUNT=1; each MCP session then has its own isolated OAuth login and confirmation tokens.";

export interface HttpServerOptions {
  /** TCP port; 0 picks a free one. Default 3000. */
  port?: number;
  /** Bind address. Default 127.0.0.1 (localhost only). */
  host?: string;
  /** MCP endpoint path. Default /mcp. */
  path?: string;
  /** Unlock the account/checkout toolsets (ALZA_HTTP_ENABLE_ACCOUNT=1). Default false. */
  allowAccount?: boolean;
  /** Auto-load ALZA_TOKEN_FILE into every session (ALZA_HTTP_ALLOW_TOKEN_FILE=1). Requires allowAccount. Default false. */
  allowTokenFile?: boolean;
  /** Accepted Host/Origin hostnames. Default: loopback names when bound to loopback, otherwise no check. */
  allowedHosts?: string[];
  /** Concurrent session cap. Default 50. */
  maxSessions?: number;
  /** Close a session after this many ms without a request. Default 30 min. */
  sessionIdleMs?: number;
  /** Time a client has to send a whole request (headers and body), in ms; the
   * response, e.g. a long tool call or a GET/SSE stream, is not limited. Headers
   * get half of it. Default 30 s. */
  requestTimeoutMs?: number;
  /** Open TCP connection cap (SSE streams count). Default 256. */
  maxConnections?: number;
  /** Request bodies buffered at once (each up to 4 MB); 503 beyond it. Default 16. */
  maxConcurrentBodyReads?: number;
  baseUrl?: string;
  cdpUrl?: string;
}

export interface RunningHttpServer {
  /** Full MCP endpoint URL, e.g. http://127.0.0.1:3000/mcp */
  url: string;
  port: number;
  sessionCount: () => number;
  close: () => Promise<void>;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  built: BuildResult;
  lastSeen: number;
  /** Requests/streams still open (e.g. a long-lived GET SSE stream); the idle sweep skips the session while > 0. */
  open: number;
}

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]"];
const MAX_BODY_BYTES = 4 * 1024 * 1024;

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

/** Hostname part of a Host header value (`example.com:3000`, `[::1]:3000`). */
function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  return h.split(":")[0] ?? h;
}

function jsonRpcError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

class BodyTooLargeError extends Error {
  constructor() {
    super(`request body too large (limit ${MAX_BODY_BYTES} bytes)`);
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = chunk as Buffer;
    size += b.length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLargeError();
    chunks.push(b);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Every Content-Type header value as sent. Node's `req.headers` keeps only the first
 * duplicate, while the SDK's Web `Headers` (built from rawHeaders) joins them all. */
function contentTypeValues(req: IncomingMessage): string[] {
  const values: string[] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i]?.toLowerCase() === "content-type") values.push(req.rawHeaders[i + 1] ?? "");
  }
  return values;
}

/** Bodies being buffered right now, across all requests of one server. */
interface BodyReads {
  active: number;
  max: number;
}

/** Read the JSON body within MAX_BODY_BYTES, or answer 413/400/503 and return null.
 * At most `reads.max` bodies are buffered at once (each up to MAX_BODY_BYTES); a
 * request over that cap is drained without buffering, then answered 503, so the
 * client gets the response instead of a reset. requestTimeout bounds the drain. */
async function readJsonBodyOrReply(req: IncomingMessage, res: ServerResponse, reads: BodyReads): Promise<{ body: unknown } | null> {
  if (reads.active >= reads.max) {
    await new Promise<void>((resolve) => {
      req.once("end", resolve);
      req.once("close", resolve);
      req.resume();
    });
    res.setHeader("retry-after", "1");
    jsonRpcError(res, 503, "Server busy; try again shortly");
    return null;
  }
  reads.active++;
  try {
    return { body: await readJsonBody(req) };
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      res.setHeader("connection", "close");
      jsonRpcError(res, 413, err.message);
    } else {
      // Fixed text: JSON.parse messages quote part of the client's input.
      log.debug("http: invalid request body", { error: (err as Error).message });
      jsonRpcError(res, 400, "Invalid request body: expected a JSON-RPC message");
    }
    return null;
  } finally {
    reads.active--;
  }
}

/** Toolsets that only read public catalog data and never touch an account. */
export const ANONYMOUS_TOOLSETS: ReadonlySet<string> = new Set(["catalog", "pc_builder"]);

/** Locked toolsets for an HTTP deployment: everything but the anonymous read-only toolsets unless opted in. */
export function httpLockedToolsets(allowAccount: boolean): LockedToolsets {
  if (allowAccount) return {};
  return Object.fromEntries(TOOLSET_DEFS.filter((d) => !ANONYMOUS_TOOLSETS.has(d.id)).map((d) => [d.id, ACCOUNT_LOCK_REASON]));
}

export async function startHttpServer(opts: HttpServerOptions = {}): Promise<RunningHttpServer> {
  const host = opts.host ?? "127.0.0.1";
  const path = opts.path ?? "/mcp";
  const allowAccount = opts.allowAccount ?? false;
  const allowTokenFile = allowAccount && (opts.allowTokenFile ?? false);
  if (opts.allowTokenFile && !allowAccount) {
    log.warn("http: ALZA_HTTP_ALLOW_TOKEN_FILE ignored — it requires ALZA_HTTP_ENABLE_ACCOUNT=1");
  }
  const maxSessions = opts.maxSessions ?? 50;
  const sessionIdleMs = opts.sessionIdleMs ?? 30 * 60 * 1000;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
  const bodyReads: BodyReads = { active: 0, max: opts.maxConcurrentBodyReads ?? 16 };
  const allowedHosts = (opts.allowedHosts && opts.allowedHosts.length > 0
    ? opts.allowedHosts
    : isLoopback(host) ? LOOPBACK_HOSTS : []
  ).map((h) => h.toLowerCase());
  if (!isLoopback(host)) {
    log.warn("http: listening on a non-loopback address — put this behind TLS and an authenticating proxy", { host, allowedHosts });
  }

  const locked = httpLockedToolsets(allowAccount);
  // Catalog-only: one browser + sidecar for every session (public, anonymous reads).
  // Account mode: per-session instances, so cookie jars are never shared.
  const shared = allowAccount
    ? undefined
    : { browser: new AlzaBrowser({ baseUrl: opts.baseUrl, cdpUrl: opts.cdpUrl }), cfTransport: new ImpersonateTransport() };
  const instructionsNote = allowAccount
    ? "Served over Streamable HTTP: this MCP session has its own isolated OAuth login and confirmation tokens" +
      (allowTokenFile ? " (pre-loaded from the operator's ALZA_TOKEN_FILE)." : "; sign in with `auth_start` → `auth_exchange`.")
    : "Served over Streamable HTTP: only the read-only `catalog` toolset (on by default) and `pc_builder` (enable with `set_toolset`) are available on this deployment; the auth, account, basket/checkout, order and payment toolsets are locked (see `list_toolsets`).";

  const sessions = new Map<string, Session>();

  const closeSession = async (id: string): Promise<void> => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    await s.transport.close().catch(() => {});
    await s.built.close().catch(() => {});
    log.info("http: session closed", { sessions: sessions.size });
  };

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (s.open === 0 && now - s.lastSeen > sessionIdleMs) void closeSession(id);
    }
  }, Math.min(60_000, Math.max(1_000, Math.floor(sessionIdleMs / 2))));
  sweep.unref();

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (allowedHosts.length > 0) {
      const hostHeader = req.headers.host;
      if (!hostHeader || !allowedHosts.includes(hostnameOf(hostHeader))) {
        return jsonRpcError(res, 403, `Invalid Host header: ${hostHeader ?? "(missing)"}`);
      }
      const origin = req.headers.origin;
      if (origin) {
        let originHost: string;
        try { originHost = new URL(origin).hostname.toLowerCase(); } catch { originHost = ""; }
        if (!allowedHosts.includes(originHost) && !allowedHosts.includes(`[${originHost}]`)) {
          return jsonRpcError(res, 403, `Invalid Origin header: ${origin}`);
        }
      }
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, transport: "streamable-http", sessions: sessions.size, account: allowAccount }));
      return;
    }
    if (url.pathname !== path) return jsonRpcError(res, 404, `Not found; the MCP endpoint is ${path}`);

    const sessionHeader = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
    if (sessionId) {
      const s = sessions.get(sessionId);
      if (!s) return jsonRpcError(res, 404, "Unknown or expired session; re-initialize");
      s.lastSeen = Date.now();
      s.open++;
      res.once("close", () => {
        s.open--;
        s.lastSeen = Date.now();
      });
      // The SDK reads a POST body without a size limit, so read JSON bodies here.
      // Anything else is left unread: the SDK answers it with 415 before reading.
      // That split is only safe while both sides see the same Content-Type, so a
      // repeated header (Node keeps the first, the SDK joins them) is refused.
      let body: unknown;
      if (req.method === "POST") {
        const contentTypes = contentTypeValues(req);
        if (contentTypes.length > 1) return jsonRpcError(res, 400, "Duplicate Content-Type header");
        if (contentTypes[0]?.includes("application/json")) {
          const read = await readJsonBodyOrReply(req, res, bodyReads);
          if (!read) return;
          body = read.body;
        }
      }
      await s.transport.handleRequest(req, res, body);
      return;
    }

    if (req.method !== "POST") {
      if (req.method === "GET" || req.method === "DELETE") return jsonRpcError(res, 400, "Missing Mcp-Session-Id header");
      res.setHeader("allow", "POST, GET, DELETE");
      return jsonRpcError(res, 405, `Method ${req.method} is not supported on ${path}; use POST to initialize a session`);
    }
    const read = await readJsonBodyOrReply(req, res, bodyReads);
    if (!read) return;
    const body = read.body;
    if (Array.isArray(body)) return jsonRpcError(res, 400, "JSON-RPC batches are not supported; send the initialize request on its own (not in an array)");
    if (!isInitializeRequest(body)) return jsonRpcError(res, 400, "Missing Mcp-Session-Id header (only an initialize request may omit it)");
    if (sessions.size >= maxSessions) return jsonRpcError(res, 503, "Too many concurrent sessions; try again later");

    const built = buildServer({
      baseUrl: opts.baseUrl,
      cdpUrl: opts.cdpUrl,
      browser: shared?.browser,
      cfTransport: shared?.cfTransport,
      lockedToolsets: locked,
      loadTokenFile: allowTokenFile,
      instructionsNote,
      transport: "http",
    });
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, built, lastSeen: Date.now(), open: 0 });
        log.info("http: session opened", { sessions: sessions.size });
      },
      onsessionclosed: (id) => closeSession(id),
    });
    transport.onclose = () => {
      if (transport.sessionId) void closeSession(transport.sessionId);
    };
    try {
      await built.server.connect(new InitializeGuardTransport(transport));
      await transport.handleRequest(req, res, body);
    } finally {
      if (!transport.sessionId || !sessions.has(transport.sessionId)) {
        // Initialization was rejected or failed — nothing references this server any more.
        await built.close().catch(() => {});
      }
    }
  };

  // Node's defaults (300 s per request, 60 s for headers) let one client hold a
  // connection and a 4 MB buffer for minutes by trickling bytes. These limits end
  // when the request is received, so long responses and SSE streams are unaffected.
  // Node checks them on an interval (30 s by default): keep it a fraction of the limit.
  const server: Server = createServer(
    {
      requestTimeout: requestTimeoutMs,
      headersTimeout: Math.ceil(requestTimeoutMs / 2),
      connectionsCheckingInterval: Math.min(30_000, Math.max(100, Math.floor(requestTimeoutMs / 4))),
    },
    (req, res) => {
      handle(req, res).catch((err) => {
        log.error("http: request failed", { error: (err as Error).message });
        jsonRpcError(res, 500, "Internal server error");
      });
    },
  );
  server.maxConnections = opts.maxConnections ?? 256;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 3000, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const displayHost = host.includes(":") ? `[${host}]` : host;

  return {
    url: `http://${displayHost}:${port}${path}`,
    port,
    sessionCount: () => sessions.size,
    close: async () => {
      clearInterval(sweep);
      await Promise.all([...sessions.keys()].map((id) => closeSession(id)));
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
      shared?.cfTransport.close();
      await shared?.browser.close();
    },
  };
}

export interface CliConfig {
  transport: "stdio" | "http";
  http: HttpServerOptions;
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** Parse `--http [--port N] [--host H]` and the ALZA_TRANSPORT / ALZA_HTTP_* env vars. */
export function parseCliConfig(argv: string[], env: NodeJS.ProcessEnv = process.env): CliConfig {
  let transport: "stdio" | "http" = env.ALZA_TRANSPORT?.toLowerCase() === "http" ? "http" : "stdio";
  if (env.ALZA_TRANSPORT && !["http", "stdio"].includes(env.ALZA_TRANSPORT.toLowerCase())) {
    throw new ConfigurationError(`ALZA_TRANSPORT must be "stdio" or "http" (got ${JSON.stringify(env.ALZA_TRANSPORT.slice(0, 20))})`);
  }
  let port: string | undefined = env.ALZA_HTTP_PORT ?? env.PORT;
  let host: string | undefined = env.ALZA_HTTP_HOST;
  let portFromArgv = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const [flag, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    if (flag === "--http") transport = "http";
    else if (flag === "--stdio") transport = "stdio";
    else if (flag === "--port" || flag === "--host") {
      const value = inline ?? argv[++i];
      if (value === undefined) throw new ConfigurationError(`${flag} requires a value`);
      if (flag === "--port") { port = value; portFromArgv = true; } else host = value;
    } else {
      throw new ConfigurationError(`Unknown argument ${JSON.stringify(arg.slice(0, 40))}. Try --help`);
    }
  }
  if (portFromArgv && transport !== "http") throw new ConfigurationError("--port only applies with --http (or ALZA_TRANSPORT=http)");
  let portNum: number | undefined;
  // Only validate the port in HTTP mode: a stray PORT in a stdio client's env must not break startup.
  if (port !== undefined && transport === "http") {
    portNum = Number(port);
    if (!Number.isInteger(portNum) || portNum < 0 || portNum > 65535) throw new ConfigurationError(`Invalid port ${JSON.stringify(port.slice(0, 20))}`);
  }
  const allowedHosts = env.ALZA_HTTP_ALLOWED_HOSTS?.split(",").map((h) => h.trim()).filter(Boolean);
  const idle = Number(env.ALZA_HTTP_SESSION_IDLE_MS);
  const max = Number(env.ALZA_HTTP_MAX_SESSIONS);
  const requestTimeout = Number(env.ALZA_HTTP_REQUEST_TIMEOUT_MS);
  const maxConnections = Number(env.ALZA_HTTP_MAX_CONNECTIONS);
  return {
    transport,
    http: {
      port: portNum,
      host,
      allowAccount: TRUTHY.has((env.ALZA_HTTP_ENABLE_ACCOUNT ?? "").toLowerCase()),
      allowTokenFile: TRUTHY.has((env.ALZA_HTTP_ALLOW_TOKEN_FILE ?? "").toLowerCase()),
      allowedHosts,
      maxSessions: Number.isInteger(max) && max > 0 ? max : undefined,
      sessionIdleMs: Number.isFinite(idle) && idle > 0 ? idle : undefined,
      requestTimeoutMs: Number.isInteger(requestTimeout) && requestTimeout > 0 ? requestTimeout : undefined,
      maxConnections: Number.isInteger(maxConnections) && maxConnections > 0 ? maxConnections : undefined,
      baseUrl: env.ALZA_BASE_URL?.trim() || undefined,
      cdpUrl: env.ALZA_CDP_URL,
    },
  };
}
