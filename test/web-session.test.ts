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
              async goto() {
                return null;
              },
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
const { loadWebSession, loginCommand, webSessionFile, writeBackWebSession } = await import("../src/infra/web-session.js");
const { signedOutNote, withPriceScope } = await import("../src/server.js");

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

describe("sign-in state across browser restarts and --login", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    contexts.length = 0;
    loginState = "logged_in";
    dir = mkdtempSync(join(tmpdir(), "alza-web-session-"));
    file = join(dir, "web-session.json");
    writeFileSync(file, JSON.stringify(SESSION));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Simulates the idle shutdown (cookies saved back) without closing the facade for good. */
  async function idleShutdown(b: InstanceType<typeof AlzaBrowser>): Promise<void> {
    await (b as unknown as { shutdownBrowser(): Promise<void> }).shutdownBrowser();
  }

  it("keeps an expired state across an idle shutdown, so cached answers still carry it", async () => {
    loginState = "logged_out";
    const b = new AlzaBrowser({ webSessionFile: file, idleTtlMs: 60_000 });
    await b.withPage(async () => {});
    expect(b.signInState).toBe("signed_out");
    await idleShutdown(b);
    expect(b.signInState).toBe("signed_out");
    expect(b.webSessionExpired).toBe(true);
    await b.close();
  });

  it("does not save the cookies of a signed-out session back to the file", async () => {
    loginState = "logged_out";
    const before = readFileSync(file, "utf8");
    const b = new AlzaBrowser({ webSessionFile: file, idleTtlMs: 60_000 });
    await b.withPage(async () => {});
    await b.close();
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("treats its own write-back as the same session, and a new --login as a new one", async () => {
    const changes = vi.fn();
    const b = new AlzaBrowser({ webSessionFile: file, idleTtlMs: 60_000 });
    b.onSignInChange(changes);
    await b.withPage(async () => {});
    expect(b.signInState).toBe("signed_in");
    await idleShutdown(b); // writes REFRESHED back
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(REFRESHED);
    expect(b.signInState).toBe("signed_in");
    const calls = changes.mock.calls.length;

    // --login replaces the file while a context from the old one is open.
    await b.withPage(async () => {});
    writeFileSync(file, JSON.stringify(SESSION));
    utimesSync(file, new Date(), new Date(Date.now() + 10_000));
    loginState = null; // the next page does not report a state
    await b.withPage(async () => {});
    expect(contexts.at(-2)!.closed).toBe(true); // the old context was dropped right away
    expect(contexts.at(-1)!.options.storageState).toEqual(SESSION);
    expect(b.signInState).toBeUndefined();
    expect(changes.mock.calls.length).toBeGreaterThan(calls);
    await b.close();
  });

  it("notifies listeners when the sign-in expires, so cached catalog prices are dropped", async () => {
    const changes = vi.fn();
    const b = new AlzaBrowser({ webSessionFile: file, idleTtlMs: 60_000 });
    b.onSignInChange(changes);
    await b.withPage(async () => {});
    const calls = changes.mock.calls.length;
    await b.withPage(async () => {});
    expect(changes.mock.calls.length).toBe(calls); // same state: no change
    loginState = "logged_out";
    await b.withPage(async () => {});
    expect(changes.mock.calls.length).toBe(calls + 1);
    await b.close();
  });

  it("reports the session state for account_status, checking it once when unknown", async () => {
    expect(await new AlzaBrowser({ webSessionFile: null }).webSessionStatus()).toEqual({ state: "disabled" });
    expect(await new AlzaBrowser({ webSessionFile: join(dir, "missing.json") }).webSessionStatus()).toEqual({ state: "absent" });
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{}");
    expect((await new AlzaBrowser({ webSessionFile: bad }).webSessionStatus()).state).toBe("unreadable");

    loginState = "logged_out";
    const b = new AlzaBrowser({ webSessionFile: file, idleTtlMs: 60_000 });
    expect((await b.webSessionStatus()).state).toBe("unknown");
    expect(contexts).toHaveLength(0); // no check without `check`
    const checked = await b.webSessionStatus({ check: true });
    expect(checked).toMatchObject({ state: "signed_out" });
    expect(checked.savedAt).toMatch(/^\d{4}-/);
    expect(checked.checkedAt).toMatch(/^\d{4}-/);
    await b.close();
  });
});

describe("withPriceScope", () => {
  const res = { content: [{ type: "text" as const, text: "3 products" }], structuredContent: { products: [] } };
  const cmd = "node /x/dist/index.js --login";

  it("marks results signed in with the account's prices", () => {
    const out = withPriceScope("search_products", res, "signed_in", cmd);
    expect(out.structuredContent).toEqual({ products: [], signedIn: true, priceScope: "account" });
    expect(out.content).toBe(res.content);
  });

  it("puts a warning first and the login command in structuredContent once the sign-in expired, cached answers included", () => {
    const out = withPriceScope("get_product", res, "signed_out", cmd);
    expect(out.content.map((c) => c.text)).toEqual([signedOutNote(cmd), "3 products"]);
    expect(out.content[0]!.text).toContain(cmd);
    expect(out.structuredContent).toEqual({ products: [], signedIn: false, priceScope: "public", loginCommand: cmd });
  });

  it("leaves anonymous catalogs, tools without catalog prices and errors alone", () => {
    expect(withPriceScope("search_products", res, undefined, cmd)).toBe(res);
    expect(withPriceScope("find_pickup_points", res, "signed_out", cmd)).toBe(res);
    expect(withPriceScope("cart", res, "signed_out", cmd)).toBe(res);
    const err = { ...res, isError: true };
    expect(withPriceScope("get_product", err, "signed_out", cmd)).toBe(err);
  });
});

describe("loginCommand", () => {
  it("points a local checkout at its own dist/index.js", () => {
    expect(loginCommand("/home/u/alza-mcp-community/dist/index.js")).toBe("node /home/u/alza-mcp-community/dist/index.js --login");
    expect(loginCommand(String.raw`D:\projects\alza mcp\dist\index.js`)).toBe(String.raw`node "D:\projects\alza mcp\dist\index.js" --login`);
  });

  it("uses the package name for npm/npx installs and unknown launchers", () => {
    expect(loginCommand("/home/u/.npm/_npx/abc/node_modules/alza-mcp-community/dist/index.js")).toBe("npx -y alza-mcp-community --login");
    expect(loginCommand("/usr/lib/node_modules/alza-mcp-community/dist/index.js")).toBe("npx -y alza-mcp-community --login");
    expect(loginCommand(undefined)).toBe("npx -y alza-mcp-community --login");
  });
});
