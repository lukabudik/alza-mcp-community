import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ACCOUNT_LOCK_REASON, ANONYMOUS_TOOLSETS, parseCliConfig, startHttpServer, type RunningHttpServer } from "../src/http.js";
import { TOOLSET_DEFS } from "../src/tools/toolsets.js";

// Smoke tests for the Streamable HTTP transport (issue #16). They drive the real
// SDK client over real HTTP on an ephemeral localhost port, and only call tools
// that make no network request to Alza (tools/list, list_toolsets, set_toolset,
// account_status, prepare_mutation, and a mutate_list that fails token validation
// before any request), so no browser or sidecar is ever started.

const CATALOG = TOOLSET_DEFS.find((d) => d.id === "catalog")!.tools;
const PC_BUILDER = TOOLSET_DEFS.find((d) => d.id === "pc_builder")!.tools;
const tokenDir = mkdtempSync(join(tmpdir(), "alza-mcp-community-http-test-"));
const tokenFile = join(tokenDir, "tokens.json");
writeFileSync(tokenFile, JSON.stringify({ access_token: "fake-access", refresh_token: "fake-refresh", visitor_id: "00000000-0000-4000-8000-000000000000" }));
const savedTokenFile = process.env.ALZA_TOKEN_FILE;

beforeAll(() => {
  // A token store IS present: HTTP mode must still not load it unless opted in.
  process.env.ALZA_TOKEN_FILE = tokenFile;
});
afterAll(() => {
  if (savedTokenFile === undefined) delete process.env.ALZA_TOKEN_FILE; else process.env.ALZA_TOKEN_FILE = savedTokenFile;
  rmSync(tokenDir, { recursive: true, force: true });
});

const open: { server?: RunningHttpServer; clients: Client[] } = { clients: [] };
afterEach(async () => {
  for (const c of open.clients.splice(0)) await c.close().catch(() => {});
  await open.server?.close();
  open.server = undefined;
});

async function start(opts: Parameters<typeof startHttpServer>[0] = {}) {
  open.server = await startHttpServer({ port: 0, ...opts });
  return open.server;
}

async function connect(server: RunningHttpServer): Promise<Client> {
  const client = new Client({ name: "http-smoke", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
  open.clients.push(client);
  return client;
}

async function toolNames(client: Client): Promise<string[]> {
  return (await client.listTools()).tools.map((t) => t.name).sort();
}

function text(res: unknown): string {
  return ((res as { content: { text: string }[] }).content[0]?.text) ?? "";
}

/** Raw HTTP/1.1 over a socket, for header shapes Node's client won't send (duplicates). */
function rawSocketRequest(port: number, head: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = netConnect(port, "127.0.0.1");
    let out = "";
    sock.on("data", (d) => (out += d));
    sock.on("error", reject);
    sock.on("close", () => resolve(out));
    sock.end(head + body);
  });
}

function rawRequest(port: number, opts: { method: string; path: string; headers?: Record<string, string>; body?: string }) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: opts.method, path: opts.path, headers: opts.headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end(opts.body);
  });
}

describe("parseCliConfig", () => {
  it("defaults to stdio", () => {
    expect(parseCliConfig([], {}).transport).toBe("stdio");
  });
  it("reads the request timeout and connection cap from the environment", () => {
    expect(parseCliConfig(["--http"], { ALZA_HTTP_REQUEST_TIMEOUT_MS: "5000", ALZA_HTTP_MAX_CONNECTIONS: "64" }).http).toMatchObject({ requestTimeoutMs: 5000, maxConnections: 64 });
    expect(parseCliConfig(["--http"], { ALZA_HTTP_REQUEST_TIMEOUT_MS: "nope", ALZA_HTTP_MAX_CONNECTIONS: "0" }).http).toMatchObject({ requestTimeoutMs: undefined, maxConnections: undefined });
  });
  it("accepts --http [--port N] and ALZA_TRANSPORT=http", () => {
    expect(parseCliConfig(["--http", "--port", "8123"], {})).toMatchObject({ transport: "http", http: { port: 8123 } });
    expect(parseCliConfig(["--http", "--port=0", "--host=0.0.0.0"], {})).toMatchObject({ http: { port: 0, host: "0.0.0.0" } });
    expect(parseCliConfig([], { ALZA_TRANSPORT: "http", ALZA_HTTP_PORT: "9000" })).toMatchObject({ transport: "http", http: { port: 9000 } });
  });
  it("keeps account access and the token file off unless explicitly opted in", () => {
    expect(parseCliConfig(["--http"], {}).http).toMatchObject({ allowAccount: false, allowTokenFile: false });
    expect(parseCliConfig(["--http"], { ALZA_HTTP_ENABLE_ACCOUNT: "1", ALZA_HTTP_ALLOW_TOKEN_FILE: "true" }).http)
      .toMatchObject({ allowAccount: true, allowTokenFile: true });
  });
  it("rejects bad input", () => {
    expect(() => parseCliConfig(["--port", "80"], {})).toThrow(/--http/);
    expect(() => parseCliConfig(["--http", "--port", "abc"], {})).toThrow(/Invalid port/);
    expect(() => parseCliConfig(["--bogus"], {})).toThrow(/Unknown argument/);
    expect(() => parseCliConfig([], { ALZA_TRANSPORT: "sse" })).toThrow(/ALZA_TRANSPORT/);
  });
  it("ignores an unrelated PORT env var in stdio mode", () => {
    expect(parseCliConfig([], { PORT: "not-a-port" }).transport).toBe("stdio");
    expect(() => parseCliConfig(["--http"], { PORT: "not-a-port" })).toThrow(/Invalid port/);
  });
});

