import { spawn } from "node:child_process";
import { proxyFromEnv } from "./proxy.js";
import { createRequire } from "node:module";
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page, type Response } from "playwright";
import { CloudflareChallengeError, UpstreamError } from "./errors.js";
import { cultureOf, resolveLocale, type Locale } from "./locale.js";
import { log } from "./logger.js";
import { loadWebSession, webSessionFile, writeBackWebSession, type WebSessionState } from "./web-session.js";

const require = createRequire(import.meta.url);

const PAGE_TIMEOUT_MS = 30_000;
export const HEADER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const DEFAULT_IDLE_BROWSER_TTL_MS = 3 * 60 * 1000;

/**
 * Throws CloudflareChallengeError when a page navigation ended on Cloudflare's
 * bot wall instead of an Alza page. Cloudflare answers a challenged request
 * with 403 (managed/JS challenge) or 503 (legacy "Just a moment…" page) and
 * marks it with the `cf-mitigated: challenge` response header (live 2026-10-11:
 * headless Chromium from a flagged IP got exactly that on every catalog URL).
 * The page title is the fallback signal for proxies that strip the header.
 * Without this check a 403 used to be swallowed as "0 results" by the catalog.
 */
export async function assertNotChallenged(res: Response | null | undefined, page: Page): Promise<void> {
  if (!res) return;
  const status = res.status();
  if (status !== 403 && status !== 503) return;
  const headers = (typeof res.headers === "function" ? res.headers() : {}) ?? {};
  const mitigated = headers["cf-mitigated"]?.toLowerCase();
  let challenged = mitigated === "challenge";
  if (!challenged && typeof page.title === "function") {
    const title = await page.title().catch(() => "");
    challenged = /just a moment|attention required|ověření|verify you are human/i.test(title);
  }
  if (!challenged && headers["server"]?.toLowerCase() === "cloudflare" && status === 403) challenged = true;
  if (challenged) {
    throw new CloudflareChallengeError(
      `Cloudflare bot challenge (HTTP ${status}${mitigated ? `, cf-mitigated: ${mitigated}` : ""}) blocked the headless browser on ${page.url()}. ` +
        "This machine's IP is being challenged by Alza's bot protection, so the catalog could not be read (this is not an empty result). " +
        "Options: retry in a few minutes, route through a residential proxy (ALZA_PROXY_URL), or attach alza-mcp-community to your own already-running Chrome (ALZA_CDP_URL), which usually passes."
    );
  }
}

/**
 * `assertNotChallenged` plus: any other 5xx, 403 or 429 becomes an UpstreamError
 * instead of being read as an Alza page. 404 is left to the caller (it means
 * "unknown product/category" or a legitimate "no results" page).
 */
export async function assertPageOk(res: Response | null | undefined, page: Page): Promise<void> {
  await assertNotChallenged(res, page);
  if (!res) return;
  const status = res.status();
  if (status >= 500 || status === 403 || status === 429) {
    throw new UpstreamError(status, `${page.url()} answered HTTP ${status} instead of a page (not an empty result). Retry later.`);
  }
}

export interface BrowserOptions {
  baseUrl?: string;
  /** Connect to an existing Chrome via CDP instead of launching Chromium. */
  cdpUrl?: string;
  /** Set false to run a visible window (debugging only). Default true. */
  headless?: boolean;
  /** Close the browser entirely after this many ms of inactivity. Default 3 min. */
  idleTtlMs?: number;
  /** Signed-in web session (see web-session.ts). Default ALZA_WEB_SESSION_FILE; null disables. */
  webSessionFile?: string | null;
}

/**
 * Lazy, idle-shutdown browser facade.
 *
 * Design notes:
 *  - The browser is launched on first use, NOT eagerly.
 *  - Pages are NOT pooled. Each `withPage` call opens a fresh page and
 *    closes it in a finally — pages accumulate DOM/JS heap across
 *    navigations and pooling them caused 1.9 GB renderer leaks.
 *  - When no calls have been made for `idleTtlMs`, the entire browser
 *    process tree is shut down. Next call relaunches.
 *  - Image/font/media/analytics traffic is blocked at the route level so
 *    every page load is just HTML + JSON-LD.
 */
