import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthenticationError } from "../src/infra/errors.js";
import { MobileApi, type HttpFetch } from "../src/infra/mobile-api.js";
import { MobileAccount } from "../src/domain/mobile-account.js";

/** Unsigned test JWT whose `exp` is `expSecondsFromNow` away. */
function jwt(name: string, expSecondsFromNow: number): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc({ sub: name, exp: Math.floor(Date.now() / 1000) + expSecondsFromNow })}.sig`;
}

const json = (status: number, body: unknown) => ({ status, text: async () => JSON.stringify(body) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Mock Alza: an IdP with ONE-TIME refresh tokens (rt-0 → rt-1 → …, a reused
 * one is rejected with 400 invalid_grant) plus API routes that only honour the
 * current access token. Legacy restservice routes answer a stale token like
 * live Alza does — HTTP 200 with the anonymous envelope (user_id -1); /api/*
 * routes answer 401.
 */
function mockAlza(opts: { initialAccess: string; issue?: (n: number) => string; refreshDelayMs?: number; apiDelayMs?: (url: string) => number } ) {
  let validAccess = opts.initialAccess;
  let validRefresh = "rt-0";
  let n = 0;
  const log: string[] = [];
  const calls: string[] = [];
  const issue = opts.issue ?? ((i: number) => jwt(`at-${i}`, 3600));
  const httpFetch: HttpFetch = async (url, init) => {
    if (url.includes("openid-configuration")) return json(200, { token_endpoint: "https://identity.test/connect/token" });
    if (url === "https://identity.test/connect/token") {
      const body = new URLSearchParams(String(init.body));
      log.push(`refresh ${body.get("refresh_token")}`);
      await sleep(opts.refreshDelayMs ?? 5);
      if (body.get("refresh_token") !== validRefresh) return json(400, { error: "invalid_grant" });
      n += 1;
      validRefresh = `rt-${n}`;
      validAccess = issue(n);
      return json(200, { access_token: validAccess, refresh_token: validRefresh, expires_in: 3600 });
    }
    calls.push(`${init.method ?? "GET"} ${new URL(url).pathname}`);
    const authed = init.headers?.authorization === `Bearer ${validAccess}`;
    await sleep(opts.apiDelayMs?.(url) ?? 0);
    if (url.includes("/services/restservice.svc/")) {
      if (url.includes("gridOrder1")) return json(200, { info: { user_id: authed ? 100000001 : -1, basket_cnt: authed ? 3 : 0 } });
      return json(200, { user_id: authed ? 100000001 : -1, email: authed ? "user@example.test" : null });
    }
    return authed ? json(200, { ok: true }) : json(401, { message: "Unauthorized" });
  };
  return { httpFetch, log, calls, get validRefresh() { return validRefresh; } };
}

let dir: string;
let savedTokenFile: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "alza-tokens-"));
  savedTokenFile = process.env.ALZA_TOKEN_FILE;
  // Never let a test fall through to a real network fetch.
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected plain fetch in test"));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
  if (savedTokenFile === undefined) delete process.env.ALZA_TOKEN_FILE; else process.env.ALZA_TOKEN_FILE = savedTokenFile;
});

function writeStore(store: Record<string, unknown>, mode = 0o600): string {
  const file = path.join(dir, "tokens.json");
  writeFileSync(file, JSON.stringify(store, null, 2) + "\n", { mode });
  process.env.ALZA_TOKEN_FILE = file;
  return file;
}

describe("#59: an expired stored access token is refreshed for legacy account reads", () => {
  it("refreshes proactively before profile/cart/contacts when the JWT has expired", async () => {
    const expired = jwt("at-0", -120);
    writeStore({ access_token: expired, refresh_token: "rt-0", visitor_id: "visitor-test" });
    const alza = mockAlza({ initialAccess: "something-else" });
    const api = new MobileApi({ baseUrl: "https://alza.test", httpFetch: alza.httpFetch });
    const account = new MobileAccount(api);

    expect(account.status()).toMatchObject({ authenticated: true, expired: true });
    await expect(account.profile()).resolves.toMatchObject({ user_id: 100000001 });
    await expect(api.cart()).resolves.toMatchObject({ info: { user_id: 100000001, basket_cnt: 3 } });
    await expect(account.contacts()).resolves.toMatchObject({ user_id: 100000001 });
    expect(alza.log).toEqual(["refresh rt-0"]);
    // The first API request already carried the fresh token: no anonymous round-trip.
    expect(alza.calls).toEqual(["GET /services/restservice.svc/v2/getUserData", "GET /services/restservice.svc/v10/gridOrder1", "GET /services/restservice.svc/v4/contacts"]);
    const status = account.status();
    expect(status.expired).toBe(false);
    expect(Date.parse(status.expiresAt ?? "")).toBeGreaterThan(Date.now());
  });

  it("uses obtained_at + expires_in when the access token is not a JWT", async () => {
    writeStore({ access_token: "opaque-0", refresh_token: "rt-0", expires_in: 5400, obtained_at: "2026-01-01T00:00:00.000Z" });
    const alza = mockAlza({ initialAccess: "something-else" });
    const api = new MobileApi({ baseUrl: "https://alza.test", httpFetch: alza.httpFetch });
    expect(api.tokenExpiry).toEqual({ expiresAt: "2026-01-01T01:30:00.000Z", expired: true });
    await expect(api.userData()).resolves.toMatchObject({ user_id: 100000001 });
    expect(alza.log).toEqual(["refresh rt-0"]);
  });

  it("treats an anonymous (user_id -1) answer to a loaded token as a stale token: refresh once, retry the read", async () => {
    // Opaque token with no known expiry: only the anonymous shape reveals it is stale.
    writeStore({ access_token: "opaque-stale", refresh_token: "rt-0" });
    const alza = mockAlza({ initialAccess: "something-else" });
    const api = new MobileApi({ baseUrl: "https://alza.test", httpFetch: alza.httpFetch });
    await expect(api.cart()).resolves.toMatchObject({ info: { user_id: 100000001 } });
    expect(alza.log).toEqual(["refresh rt-0"]);
    expect(alza.calls).toEqual(["GET /services/restservice.svc/v10/gridOrder1", "GET /services/restservice.svc/v10/gridOrder1"]);
  });

  it("reports an error instead of anonymous data when the refresh fails", async () => {
    writeStore({ access_token: "opaque-stale", refresh_token: "rt-revoked" });
    const alza = mockAlza({ initialAccess: "something-else" });
    const api = new MobileApi({ baseUrl: "https://alza.test", httpFetch: alza.httpFetch });
    await expect(api.userData()).rejects.toThrow(AuthenticationError);
    await expect(api.userData()).rejects.toThrow(/auth_start/);
  });

  it("never replays a write that Alza answered anonymously", async () => {
    writeStore({ access_token: "opaque-stale", refresh_token: "rt-0" });
    const alza = mockAlza({ initialAccess: "something-else" });
    const api = new MobileApi({ baseUrl: "https://alza.test", httpFetch: alza.httpFetch });
    await expect(api.addByCode("RI054b1", 1)).rejects.toThrow(/NOT retried/);
    expect(alza.calls).toEqual(["POST /services/restservice.svc/v2/basket/add"]);
    // The token was still renewed, so the next read is the real account.
    await expect(api.userData()).resolves.toMatchObject({ user_id: 100000001 });
  });

  it("returns anonymous catalog data (GET and POST reads) instead of a sign-in error when the token cannot be refreshed", async () => {
    writeStore({ access_token: "opaque-stale", refresh_token: "rt-revoked" });
    const alza = mockAlza({ initialAccess: "something-else" });
    const api = new MobileApi({ baseUrl: "https://alza.test", httpFetch: alza.httpFetch });
    await expect(api.alternatives(12345)).resolves.toMatchObject({ user_id: -1 });
    await expect(api.search("monitor")).resolves.toMatchObject({ user_id: -1 });
    expect(alza.log).toEqual([]);
    expect(alza.calls).toEqual(["GET /services/restservice.svc/v1/alternatives/12345", "POST /services/restservice.svc/v5/search"]);
  });

  it("never replays a legacy GET-shaped write (addcoupon) that Alza answered anonymously", async () => {
    writeStore({ access_token: "opaque-stale", refresh_token: "rt-0" });
    const alza = mockAlza({ initialAccess: "something-else" });
    const api = new MobileApi({ baseUrl: "https://alza.test", httpFetch: alza.httpFetch });
    await expect(api.addCoupon("CODE1")).rejects.toThrow(/NOT retried/);
    expect(alza.calls).toEqual(["GET /services/restservice.svc/v1/addcoupon/CODE1"]);
  });

  it("keeps the anonymous visitor answer when no token is loaded", async () => {
    process.env.ALZA_TOKEN_FILE = "none";
    const alza = mockAlza({ initialAccess: "something-else" });
    const api = new MobileApi({ baseUrl: "https://alza.test", httpFetch: alza.httpFetch });
    await expect(api.cart()).resolves.toMatchObject({ info: { user_id: -1 } });
    expect(alza.log).toEqual([]);
  });
});

describe("#65: parallel 401s share one refresh", () => {
  it("refreshes once with a one-time refresh token and every request succeeds", async () => {
    writeStore({ access_token: "opaque-expired", refresh_token: "rt-0" });
    // c's 401 arrives after the shared refresh has finished: it must retry with
    // the new token instead of redeeming the spent rt-0.
    const alza = mockAlza({ initialAccess: "something-else", refreshDelayMs: 20, apiDelayMs: (u) => (u.endsWith("/api/c") ? 60 : 0) });
    const api = new MobileApi({ baseUrl: "https://alza.test", httpFetch: alza.httpFetch });
    const results = await Promise.allSettled([api.request("/api/a"), api.request("/api/b"), api.request("/api/c")]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
    expect(alza.log).toEqual(["refresh rt-0"]);
    expect(alza.validRefresh).toBe("rt-1");
  });
});

describe("#66: refreshed tokens are written back to ALZA_TOKEN_FILE", () => {
  it("persists atomically with mode 0600, keeping the store's other fields", async () => {
    const file = writeStore({ access_token: "opaque-expired", refresh_token: "rt-0", visitor_id: "visitor-test", scope: "openid", token_type: "Bearer" }, 0o644);
    const alza = mockAlza({ initialAccess: "something-else" });
    const api = new MobileApi({ baseUrl: "https://alza.test", httpFetch: alza.httpFetch });
    await api.request("/api/a");
    const stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(stored).toMatchObject({ refresh_token: "rt-1", expires_in: 3600, visitor_id: "visitor-test", scope: "openid", token_type: "Bearer" });
    expect(stored.access_token).toMatch(/^ey/);
    expect(Date.parse(String(stored.obtained_at))).toBeGreaterThan(Date.now() - 60_000);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["tokens.json"]);

    // A restart picks up the persisted (rotated) refresh token and needs no refresh.
    const restarted = new MobileApi({ baseUrl: "https://alza.test", httpFetch: alza.httpFetch });
    await expect(restarted.request("/api/b")).resolves.toEqual({ ok: true });
    expect(alza.log).toEqual(["refresh rt-0"]);
  });

  it("does not write the token file when it was not loaded (HTTP mode / loadTokenFile: false)", async () => {
    const file = writeStore({ access_token: "opaque-expired", refresh_token: "rt-0" });
    const before = readFileSync(file, "utf8");
    const alza = mockAlza({ initialAccess: "something-else" });
    const api = new MobileApi({ baseUrl: "https://alza.test", httpFetch: alza.httpFetch, loadTokenFile: false });
    expect(api.isAuthenticated).toBe(false);
    // Give the session a refresh token the way an in-memory sign-in would.
    (api as unknown as { refreshToken: string }).refreshToken = "rt-0";
    await expect(api.refreshAccessToken()).resolves.toBe(true);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("does not overwrite the store after an in-process sign-in replaced its session", async () => {
    const file = writeStore({ access_token: "opaque-expired", refresh_token: "rt-0" });
    const before = readFileSync(file, "utf8");
    const httpFetch: HttpFetch = async (url, init) => {
      if (url.includes("openid-configuration")) return json(200, { token_endpoint: "https://identity.test/connect/token" });
      const body = new URLSearchParams(String(init.body));
      if (body.get("grant_type") === "authorization_code") return json(200, { access_token: "other-account", refresh_token: "other-rt", expires_in: 3600 });
      return json(200, { access_token: "other-account-2", refresh_token: "other-rt-2", expires_in: 3600 });
    };
    const api = new MobileApi({ baseUrl: "https://alza.test", httpFetch });
    const start = await api.startOAuth();
    await api.exchangeOAuthCode("code-1", start.state);
    await expect(api.refreshAccessToken()).resolves.toBe(true);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("with ALZA_PERSIST_SIGNIN=1, an in-process sign-in is written to the store and survives a restart", async () => {
    const file = path.join(dir, "tokens.json");
    process.env.ALZA_TOKEN_FILE = file;
    process.env.ALZA_PERSIST_SIGNIN = "1";
    try {
      const httpFetch: HttpFetch = async (url) => {
        if (url.includes("openid-configuration")) return json(200, { token_endpoint: "https://identity.test/connect/token" });
        return json(200, { access_token: "signed-in", refresh_token: "rt-1", expires_in: 3600 });
      };
      const api = new MobileApi({ baseUrl: "https://alza.test", httpFetch });
      expect(api.isAuthenticated).toBe(false);
      const start = await api.startOAuth();
      await api.exchangeOAuthCode("code-1", start.state);
      const stored = JSON.parse(readFileSync(file, "utf8"));
      expect(stored).toMatchObject({ access_token: "signed-in", refresh_token: "rt-1", expires_in: 3600 });
      if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600); // no POSIX modes on Windows
      expect(new MobileApi({ baseUrl: "https://alza.test", httpFetch }).isAuthenticated).toBe(true);
    } finally {
      delete process.env.ALZA_PERSIST_SIGNIN;
    }
  });

  it("does not load or write anything with ALZA_TOKEN_FILE=none", async () => {
    process.env.ALZA_TOKEN_FILE = "none";
    const alza = mockAlza({ initialAccess: "something-else" });
    const api = new MobileApi({ baseUrl: "https://alza.test", httpFetch: alza.httpFetch });
    (api as unknown as { refreshToken: string }).refreshToken = "rt-0";
    await expect(api.refreshAccessToken()).resolves.toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });
});