describe("Streamable HTTP transport (default: catalog only)", () => {
  it("lists the catalog tools over HTTP via the SDK client", async () => {
    const server = await start();
    const client = await connect(server);
    expect(await toolNames(client)).toEqual([...CATALOG, "list_toolsets", "set_toolset", "report_issue"].sort());
    expect(server.sessionCount()).toBe(1);
  });

  it("locks every toolset except catalog and pc_builder with a documented reason", async () => {
    const server = await start();
    const client = await connect(server);
    const listed = await client.callTool({ name: "list_toolsets", arguments: {} });
    const toolsets = (listed.structuredContent as { toolsets: { id: string; enabled: boolean; locked?: string }[] }).toolsets;
    for (const t of toolsets) {
      if (t.id === "catalog") { expect(t.enabled).toBe(true); expect(t.locked).toBeUndefined(); }
      else if (ANONYMOUS_TOOLSETS.has(t.id)) { expect(t.enabled).toBe(false); expect(t.locked).toBeUndefined(); }
      else expect(t).toMatchObject({ enabled: false, locked: ACCOUNT_LOCK_REASON });
    }
    const refused = await client.callTool({ name: "set_toolset", arguments: { id: "basket_and_checkout", enabled: true } });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/locked on this deployment.*ALZA_HTTP_ENABLE_ACCOUNT/);
    const all = await client.callTool({ name: "set_toolset", arguments: { id: "all", enabled: true } });
    expect(all.isError).toBeFalsy();
    expect(text(all)).toMatch(/Skipped locked toolset/);
    expect(await toolNames(client)).toEqual([...CATALOG, ...PC_BUILDER, "list_toolsets", "set_toolset", "report_issue"].sort());
    // A locked tool cannot be called directly either, even by a client that knows its name.
    const direct = await client.callTool({ name: "cart", arguments: {} });
    expect(direct.isError).toBe(true);
    expect(text(direct)).toMatch(/disabled/);
  });

  it("guards the endpoint: Host allow-list, unknown sessions, non-initialize requests, health check", async () => {
    const server = await start();
    const initBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } } });
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const rebinding = await rawRequest(server.port, { method: "POST", path: "/mcp", headers: { ...headers, host: "evil.example:80" }, body: initBody });
    expect(rebinding.status).toBe(403);
    const badOrigin = await rawRequest(server.port, { method: "POST", path: "/mcp", headers: { ...headers, origin: "https://evil.example" }, body: initBody });
    expect(badOrigin.status).toBe(403);
    const unknown = await rawRequest(server.port, { method: "POST", path: "/mcp", headers: { ...headers, "mcp-session-id": "nope" }, body: initBody });
    expect(unknown.status).toBe(404);
    const noSession = await rawRequest(server.port, { method: "POST", path: "/mcp", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(noSession.status).toBe(400);
    const health = await rawRequest(server.port, { method: "GET", path: "/healthz" });
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toMatchObject({ ok: true, transport: "streamable-http", account: false });
    expect(server.sessionCount()).toBe(0);
  });

  it("rejects an oversized initialize request with 413", async () => {
    const server = await start();
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const oversized = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { pad: "x".repeat(4 * 1024 * 1024 + 100) } });
    const tooLargeInit = await rawRequest(server.port, { method: "POST", path: "/mcp", headers, body: oversized });
    expect(tooLargeInit.status).toBe(413);
    expect(server.sessionCount()).toBe(0);
  });

  it("enforces the body size limit on existing-session requests", async () => {
    const server = await start();
    const client = await connect(server);
    const sessionId = (client.transport as StreamableHTTPClientTransport).sessionId;
    expect(sessionId).toBeDefined();

    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId!,
    };
    const oversized = JSON.stringify({
      jsonrpc: "2.0",
      id: 99,
      method: "tools/list",
      params: { pad: "x".repeat(4 * 1024 * 1024 + 100) },
    });
    const tooLarge = { jsonrpc: "2.0", error: { code: -32000, message: expect.stringMatching(/request body too large/i) } };
    // With Content-Length (Node sets it for a single end(body)) and chunked: both are
    // refused once the bytes read pass the limit.
    const declared = await rawRequest(server.port, { method: "POST", path: "/mcp", headers, body: oversized });
    expect(declared.status).toBe(413);
    expect(JSON.parse(declared.body)).toMatchObject(tooLarge);
    const chunked = await rawRequest(server.port, { method: "POST", path: "/mcp", headers: { ...headers, "transfer-encoding": "chunked" }, body: oversized });
    expect(chunked.status).toBe(413);
    expect(JSON.parse(chunked.body)).toMatchObject(tooLarge);
  });

  it("refuses a repeated Content-Type on a session POST instead of letting the SDK read the body unmetered", async () => {
    // Node keeps the first Content-Type (text/plain: not read here) while the SDK joins
    // them ("text/plain, application/json": parsed with no size limit).
    const server = await start();
    const client = await connect(server);
    const sessionId = (client.transport as StreamableHTTPClientTransport).sessionId!;
    const body = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" });
    const head =
      "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\n" +
      "Content-Type: text/plain\r\nContent-Type: application/json\r\n" +
      `Accept: application/json, text/event-stream\r\nMcp-Session-Id: ${sessionId}\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n`;
    const res = await rawSocketRequest(server.port, head, body);
    expect(res.split("\r\n")[0]).toMatch(/^HTTP\/1\.1 400 /);
    expect(res).toMatch(/Duplicate Content-Type header/);
  });

  it("leaves a non-JSON session POST to the SDK (415)", async () => {
    const server = await start();
    const client = await connect(server);
    const sessionId = (client.transport as StreamableHTTPClientTransport).sessionId!;
    const res = await rawRequest(server.port, {
      method: "POST",
      path: "/mcp",
      headers: { "content-type": "text/plain", accept: "application/json, text/event-stream", "mcp-session-id": sessionId },
      body: "hello",
    });
    expect(res.status).toBe(415);
  });

  it("enforces the session cap and releases a session on DELETE", async () => {
    const server = await start({ maxSessions: 1 });
    const a = await connect(server);
    await expect(connect(server)).rejects.toThrow();
    open.clients.pop();
    await (a.transport as StreamableHTTPClientTransport).terminateSession();
    expect(server.sessionCount()).toBe(0);
    await connect(server);
    expect(server.sessionCount()).toBe(1);
  });

  it("keeps a session holding an open GET/SSE stream past the idle timeout, then sweeps it once the stream closes", async () => {
    const server = await start({ sessionIdleMs: 300 });
    const client = await connect(server); // the SDK client opens a standalone GET SSE stream after initialize
    await new Promise((r) => setTimeout(r, 2_300));
    expect(server.sessionCount()).toBe(1);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    open.clients.pop();
    await client.close(); // aborts the stream without a DELETE
    await new Promise((r) => setTimeout(r, 2_300));
    expect(server.sessionCount()).toBe(0);
  }, 10_000);
});