export class AlzaBrowser {
  readonly locale: Locale;
  get baseUrl(): string {
    return this.locale.baseUrl;
  }
  private readonly cdpUrl?: string;
  private readonly headless: boolean;
  private readonly idleTtlMs: number;
  private readonly webSessionFile?: string;
  /** mtime of the session file the current context was created from; undefined for an anonymous context. */
  private webSessionMtimeMs?: number;
  private expired = false;

  private launching?: Promise<Browser>;
  private browser?: Browser;
  private context?: BrowserContext;
  /** Single-flight context creation: concurrent first `withPage` calls share one context. */
  private contextPromise?: Promise<BrowserContext>;
  /** Bumped whenever the browser/context is dropped, so a creation that was in flight is discarded. */
  private contextGeneration = 0;
  private idleTimer?: NodeJS.Timeout;
  private inFlight = 0;
  private closed = false;

  constructor(opts: BrowserOptions = {}) {
    this.locale = resolveLocale(opts.baseUrl);
    this.cdpUrl = opts.cdpUrl ?? process.env.ALZA_CDP_URL;
    this.headless = opts.headless ?? process.env.ALZA_HEADLESS !== "false";
    const envTtl = Number(process.env.ALZA_IDLE_TTL_MS);
    this.idleTtlMs =
      opts.idleTtlMs ?? (Number.isFinite(envTtl) && envTtl > 0 ? envTtl : DEFAULT_IDLE_BROWSER_TTL_MS);
    this.webSessionFile = opts.webSessionFile === null ? undefined : (opts.webSessionFile ?? webSessionFile());
  }

  /** True when the current context was created from the `--login` session file. */
  get webSessionLoaded(): boolean {
    return this.webSessionMtimeMs !== undefined;
  }

  /**
   * True when a session was loaded but Alza served a page as signed out (the
   * sign-in expired or was revoked): catalog prices are then public prices.
   */
  get webSessionExpired(): boolean {
    return this.expired;
  }

  /**
   * Run an async function with a fresh page. The page is opened just
   * before the callback and closed unconditionally afterward.
   */
  async withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("browser closed");

    this.cancelIdleTimer();
    this.inFlight++;
    let page: Page | undefined;
    try {
      try {
        page = await (await this.ensureContext()).newPage();
      } catch (err) {
        // The browser vanished between calls (e.g. the user restarted the Chrome we attached
        // to over CDP): drop the stale handles and retry once on a fresh connection.
        if (!/has been closed|disconnected|Target closed/i.test((err as Error)?.message ?? "")) throw err;
        log.info("alza-browser: browser went away, reconnecting");
        await this.dropBrowser();
        page = await (await this.ensureContext()).newPage();
      }
      page.setDefaultTimeout(PAGE_TIMEOUT_MS);
      page.setDefaultNavigationTimeout(PAGE_TIMEOUT_MS);
      return await fn(page);
    } finally {
      if (page && this.webSessionLoaded) await this.checkSignIn(page);
      if (page) await page.close().catch(() => {});
      this.inFlight--;
      if (this.inFlight === 0) this.scheduleIdleShutdown();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.cancelIdleTimer();
    await this.shutdownBrowser();
  }

  private async shutdownBrowser(): Promise<void> {
    const ctx = this.context;
    const browser = this.browser;
    this.context = undefined;
    this.contextPromise = undefined;
    this.contextGeneration++;
    this.browser = undefined;

    await this.saveWebSession(ctx);
    await ctx?.close().catch(() => {});

    if (this.cdpUrl) {
      // We attached to a user's Chrome — never close it.
      return;
    }
    await browser?.close().catch(() => {});
  }

