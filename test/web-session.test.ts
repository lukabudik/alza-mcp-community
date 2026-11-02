import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SESSION = { cookies: [{ name: "auth", value: "old", domain: ".alza.cz", path: "/" }], origins: [] };
const REFRESHED = { cookies: [{ name: "auth", value: "new", domain: ".alza.cz", path: "/" }], origins: [] };

const contexts: Array<{ options: Record<string, unknown>; closed: boolean }> = [];
/** What the fake page's data layer reports as `user_login_state`. */
let loginState: string | null = "logged_in";
vi.mock("playwright", () => ({
  chromium: {
    launch: vi.fn(async () => ({
      on() {},
      isConnected: () => true,
      async newContext(options: Record<string, unknown>) {
        const ctx = {
          options,
          closed: false,
          async route() {},
          async newPage() {
            return {
              setDefaultTimeout() {},
              setDefaultNavigationTimeout() {},
              async evaluate() {
                return loginState;
              },
              async close() {},
            };
          },
          async storageState() {
            return REFRESHED;
          },
          async close() {
            ctx.closed = true;
          },
        };
        contexts.push(ctx);
        return ctx;
      },
      async close() {},
    })),
  },
}));

const { AlzaBrowser } = await import("../src/infra/browser.js");
const { loadWebSession, webSessionFile, writeBackWebSession } = await import("../src/infra/web-session.js");
const { SIGNED_OUT_NOTE, withSignedOutNote } = await import("../src/server.js");

describe("signed-in web session", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    contexts.length = 0;
    loginState = "logged_in";
    dir = mkdtempSync(join(tmpdir(), "alza-web-session-"));
    file = join(dir, "web-session.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("ALZA_WEB_SESSION_FILE=none disables it; unset falls back to ~/.alza-mcp", () => {
    vi.stubEnv("ALZA_WEB_SESSION_FILE", "none");
    expect(webSessionFile()).toBeUndefined();
    vi.stubEnv("ALZA_WEB_SESSION_FILE", "");
    expect(webSessionFile()).toMatch(/[\\/]\.alza-mcp[\\/]web-session\.json$/);
    vi.unstubAllEnvs();
  });

  it("ignores a missing or malformed file", () => {
    expect(loadWebSession(file)).toBeUndefined();
    writeFileSync(file, "{\"cookies\": 1}");
    expect(loadWebSession(file)).toBeUndefined();
  });

  it("starts catalog contexts from the saved session and writes refreshed cookies back on close", async () => {
    writeFileSync(file, JSON.stringify(SESSION));
    const b = new AlzaBrowser({ webSessionFile: file, idleTtlMs: 60_000 });
    await b.withPage(async () => {});
    expect(contexts[0]!.options.storageState).toEqual(SESSION);
    expect(b.webSessionLoaded).toBe(true);
    await b.close();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(REFRESHED);
  });

  it("stays anonymous without a session file and never creates one", async () => {
    const b = new AlzaBrowser({ webSessionFile: file, idleTtlMs: 60_000 });
    await b.withPage(async () => {});
    expect(contexts[0]!.options.storageState).toBeUndefined();
    expect(b.webSessionLoaded).toBe(false);
    await b.close();
    expect(loadWebSession(file)).toBeUndefined();
  });

  it("does not overwrite a session that --login replaced meanwhile", () => {
    writeFileSync(file, JSON.stringify(SESSION));
    const loaded = loadWebSession(file)!;
    writeFileSync(file, JSON.stringify(SESSION));
    utimesSync(file, new Date(), new Date(loaded.mtimeMs + 5_000));
    expect(writeBackWebSession(file, loaded.mtimeMs, REFRESHED)).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(SESSION);
  });

  it("flags the session expired when Alza serves a page signed out, and clears it when signed in again", async () => {
    writeFileSync(file, JSON.stringify(SESSION));
    const b = new AlzaBrowser({ webSessionFile: file, idleTtlMs: 60_000 });
    await b.withPage(async () => {});
    expect(b.webSessionExpired).toBe(false);
    loginState = "logged_out";
    await b.withPage(async () => {});
    expect(b.webSessionExpired).toBe(true);
    loginState = null; // data layer not pushed yet: proves nothing either way
    await b.withPage(async () => {});
    expect(b.webSessionExpired).toBe(true);
    loginState = "logged_in";
    await b.withPage(async () => {});
    expect(b.webSessionExpired).toBe(false);
    await b.close();
  });

  it("never reports an anonymous browser as expired", async () => {
    loginState = "logged_out";
    const b = new AlzaBrowser({ webSessionFile: file, idleTtlMs: 60_000 });
    await b.withPage(async () => {});
    expect(b.webSessionExpired).toBe(false);
    await b.close();
  });
});

describe("withSignedOutNote", () => {
  const res = { content: [{ type: "text" as const, text: "3 products" }], structuredContent: { products: [] } };

  it("appends the note to price-bearing results while the session is expired, cached answers included", () => {
    expect(withSignedOutNote("search_products", res, true).content.map((c) => c.text)).toEqual(["3 products", SIGNED_OUT_NOTE]);
    expect(withSignedOutNote("search_products", res, false)).toBe(res);
  });

  it("leaves tools without catalog prices, errors and structuredContent alone", () => {
    expect(withSignedOutNote("find_pickup_points", res, true)).toBe(res);
    expect(withSignedOutNote("cart", res, true)).toBe(res);
    const err = { ...res, isError: true };
    expect(withSignedOutNote("get_product", err, true)).toBe(err);
    expect(withSignedOutNote("get_product", res, true).structuredContent).toBe(res.structuredContent);
  });
});