describe("Streamable HTTP transport resource limits", () => {
  const initBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } } });
  const initHead = (length: number) =>
    "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n" +
    `Accept: application/json, text/event-stream\r\nContent-Length: ${length}\r\n\r\n`;

  /** A socket that sent `data` and collects whatever comes back until the server closes it. */
  function openSocket(port: number, data: string) {
    const sock = netConnect(port, "127.0.0.1");
    let out = "";
    sock.on("data", (d) => (out += d));
    sock.on("error", () => {});
    const closed = new Promise<string>((resolve) => sock.on("close", () => resolve(out)));
    sock.write(data);
    return { sock, closed };
  }

  it("answers 408 and closes a request whose body stalls past requestTimeoutMs", async () => {
    const server = await start({ requestTimeoutMs: 400 });
    // Declares the whole initialize body but sends half of it, then goes quiet.
    const { closed } = openSocket(server.port, initHead(Buffer.byteLength(initBody)) + initBody.slice(0, 20));
    const started = Date.now();
    const out = await closed;
    expect(out.split("\r\n")[0]).toMatch(/^HTTP\/1\.1 408 /);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(server.sessionCount()).toBe(0);
  });

  it("does not time out responses: a session keeps its GET/SSE stream and answers calls past requestTimeoutMs", async () => {
    const server = await start({ requestTimeoutMs: 300 });
    const client = await connect(server); // opens a standalone GET SSE stream after initialize
    await new Promise((r) => setTimeout(r, 1_500));
    expect(server.sessionCount()).toBe(1);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
  }, 10_000);

  it("answers 503 (after draining) once maxConcurrentBodyReads bodies are being read", async () => {
    const server = await start({ maxConcurrentBodyReads: 1 });
    // Holds the only read slot: headers plus part of a declared body.
    const holder = openSocket(server.port, initHead(Buffer.byteLength(initBody)) + initBody.slice(0, 20));
    await new Promise((r) => setTimeout(r, 100));
    const busy = await rawRequest(server.port, {
      method: "POST",
      path: "/mcp",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: initBody,
    });
    expect(busy.status).toBe(503);
    expect(JSON.parse(busy.body)).toMatchObject({ error: { message: expect.stringMatching(/busy/i) } });
    // The slot frees once the first body completes: that initialize goes through.
    holder.sock.end(initBody.slice(20));
    expect((await holder.closed).split("\r\n")[0]).toMatch(/^HTTP\/1\.1 200 /);
  });

  it("does not echo the client's input in the invalid-body error", async () => {
    const server = await start();
    const res = await rawRequest(server.port, {
      method: "POST",
      path: "/mcp",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: '{"secret-marker": ',
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ error: { message: "Invalid request body: expected a JSON-RPC message" } });
    expect(res.body).not.toMatch(/secret-marker/);
  });

  it("caps open connections at maxConnections", async () => {
    const server = await start({ maxConnections: 1 });
    const first = openSocket(server.port, "");
    await new Promise((r) => setTimeout(r, 100));
    const second = openSocket(server.port, "");
    // Node drops a connection over the cap right away.
    await expect(Promise.race([second.closed.then(() => "closed"), new Promise((r) => setTimeout(() => r("open"), 1_000))])).resolves.toBe("closed");
    first.sock.destroy();
  });
});