  private scheduleIdleShutdown(): void {
    this.cancelIdleTimer();
    this.idleTimer = setTimeout(() => {
      log.info("alza-browser: closing idle browser", { idleMs: this.idleTtlMs });
      void this.shutdownBrowser();
    }, this.idleTtlMs);
    // Don't keep the process alive solely for this timer (matters for stdio).
    this.idleTimer.unref?.();
  }

  private cancelIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  /**
   * Alza's analytics data layer carries `pv_user_details.user_login_state`
   * ("logged_in" / "logged_out", live 2026-11-02), whatever the storefront
   * language. A page without it (not pushed yet, or not an Alza page) proves nothing.
   */
  private async checkSignIn(page: Page): Promise<void> {
    let state: unknown;
    try {
      state = await page.evaluate(
        "(window.dataLayer || []).map(function (e) { return e && e.pv_user_details && e.pv_user_details.user_login_state; }).filter(Boolean).pop() || null"
      );
    } catch {
      return;
    }
    if (state !== "logged_in" && state !== "logged_out") return;
    const expired = state === "logged_out";
    if (expired && !this.expired) {
      log.warn("web-session: Alza served the page signed out; the --login session has expired, prices are public", { file: this.webSessionFile });
    }
    this.expired = expired;
  }

  /** Persist cookies Alza refreshed during this context's life, so the sign-in does not age out. */
  private async saveWebSession(ctx: BrowserContext | undefined): Promise<void> {
    const mtimeMs = this.webSessionMtimeMs;
    this.webSessionMtimeMs = undefined;
    if (!ctx || !this.webSessionFile || mtimeMs === undefined) return;
    try {
      const state = (await ctx.storageState()) as WebSessionState;
      writeBackWebSession(this.webSessionFile, mtimeMs, state);
    } catch (err) {
      log.warn("web-session: could not save refreshed cookies", { error: (err as Error)?.message });
    }
  }

  /** Forget the current browser/context without closing anything (they are already gone). */
  private async dropBrowser(): Promise<void> {
    const ctx = this.context;
    this.context = undefined;
    this.contextPromise = undefined;
    this.contextGeneration++;
    this.browser = undefined;
    this.webSessionMtimeMs = undefined;
    await ctx?.close().catch(() => {});
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (this.browser && !this.browser.isConnected()) await this.dropBrowser();
    if (this.context) return this.context;
    if (this.contextPromise) return this.contextPromise;
    const pending = this.createContext().finally(() => {
      if (this.contextPromise === pending) this.contextPromise = undefined;
    });
    this.contextPromise = pending;
    return pending;
  }

  private async createContext(): Promise<BrowserContext> {
    const generation = this.contextGeneration;
    const browser = await this.ensureBrowser();
    // Read on every context creation, so a `--login` takes effect after the next idle shutdown.
    const session = loadWebSession(this.webSessionFile);
    const context = await browser.newContext({
      ...browserContextOptions(this.locale),
      ...(session ? { storageState: session.state as BrowserContextOptions["storageState"] } : {}),
    });

    await context.route("**/*", (route) => {
      const t = route.request().resourceType();
      if (t === "image" || t === "media" || t === "font") return route.abort();
      const url = route.request().url();
      if (
        url.includes("googletagmanager.com") ||
        url.includes("google-analytics.com") ||
        url.includes("doubleclick.net") ||
        url.includes("/api/log/")
      ) {
        return route.abort();
      }
      return route.continue();
    });

    if (generation !== this.contextGeneration) {
      // The browser was shut down or dropped while this context was being created:
      // close it rather than track a context of a stale browser (or leak it into a
      // user's Chrome over CDP). After a reconnect the message matches withPage's
      // reconnect-once retry; after close() it does not.
      await context.close().catch(() => {});
      if (this.closed) throw new Error("browser closed");
      throw new Error("browser context has been closed while it was being created");
    }
    this.context = context;
    this.webSessionMtimeMs = session?.mtimeMs;
    this.expired = false;
    if (session) log.info("alza-browser: catalog pages load signed in", { file: this.webSessionFile });
    return context;
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser) return this.browser;
    if (this.launching) return this.launching;