describe("Streamable HTTP transport (ALZA_HTTP_ENABLE_ACCOUNT opt-in)", () => {
  it("isolates toolset state, OAuth state and mutation tokens per session", async () => {
    const server = await start({ allowAccount: true });
    const a = await connect(server);
    const b = await connect(server);
    expect(server.sessionCount()).toBe(2);

    // Toolset state: enabling a group in A does not show up in B.
    await a.callTool({ name: "set_toolset", arguments: { id: "basket_and_checkout", enabled: true } });
    expect(await toolNames(a)).toContain("cart");
    expect(await toolNames(b)).not.toContain("cart");

    // OAuth state: ALZA_TOKEN_FILE exists but is NOT auto-loaded; visitor ids differ.
    const sa = (await a.callTool({ name: "account_status", arguments: {} })).structuredContent as { authenticated: boolean; visitorId: string };
    const sb = (await b.callTool({ name: "account_status", arguments: {} })).structuredContent as { authenticated: boolean; visitorId: string };
    expect(sa.authenticated).toBe(false);
    expect(sb.authenticated).toBe(false);
    expect(sa.visitorId).not.toBe(sb.visitorId);

    // Mutation tokens: a token prepared in A is rejected in B (before any Alza request).
    const prepared = await a.callTool({ name: "prepare_mutation", arguments: { action: "create", payload: { name: "x" } } });
    const token = (prepared.structuredContent as { confirmationToken: string }).confirmationToken;
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    await b.callTool({ name: "set_toolset", arguments: { id: "basket_and_checkout", enabled: true } });
    const crossed = await b.callTool({ name: "mutate_list", arguments: { action: "create", confirmation_token: token, payload: { name: "x" } } });
    expect(crossed.isError).toBe(true);
    expect(text(crossed)).toMatch(/Invalid or expired mutation confirmation token/);
  });

  it("loads ALZA_TOKEN_FILE only with the explicit ALZA_HTTP_ALLOW_TOKEN_FILE opt-in", async () => {
    const server = await start({ allowAccount: true, allowTokenFile: true });
    const client = await connect(server);
    const s = (await client.callTool({ name: "account_status", arguments: {} })).structuredContent as { authenticated: boolean };
    expect(s.authenticated).toBe(true);
  });

  it("ignores the token-file opt-in when account access is not enabled", async () => {
    const server = await start({ allowTokenFile: true });
    const client = await connect(server);
    const listed = await client.callTool({ name: "list_toolsets", arguments: {} });
    const auth = (listed.structuredContent as { toolsets: { id: string; locked?: string }[] }).toolsets.find((t) => t.id === "auth");
    expect(auth?.locked).toBe(ACCOUNT_LOCK_REASON);
  });
});