    this.launching = (async () => {
      if (this.cdpUrl) {
        log.info("alza-browser: connecting via CDP", { cdpUrl: this.cdpUrl });
        const browser = await chromium.connectOverCDP(this.cdpUrl);
        this.browser = browser;
        this.watchDisconnect(browser);
        return browser;
      }
      log.info("alza-browser: launching managed Chromium", { headless: this.headless });
      const browser = await this.launchChromiumWithFallback();
      this.browser = browser;
      this.watchDisconnect(browser);
      return browser;
    })().finally(() => {
      this.launching = undefined;
    });

    return this.launching;
  }

  /** External shutdown (crash, user restarted Chrome) — clear refs so the next call reconnects/relaunches. */
  private watchDisconnect(browser: Browser): void {
    browser.on("disconnected", () => {
      log.info("alza-browser: browser disconnected");
      if (this.browser !== browser) return;
      this.browser = undefined;
      this.context = undefined;
      this.contextPromise = undefined;
      this.contextGeneration++;
      this.webSessionMtimeMs = undefined;
    });
  }

  private async launchChromiumWithFallback(): Promise<Browser> {
    const proxy = proxyFromEnv();
    if (proxy) log.info("alza-browser: routing Chromium through ALZA_PROXY_URL", { server: proxy.server });
    const launchArgs = {
      headless: this.headless,
      args: [
        "--disable-blink-features=AutomationControlled",
        // Trim memory / process count.
        "--disable-dev-shm-usage",
        "--disable-extensions",
        "--no-default-browser-check",
        "--no-first-run",
      ],
      ...(proxy ? { proxy } : {}),
    };
    try {
      return await chromium.launch(launchArgs);
    } catch (err) {
      const message = (err as Error)?.message ?? "";
      const isMissingBinary =
        message.includes("Executable doesn't exist") ||
        message.includes("Looks like Playwright Test or Playwright was just installed");
      if (!isMissingBinary) throw err;

      log.info(
        "alza-browser: chromium not found — downloading headless-shell now (~92 MB, one-time). " +
          "Set ALZA_CDP_URL to skip the download and use your own Chrome."
      );
      await ensureChromiumInstalled();
      return chromium.launch(launchArgs);
    }
  }
}

/** Context options shared by the catalog browser and `--login`, so the saved session matches the browser that reuses it. */
export function browserContextOptions(locale: Locale) {
  return {
    locale: cultureOf(locale.acceptLanguage),
    userAgent: HEADER_USER_AGENT,
    viewport: { width: 1366, height: 900 },
    extraHTTPHeaders: { "accept-language": locale.acceptLanguage },
  };
}

/**
 * Downloads the Chromium headless shell via Playwright's CLI. The child's stdout is sent to our
 * stderr: on a stdio server stdout is the JSON-RPC channel, and Playwright's progress output
 * ("Downloading Chrome Headless Shell …") would corrupt it. `installer` overrides the command (tests).
 */
export async function ensureChromiumInstalled(installer?: { command: string; args: string[] }): Promise<void> {
  let cliPath = "";
  if (!installer) try {
    const path = await import("node:path");
    const pkgJsonPath = require.resolve("playwright/package.json");
    cliPath = path.join(path.dirname(pkgJsonPath), "cli.js");
  } catch (err) {
    throw new Error(
      "Cannot find Playwright CLI. Run `npm install playwright` and retry.",
      { cause: err as Error }
    );
  }
  await new Promise<void>((resolve, reject) => {
    const command = installer?.command ?? process.execPath;
    const args = installer?.args ?? [cliPath, "install", "chromium", "--only-shell"];
    const child = spawn(command, args, { stdio: ["ignore", 2, 2] });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `Failed to install Chromium (exit ${code}). Try \`npx playwright install chromium --only-shell\` manually.`
          )
        );
    });
  });
}
