import { randomBytes, createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Page } from "playwright";
import { AppActionExecutor, type ExecuteAppActionOptions, type FetchLike, type ServerAppAction } from "./app-action.js";
import { AlzaError, AuthenticationError, ConfigurationError, OutcomeUnknownError, UserError } from "./errors.js";
import { TransportUnavailableError } from "./impersonate-transport.js";
import { cultureOf, findLocale, type Locale } from "./locale.js";
import { log } from "./logger.js";
import { proxyConfigured } from "./proxy.js";

export interface MobileApiOptions {
  baseUrl?: string;
  /** Storefront whose `country` query field and Accept-Language the API sends.
   * The webapi/chatbotapi hosts are shared by every storefront and pick the
   * shop from `country` (live-verified 2026-10-12: `country=SK` answers with
   * `eshopUrl=https://www.alza.sk/`). Default: the locale of `baseUrl`, else CZ. */
  locale?: Pick<Locale, "countryCode" | "acceptLanguage">;
  visitorId?: string;
  userId?: number;
  /** Structural browser-page host (satisfied by AlzaBrowser). When wired, same-origin
   * routes that hit the www/webapi bot wall (403 + challenge HTML) are retried via an
   * in-page fetch, which is the transport the Alza app itself uses. */
  browser?: BrowserPageHost;
  /**
   * Chrome-fingerprint HTTP transport (scripts/cf-transport.py via
   * ImpersonateTransport). Tried FIRST for every request: it carries a
   * Chrome-like TLS/HTTP2/header fingerprint, which Alza's Cloudflare edge
   * accepts (verified 2026-09-15), so most routes no longer need a browser.
   * On failure the existing chain (plain fetch → browser fallback) applies.
   */
  httpFetch?: HttpFetch;
  /**
   * fetch-shaped implementation for the server-provided AppAction executor
   * (same CF sidecar as `httpFetch`, so action execution shares the
   * fingerprint). Falls back to global fetch when absent.
   */
  fetchImpl?: FetchLike;
  /**
   * Auto-load the OAuth token store (ALZA_TOKEN_FILE). Default true (stdio,
   * single user). The Streamable HTTP transport passes false unless the
   * operator explicitly opts in, because the store is single-user by design
   * and must never be shared by every session of a multi-user host.
   * Tokens refreshed in-process are written back to the same file (atomic,
   * mode 0600) only when they were loaded from it — never with
   * ALZA_TOKEN_FILE=none or `loadTokenFile: false`.
   */
  loadTokenFile?: boolean;
}

/** fetch-shaped transport (the sidecar adapter satisfies this). */
export interface HttpFetch {
  (url: string, init: { method?: string; headers?: Record<string, string>; body?: string | null; redirect?: "follow" | "manual" }): Promise<{
    status: number;
    text(): Promise<string>;
    /** Binary-safe body (the CF sidecar adapter provides this). */
    arrayBuffer?(): Promise<ArrayBuffer>;
    /** Response header lookup (case-insensitive name). */
    header?(name: string): string | null;
  }>;
}

/** Minimal structural view of AlzaBrowser — keeps playwright out of this module's runtime. */
export interface BrowserPageHost {
  withPage<T>(fn: (page: Page) => Promise<T>): Promise<T>;
}

export interface OAuthStart {
  authorizationUrl: string;
  state: string;
}

interface OidcDiscovery {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  jwks_uri?: string;
  grant_types_supported?: string[];
  code_challenge_methods_supported?: string[];
}

const DEFAULT_API_LOCALE = { countryCode: "CZ", acceptLanguage: "cs-CZ,cs;q=0.9,en;q=0.8" };

/** `country` for the account writes (2FA, phone, email, account deletion, watchdog
 * create/delete, basket unlock). They are live-verified on CZ only, so they keep the
 * pre-locale value on every storefront until someone verifies them elsewhere;
 * reads follow the storefront (`MobileApi.country`). */
const ACCOUNT_WRITE_COUNTRY = "CZ";

export class MobileApi {
  /** Alza host family allowed for server-provided document downloads (OR10).
   * Live invoices serve from `pdf.alza.cz`; the API hosts are www/m/webapi/api. */
  static readonly DOCUMENT_HOSTS = new Set(["alza.cz", "www.alza.cz", "m.alza.cz", "webapi.alza.cz", "api.alza.cz", "pdf.alza.cz"]);

  readonly baseUrl: string;
  /** Upper-case storefront country sent as the `country` query field (CZ, SK, …). */
  readonly country: string;
  private readonly acceptLanguage: string;
  readonly visitorId: string;
  readonly userId?: number;
  private readonly browser?: BrowserPageHost;
  private readonly httpFetch?: HttpFetch;
  private readonly fetchImpl?: FetchLike;
  private accessToken?: string;
  private refreshToken?: string;
  /** Access-token expiry (epoch ms) from the JWT `exp`, else `expires_in`. */
  private accessTokenExpiresAt?: number;
  /** Shared in-flight refresh: parallel 401s must not each spend the refresh token. */
  private refreshing?: Promise<boolean>;
  /** Refresh token whose last refresh failed — no proactive retries with it. */
  private failedRefreshToken?: string;
  /** Token store the current tokens came from; refreshed tokens are written back here. */
  private tokenFile?: string;
  private persistQueue: Promise<void> = Promise.resolve();
  private pendingOAuth?: OAuthStart;
  private pendingCodeVerifier?: string;
  private oidc?: OidcDiscovery;

  get isAuthenticated(): boolean {
    return Boolean(this.accessToken);
  }

  /** Expiry of the loaded access token, when known. `expired` includes the
   * refresh skew, i.e. it is true when the next request refreshes first. */
  get tokenExpiry(): { expiresAt?: string; expired?: boolean } {
    if (!this.accessToken || this.accessTokenExpiresAt === undefined) return {};
    return { expiresAt: new Date(this.accessTokenExpiresAt).toISOString(), expired: this.accessTokenExpired() };
  }

  private accessTokenExpired(): boolean {
    return this.accessTokenExpiresAt !== undefined && Date.now() >= this.accessTokenExpiresAt - TOKEN_EXPIRY_SKEW_MS;
  }

  constructor(opts: MobileApiOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.ALZA_API_BASE_URL ?? "https://www.alza.cz").replace(/\/$/, "");
    const locale = opts.locale ?? findLocale(this.baseUrl) ?? DEFAULT_API_LOCALE;
    this.country = locale.countryCode.toUpperCase();
    this.acceptLanguage = locale.acceptLanguage;
    this.browser = opts.browser;
    this.httpFetch = opts.httpFetch;
    this.fetchImpl = opts.fetchImpl;
    const loaded = opts.loadTokenFile === false ? undefined : MobileApi.readStoredTokens();
    const stored = loaded?.tokens;
    const explicitVisitor = opts.visitorId ?? process.env.ALZA_VISITOR_ID;
    this.visitorId = explicitVisitor ?? stored?.visitor_id ?? randomUUID();
    this.userId = opts.userId;
    if (stored?.access_token) {
      this.accessToken = stored.access_token;
      this.accessTokenExpiresAt = jwtExpiryMs(stored.access_token) ?? storedExpiryMs(stored);
    }
    if (stored?.refresh_token) this.refreshToken = stored.refresh_token;
    if (loaded && (stored?.access_token || stored?.refresh_token)) this.tokenFile = loaded.file;
  }

  /** Read an OAuth token stored by `scripts/alza-auth-login*` (ALZA_TOKEN_FILE, default ~/.alza-mcp/tokens.json).
   * Set ALZA_TOKEN_FILE=none to opt out. */
  private static tokenStorePath(): string | undefined {
    if (process.env.ALZA_TOKEN_FILE === "none") return undefined;
    return process.env.ALZA_TOKEN_FILE ?? join(homedir(), ".alza-mcp", "tokens.json");
  }

  private static readStoredTokens(): { file: string; tokens: StoredTokens } | undefined {
    const file = MobileApi.tokenStorePath();
    if (!file) return undefined;
    try {
      const tokens = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) return undefined;
      return { file, tokens: tokens as StoredTokens };
    } catch { return undefined; /* no readable token store — remain unauthenticated */ }
  }

  /** Write refreshed tokens back to the store they were loaded from, so a restart
   * does not begin with an expired access token (or a spent refresh token, if the
   * IdP rotates it). Atomic: a temp file created 0600 in the same directory is
   * renamed over the store. Other fields in the store (scope, token_type, …) are
   * kept. Failures are logged, never thrown — the in-memory session still works. */
  private persistTokens(expiresIn: number | undefined): Promise<void> {
    const file = this.tokenFile;
    if (!file || !this.accessToken) return Promise.resolve();
    const update: StoredTokens = {
      access_token: this.accessToken,
      ...(this.refreshToken ? { refresh_token: this.refreshToken } : {}),
      ...(expiresIn !== undefined ? { expires_in: expiresIn } : {}),
      obtained_at: new Date().toISOString(),
    };
    const write = async () => {
      let existing: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>;
      } catch { /* missing or unreadable store — write a fresh one */ }
      const next = { ...existing, ...update, visitor_id: typeof existing.visitor_id === "string" ? existing.visitor_id : this.visitorId };
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        await writeFile(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600, flag: "wx" });
        await chmod(tmp, 0o600);
        await rename(tmp, file);
      } catch (err) {
        await rm(tmp, { force: true });
        throw err;
      }
    };
    // Serialise writes so an older refresh can never land after a newer one.
    this.persistQueue = this.persistQueue.then(write).catch((err: unknown) => {
      log.warn("mobile-api: could not persist refreshed tokens to the token store", { error: String(err) });
    });
    return this.persistQueue;
  }

  /** identity.alza.cz sits behind the same Cloudflare bot wall as www/webapi, so the
   * OAuth endpoints need the Chrome-fingerprint transport too — a plain fetch gets a
   * 403 managed challenge and authentication can never start. Normalises the sidecar
   * reply to the `{ok, status, json}` shape the OAuth callers already expect. */
  private async oauthFetch(
    url: string,
    init: { method?: string; headers?: Headers | Record<string, string>; body?: string } = {},
  ): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> {
    if (!this.httpFetch) {
      assertDirectFetchAllowed("OAuth");
      return fetch(url, init as RequestInit);
    }
    const headers: Record<string, string> = {};
    if (init.headers instanceof Headers) {
      for (const [k, v] of init.headers.entries()) headers[k] = v;
    } else if (init.headers) {
      Object.assign(headers, init.headers);
    }
    try {
      const res = await this.httpFetch(url, { method: init.method ?? "GET", headers, body: init.body ?? null });
      const text = await res.text();
      return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => JSON.parse(text) as unknown };
    } catch (err) {
      // Same contract as performRequest: the sidecar is optional (no python3 / curl_cffi,
      // or it died), so a transport failure degrades to plain fetch instead of failing auth —
      // unless the request may already have been sent (token POSTs are single-use) or a
      // proxy is configured (plain fetch would bypass it).
      this.assertFallbackAllowed(init.method ?? "GET", url, err);
      if (proxyConfigured()) throw proxyBypassRefused(err);
      log.warn("mobile-api: cf transport failed for OAuth, falling back", { url, error: String(err) });
      return fetch(url, init as RequestInit);
    }
  }

  async discovery(): Promise<OidcDiscovery> {
    if (this.oidc) return this.oidc;
    const authority = process.env.ALZA_OAUTH_AUTHORITY ?? "https://identity.alza.cz";
    const response = await this.oauthFetch(`${authority}/.well-known/openid-configuration`, { headers: { accept: "application/json", "user-agent": "Alza/2026.15.0 (Android)", "accept-language": this.acceptLanguage, "x-correlation-id": randomUUID(), "Balancer-Guid": this.visitorId } });
    if (!response.ok) {
      // Best-effort, matching scripts/alza-auth-login.mjs: the only values taken from
      // discovery are the authorize and token endpoints, and both callers already carry
      // the APK defaults. Throwing here made those fallbacks unreachable, so a
      // challenged discovery GET killed the whole flow instead of degrading.
      log.warn("OAuth discovery failed; falling back to APK default endpoints", { status: response.status });
      return {};
    }
    this.oidc = await response.json() as OidcDiscovery;
    return this.oidc;
  }

  async startOAuth(): Promise<OAuthStart> {
    const discovery = await this.discovery();
    const verifier = base64Url(randomBytes(32));
    const state = base64Url(randomBytes(32));
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    const params = new URLSearchParams({
      client_id: process.env.ALZA_OAUTH_CLIENT_ID ?? "alza_Android",
      response_type: "code",
      scope: "email openid profile alza offline_access",
      redirect_uri: process.env.ALZA_OAUTH_REDIRECT_URI ?? "alza://identity",
      code_challenge_method: "S256",
      code_challenge: challenge,
      state,
      nonce: base64Url(randomBytes(32)),
      countryCode: process.env.ALZA_COUNTRY ?? this.country,
      culture: process.env.ALZA_CULTURE ?? cultureOf(this.acceptLanguage),
    });
    const authorizationEndpoint = discovery.authorization_endpoint ?? "https://identity.alza.cz/connect/authorize";
    const out = { authorizationUrl: `${authorizationEndpoint}?${params}`, state };
    this.pendingOAuth = out;
    this.pendingCodeVerifier = verifier;
    return out;
  }

  /** The default `alza_Android` OAuth client is confidential: the token endpoint
   * rejects requests without the APK-embedded client secret (HTTP 400 invalid_client).
   * The default value is source-verified (decoded from the decompiled APK — see
   * scripts/alza-client-secret.mjs) and live-verified against /connect/token.
   * Set ALZA_OAUTH_CLIENT_SECRET to another value (or "" to omit it for public
   * clients) when using ALZA_OAUTH_CLIENT_ID with a different client. */
  private static clientSecret(): string | undefined {
    const v = process.env.ALZA_OAUTH_CLIENT_SECRET ?? "ZRtjXCjaYFmUbGNvbTK25uctj4nQRT6a";
    return v === "" ? undefined : v;
  }

  /** Accepts either a bare authorization code or the whole `alza://identity?code=…&state=…`
   * redirect. Desktop browsers cannot open the `alza://` scheme, so users copy that URL out of
   * DevTools; pasting it as-is avoids a manual split. A state inside the URL must agree with
   * an explicitly passed one. */
  static parseOAuthRedirect(codeOrUrl: string, state?: string): { code: string; state?: string } {
    const raw = codeOrUrl.trim();
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !raw.includes("code=")) return { code: raw, state };
    const query = new URLSearchParams(raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : raw);
    const code = query.get("code");
    if (!code) throw new Error("The pasted redirect URL does not contain a `code` parameter");
    const urlState = query.get("state") ?? undefined;
    if (state && urlState && state !== urlState) throw new Error("OAuth state in the redirect URL does not match the `state` argument");
    return { code, state: state ?? urlState };
  }

  async exchangeOAuthCode(codeOrUrl: string, explicitState?: string): Promise<{ authenticated: true; expiresIn?: number }> {
    const { code, state } = MobileApi.parseOAuthRedirect(codeOrUrl, explicitState);
    const pending = this.pendingOAuth;
    if (!pending || pending.state !== state) throw new Error("OAuth state is missing or does not match");
    const verifier = this.pendingCodeVerifier;
    if (!verifier) throw new Error("OAuth PKCE verifier is missing; start authentication again");
    const discovery = await this.discovery();
    const tokenEndpoint = discovery.token_endpoint ?? "https://identity.alza.cz/connect/token";
    const secret = MobileApi.clientSecret();
    const body = new URLSearchParams({ grant_type: "authorization_code", client_id: process.env.ALZA_OAUTH_CLIENT_ID ?? "alza_Android", code, redirect_uri: process.env.ALZA_OAUTH_REDIRECT_URI ?? "alza://identity", code_verifier: verifier, ...(secret ? { client_secret: secret } : {}) });
    const res = await this.oauthFetch(tokenEndpoint, { method: "POST", headers: this.mobileHeaders({ "content-type": "application/x-www-form-urlencoded", accept: "application/json" }), body: body.toString() });
    if (!res.ok) throw new Error(`OAuth token exchange failed with HTTP ${res.status}`);
    const json = await res.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error("OAuth response did not contain an access token");
    this.accessToken = json.access_token;
    this.refreshToken = json.refresh_token;
    this.accessTokenExpiresAt = expiryFrom(json.access_token, json.expires_in);
    // A new in-process sign-in (possibly another account) is not written over the
    // token store this process loaded; only that store's own session is persisted.
    // ALZA_PERSIST_SIGNIN=1 opts in: the operator signs in through this process (e.g.
    // a long-lived remote deployment) and the store is where that session belongs.
    this.tokenFile = process.env.ALZA_PERSIST_SIGNIN === "1" ? MobileApi.tokenStorePath() : undefined;
    this.pendingOAuth = undefined;
    this.pendingCodeVerifier = undefined;
    await this.persistTokens(json.expires_in);
    return { authenticated: true, expiresIn: json.expires_in };
  }

  /** Refresh the access token. Concurrent callers share one in-flight refresh,
   * so parallel 401s spend the refresh token once (it may be one-time-use). */
  async refreshAccessToken(): Promise<boolean> {
    if (!this.refreshing) {
      this.refreshing = this.doRefreshAccessToken().finally(() => { this.refreshing = undefined; });
    }
    return this.refreshing;
  }

  private async doRefreshAccessToken(): Promise<boolean> {
    const used = this.refreshToken;
    if (!used) return false;
    const ok = await this.redeemRefreshToken(used);
    this.failedRefreshToken = ok ? undefined : used;
    return ok;
  }

  private async redeemRefreshToken(refreshToken: string): Promise<boolean> {
    const discovery = await this.discovery();
    const tokenEndpoint = discovery.token_endpoint ?? "https://identity.alza.cz/connect/token";
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: process.env.ALZA_OAUTH_CLIENT_ID ?? "alza_Android",
      refresh_token: refreshToken,
      ...(MobileApi.clientSecret() ? { client_secret: MobileApi.clientSecret()! } : {}),
    });
    const res = await this.oauthFetch(tokenEndpoint, { method: "POST", headers: this.mobileHeaders({ "content-type": "application/x-www-form-urlencoded", accept: "application/json" }), body: body.toString() });
    if (!res.ok) return false;
    const json = await res.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!json.access_token) return false;
    this.accessToken = json.access_token;
    this.refreshToken = json.refresh_token ?? this.refreshToken;
    this.accessTokenExpiresAt = expiryFrom(json.access_token, json.expires_in);
    await this.persistTokens(json.expires_in);
    return true;
  }

  /** Refresh before sending when the loaded access token is expired or about to
   * be: the legacy restservice routes answer an expired token with HTTP 200 and an
   * anonymous envelope instead of 401, so waiting for a 401 is not enough. A
   * refresh token that already failed is not retried proactively. */
  private async ensureFreshAccessToken(): Promise<void> {
    if (!this.accessToken || !this.refreshToken || !this.accessTokenExpired()) return;
    if (this.failedRefreshToken === this.refreshToken) return;
    try {
      await this.refreshAccessToken();
    } catch (err) {
      log.warn("mobile-api: proactive token refresh failed", { error: String(err) });
    }
  }

  /** May a sidecar failure be retried over another transport? Only idempotent
   * GET/HEAD requests, or requests that provably never left this process
   * (TransportUnavailableError). Anything else may already have reached Alza —
   * replaying it could pay, order or delete twice. */
  private assertFallbackAllowed(method: string, url: string, err: unknown): void {
    if (isReplaySafe(method, url) || isPreSendFailure(err)) return;
    throw new OutcomeUnknownError(method.toUpperCase(), displayTarget(url), err);
  }

  async request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    // Absolute URLs (cross-host families like chatbotapi.alza.cz, row W18) bypass the base.
    const url = /^https?:\/\//.test(path) ? path : `${this.baseUrl}${path}`;
    const method = init.method ?? "GET";
    const body = init.body == null ? null : String(init.body);
    const freshHeaders = () => Object.fromEntries(this.mobileHeaders(init.headers as unknown as Headers).entries());

    await this.ensureFreshAccessToken();
    const send = async () => {
      const sentWith = this.accessToken;
      const raw = await this.performRequest(url, method, body, init, freshHeaders);
      let value: unknown;
      try { value = raw.text ? JSON.parse(raw.text) : null; } catch { value = raw.text; }
      if (raw.status < 200 || raw.status >= 300) {
        throw apiHttpFailure(method, url, raw.status, value);
      }
      return { value, sentWith };
    };
    const first = await send();
    let value = first.value;
    if (first.sentWith && isLegacyRestRoute(url) && !LEGACY_CATALOG_READ_ROUTE.test(url) && isAnonymousEnvelope(value)) {
      // The legacy restservice routes answer a stale token with 200 + user_id -1
      // instead of 401. Renew the token (or pick up one a parallel request already
      // renewed), then retry reads once; never replay a write.
      const renewed = this.accessToken !== first.sentWith || (Boolean(this.refreshToken) && (await this.refreshAccessToken()));
      if (!isReplaySafe(method, url)) {
        throw new AuthenticationError(
          `Alza answered ${method} ${path} as an anonymous visitor (user_id -1) although an access token is loaded; the token ${renewed ? "has now been refreshed" : "could not be refreshed"}. ` +
            "The request was NOT retried. It may have been applied to the anonymous visitor basket instead of the account — check `cart` before retrying." +
            (renewed ? "" : " Sign in again with `auth_start` → `auth_exchange`."),
        );
      }
      if (!renewed) {
        throw new AuthenticationError(`Alza answered ${path} as an anonymous visitor (user_id -1): the loaded access token is expired or rejected and could not be refreshed. Sign in again with \`auth_start\` → \`auth_exchange\`.`);
      }
      value = (await send()).value;
      if (isAnonymousEnvelope(value)) {
        throw new AuthenticationError(`Alza still answered ${path} as an anonymous visitor (user_id -1) after the access token was refreshed. Sign in again with \`auth_start\` → \`auth_exchange\`.`);
      }
    }
    return value as T;
  }

  /** Transport order: Chrome-fingerprint sidecar (bypasses the Cloudflare bot
   * wall, no browser needed) → plain fetch → in-page browser fetch (last
   * resort; the wall's JS has already run in that context). A 401 triggers a
   * token refresh + retry within the same transport.
   *
   * A sidecar failure falls back only when that cannot duplicate a side effect
   * (see assertFallbackAllowed). With ALZA_PROXY_URL set, the un-proxied plain
   * fetch is skipped: the (proxied) browser is the only fallback. */
  private async performRequest(
    url: string,
    method: string,
    body: string | null,
    init: RequestInit,
    freshHeaders: () => Record<string, string>,
  ): Promise<RawHttp> {
    const doOnce = async (kind: "cf" | "plain", h: Record<string, string>): Promise<{ status: number; text: string }> => {
      if (kind === "cf" && this.httpFetch) {
        const r = await this.httpFetch(url, { method, headers: h, body });
        return { status: r.status, text: await r.text() };
      }
      const r = await fetch(url, { method, headers: h, body });
      return { status: r.status, text: await r.text() };
    };

    const withRefresh = async (kind: "cf" | "plain") => {
      const sentWith = this.accessToken;
      let raw = await doOnce(kind, freshHeaders());
      if (raw.status === 401 && this.refreshToken) {
        // Another request may have refreshed while this one was in flight: retry
        // with that token instead of spending the refresh token again.
        const renewed = (this.accessToken !== undefined && this.accessToken !== sentWith) || (await this.refreshAccessToken());
        if (renewed) raw = await doOnce(kind, freshHeaders());
      }
      return raw;
    };

    let cfAnswer: { status: number; text: string } | undefined;
    let cfError: unknown;
    if (this.httpFetch) {
      try {
        const raw = await withRefresh("cf");
        // Bot-wall despite the fingerprint, or a real API answer: only the
        // wall deserves the browser retry (same semantics as before).
        if (!this.isBotChallenge(raw.status, raw.text)) return { ...raw, via: "cf" };
        cfAnswer = raw;
      } catch (err) {
        // Our own typed errors (e.g. an ambiguous token refresh) are final.
        if (err instanceof AlzaError) throw err;
        this.assertFallbackAllowed(method, url, err);
        cfError = err;
        log.warn("mobile-api: cf transport failed, falling back", { url, error: String(err), to: proxyConfigured() ? "browser (ALZA_PROXY_URL set)" : "plain fetch" });
      }
    }

    if (proxyConfigured()) {
      const viaBrowser = await this.fetchViaBrowser(url, init, new Headers(freshHeaders()));
      if (viaBrowser) return { status: viaBrowser.status, text: await viaBrowser.text(), via: "browser" };
      if (cfAnswer) return { ...cfAnswer, via: "cf" };
      throw proxyBypassRefused(cfError ?? new Error("the Chrome-fingerprint sidecar is not available"));
    }

    const plain = await withRefresh("plain");
    if (this.isBotChallenge(plain.status, plain.text)) {
      const viaBrowser = await this.fetchViaBrowser(url, init, new Headers(freshHeaders()));
      if (viaBrowser) return { status: viaBrowser.status, text: await viaBrowser.text(), via: "browser" };
    }
    return { ...plain, via: "plain" };
  }

  /** The www/webapi bot wall answers plain HTTP clients with an HTML page whose `var getData`
   * script computes a clearance token; the JSON API never speaks until that JS has run. */
  private isBotChallenge(status: number, text: string): boolean {
    return status === 403 && text.includes("var getData");
  }

  /** Retry a bot-challenged route through the browser transport (same-origin only):
   * an in-page fetch with `credentials: "include"` picks up the context's clearance
   * cookies; if the page is still cold, one navigation to the base origin clears the
   * challenge, then the fetch is repeated. Cross-host URLs are left untouched. */
  private async fetchViaBrowser(url: string, init: RequestInit, headers: Headers): Promise<Response | undefined> {
    if (!this.browser || !this.sameOrigin(url)) return undefined;
    const payload = {
      url,
      method: init.method ?? "GET",
      headers: Object.fromEntries([...headers.entries()]),
      body: init.body === undefined || init.body === null ? null : String(init.body),
    };
    return this.browser.withPage(async (page) => {
      const run = () => page.evaluate<{ status: number; text: string }, typeof payload>(
        async ({ url: u, method, headers: h, body }) => {
          const r = await fetch(u, { method, headers: h, body: body ?? undefined, credentials: "include" });
          return { status: r.status, text: await r.text() };
        },
        payload,
      );
      const clear = async () => {
        await page.goto(this.baseUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
        await page.waitForTimeout(3_000);
      };
      // A fresh page sits at about:blank where cross-origin fetches fail outright —
      // navigate to the base origin first so the in-page fetch is same-origin.
      if (page.url() === "about:blank") await clear();
      let out = await run();
      if (out.status === 403 && out.text.includes("var getData")) {
        // The challenge page's JS had not finished computing its clearance token — retry once.
        await clear();
        out = await run();
      }
      return new Response(out.text, { status: out.status });
    });
  }

  private sameOrigin(url: string): boolean {
    try {
      return new URL(url).origin === new URL(this.baseUrl).origin;
    } catch {
      return false;
    }
  }

  async executeAppAction(action: ServerAppAction, options: ExecuteAppActionOptions = {}): Promise<unknown> {
    await this.ensureFreshAccessToken();
    if (!this.fetchImpl) assertDirectFetchAllowed("AppAction execution");
    const executor = new AppActionExecutor({ baseUrl: this.baseUrl, visitorId: this.visitorId, userId: this.userId, authorizationToken: this.accessToken, fetchImpl: this.fetchImpl, acceptLanguage: this.acceptLanguage });
    return executor.execute(action, options);
  }

  private mobileHeaders(input?: Headers | Record<string, string> | Array<[string, string]>): Headers {
    const headers = new Headers(input);
    headers.set("accept", headers.get("accept") ?? "application/json");
    headers.set("content-type", headers.get("content-type") ?? "application/json");
    headers.set("user-agent", headers.get("user-agent") ?? "Alza/2026.15.0 (Android)");
    headers.set("accept-language", headers.get("accept-language") ?? this.acceptLanguage);
    headers.set("Balancer-Guid", this.visitorId);
    headers.set("x-correlation-id", headers.get("x-correlation-id") ?? randomUUID());
    if (this.accessToken) headers.set("authorization", `Bearer ${this.accessToken}`);
    return headers;
  }

  async register(payload: { email: string; phone: string; pwd: string; code?: string }): Promise<unknown> {
    return this.request("/services/restservice.svc/v2/CreateUser", { method: "POST", body: JSON.stringify(payload) });
  }

  async afterOrderPayment(payload: { id: string; invoiceNumber: string; paymentId: number; cardId?: number; deviceFingerprint?: string }): Promise<unknown> {
    return this.request("/api/orders/v4/afterOrderPayment", { method: "POST", body: JSON.stringify(payload) });
  }

  async eanLookup(eans: string[]): Promise<unknown> {
    return this.request("/services/restservice.svc/v1/getProductByEANlist", { method: "POST", body: JSON.stringify({ eanList: eans }) });
  }

  /** Search-box suggestions (live-verified 2026-10-06): anonymous webapi GET, no token. */
  async whisper(searchTerm: string): Promise<unknown> {
    const q = `country=${this.country}&visitor=${encodeURIComponent(this.visitorId)}&searchTerm=${encodeURIComponent(searchTerm)}`;
    return this.request(`https://webapi.alza.cz/api/anonymous/search/whisperer/v1/whisper?${q}`);
  }

  async search(searchTerm: string, page = 0): Promise<unknown> {
    return this.request("/services/restservice.svc/v5/search", { method: "POST", body: JSON.stringify({ searchTerm, id: 0, type: "PRODUCTION", typeId: 0, orderBy: 0, page, availabilityType: 0, selectedBranches: [], params: [], producers: [], sendPrices: false }) });
  }

  async category(id: number, type = "CATEGORY", typeId = 0): Promise<unknown> {
    // Live correction (2026-09-09): the server binds the query fields to T and P —
    // `type=`/`typeId=` return HTTP 400 ("The T field is required"/"The P field is required").
    return this.request(`/services/restservice.svc/v1/category/${id}?T=${encodeURIComponent(type)}&P=${encodeURIComponent(typeId)}`);
  }

  async facets(id: number, type = "CATEGORY", typeId = 0, search = ""): Promise<unknown> {
    return this.request(`/services/restservice.svc/v3/params/${id}?type=${encodeURIComponent(type)}&typeId=${typeId}&search=${encodeURIComponent(search)}`);
  }

  async product(id: number): Promise<unknown> {
    return this.request(`/api/legacy/catalog/v14/external/product/${id}`);
  }

  /** C5. Live correction (2026-09-09): Pgrik and Ucik are REQUIRED server-side
   * (HTTP 400 without them, even empty); take them from the router_product (C6)
   * response's self.href. */
  async legacyProduct(id: number, params: { pgrik?: string; ucik?: string; country?: string; electronicContentOnly?: boolean } = {}): Promise<unknown> {
    const query = new URLSearchParams();
    if (params.pgrik) query.set("pgrik", params.pgrik);
    if (params.ucik) query.set("ucik", params.ucik);
    if (params.country) query.set("country", params.country);
    if (params.electronicContentOnly !== undefined) query.set("electronicContentOnly", String(params.electronicContentOnly));
    return this.request(`/api/legacy/catalog/v14/product/${id}${query.size ? `?${query}` : ""}`);
  }

  async routerProduct(id: number, params: { pgrik?: string; ucik?: string; country?: string; electronicContentOnly?: boolean } = {}): Promise<unknown> {
    const query = new URLSearchParams();
    if (params.pgrik) query.set("pgrik", params.pgrik);
    if (params.ucik) query.set("ucik", params.ucik);
    if (params.country) query.set("country", params.country);
    if (params.electronicContentOnly !== undefined) query.set("electronicContentOnly", String(params.electronicContentOnly));
    return this.request(`/api/router/legacy/catalog/product/${id}${query.size ? `?${query}` : ""}`);
  }

  async alternatives(commodityId: number): Promise<unknown> {
    return this.request(`/services/restservice.svc/v1/alternatives/${commodityId}`);
  }

  async productsByEan(eans: string[]): Promise<unknown> {
    return this.request("/services/restservice.svc/v1/getProductByEANlist", { method: "POST", body: JSON.stringify({ eanList: eans }) });
  }

  async hierarchicalFilter(payload: Record<string, unknown>): Promise<unknown> {
    return this.request("/services/restservice.svc/v1/hierarchicalFilter", { method: "POST", body: JSON.stringify(payload) });
  }

  async urlInfo(url: string): Promise<unknown> {
    return this.request("/api/catalog/v1/homePage/getUrlInfo", { method: "POST", body: JSON.stringify({ url }) });
  }

  // Live correction (2026-09-10, rows C13/C14): the mainNavigation family is served by
  // webapi.alza.cz and requires the country query field (www 404s at the router; a bare
  // webapi GET → 400 "The Country field is required.").
  async userNavigation(userId: string, eshopUrl?: string): Promise<unknown> {
    const query = new URLSearchParams({ country: this.country });
    if (eshopUrl) query.set("eshopUrl", eshopUrl);
    return this.request(`https://webapi.alza.cz/api/users/${encodeURIComponent(userId)}/mainNavigation?${query}`);
  }

  async catalogUserNavigation(): Promise<unknown> {
    return this.request("/api/catalog/v2/homePage/userNavigation");
  }

  async quickOrderSummary(userId: string, commodityId: number, params: { pgrik?: string; ucik?: string } = {}): Promise<unknown> {
    const query = new URLSearchParams();
    if (params.pgrik) query.set("pgrik", params.pgrik);
    if (params.ucik) query.set("ucik", params.ucik);
    return this.request(`/api/users/${encodeURIComponent(userId)}/v1/quickOrder/summary/commodities/${commodityId}${query.size ? `?${query}` : ""}`);
  }

  // Live correction (2026-09-10, row R1): the APK's flag-shaped `/api/users/{flag}/commodities/{flag}/review`
  // is SPA-404 on www and policy-403 on webapi; the app actually reads reviews from server-provided
  // hrefs (webapi.alza.cz/api/catalog/commodities/{id}/reviews — live-verified 200, includes the
  // user's own review with a templated userReviewActions form when one exists).
  async commodityReviews(commodityId: number, opts: { limit?: number; offset?: number } = {}): Promise<unknown> {
    const limit = opts.limit ?? 5;
    const offset = opts.offset ? `&offset=${opts.offset}` : "";
    return this.request(`https://webapi.alza.cz/api/catalog/commodities/${commodityId}/reviews?country=${this.country}&limit=${limit}${offset}`);
  }

  async discussionPosts(commodityId: number, pageStart = 0, options: { parentId?: number; showOnlyWithoutAnswer?: boolean; orderBy?: number } = {}): Promise<unknown> {
    const query = new URLSearchParams({ id: String(commodityId), pageStart: String(pageStart), pageSize: "25" });
    if (options.parentId !== undefined) query.set("parentId", String(options.parentId));
    if (options.showOnlyWithoutAnswer !== undefined) query.set("showOnlyWithoutAnswer", String(options.showOnlyWithoutAnswer));
    if (options.orderBy !== undefined) query.set("orderBy", String(options.orderBy));
    return this.request(`/services/restservice.svc/v1/getCommodityDiscussionPosts?${query}`);
  }

  async submitDiscussionPost(payload: { commodityId: number; msg: string; userEmail: string; anonymous: boolean; notifications: boolean; parentPostId?: number }): Promise<unknown> { return this.request("/services/restservice.svc/v1/submitCommodityDiscussionPost", { method: "POST", body: JSON.stringify(payload) }); }
  async rateDiscussionPost(postId: number, rating: boolean): Promise<unknown> { return this.request(`/services/restservice.svc/v1/rateCommodityDiscussionPosts?id=${encodeURIComponent(postId)}&rating=${rating ? "true" : "false"}`); }

  async premiumTrial(userId: string): Promise<unknown> { return this.request(`/api/user/${encodeURIComponent(userId)}/v1/alzapremium/trial`); }
  async validateLoginName(email: string): Promise<unknown> { return this.request(`/services/restservice.svc/v1/validateLoginName?email=${encodeURIComponent(email)}`); }
  async o3Info(): Promise<unknown> { return this.request("/services/restservice.svc/v2/o3Info"); }
  async validateIsic(payload: { cardNumber: string; name: string }): Promise<unknown> { return this.request("/services/restservice.svc/v2/validateIsic", { method: "POST", body: JSON.stringify(payload) }); }
  async setCountry(payload: { countryId: number }): Promise<unknown> { return this.request("/services/restservice.svc/v1/setCountry", { method: "POST", body: JSON.stringify(payload) }); }
  async setIsic(payload: { isic: string }): Promise<unknown> { return this.request("/services/restservice.svc/v1/setIsic", { method: "POST", body: JSON.stringify(payload) }); }
  async addGift(payload: { rangeIdsGiftCodes: Array<{ priceRangeId: number; giftCodes: string[] }> }): Promise<unknown> { return this.request("/services/restservice.svc/v2/addGift", { method: "POST", body: JSON.stringify(payload) }); }
  // Live correction (2026-09-10, row O9): the first path segment binds to orderItemId (Int32) per server ModelState.
  async addOrderService(orderItemId: string | number, enabled: boolean, selected: boolean): Promise<unknown> { return this.request(`/services/restservice.svc/v1/addOrderService/${orderItemId}/${enabled ? 1 : 0}/${selected ? 1 : 0}`); }
  async sendFeedback(payload: { text: string; email?: string; info: string }): Promise<unknown> { return this.request("/services/restservice.svc/v1/feedback", { method: "POST", body: JSON.stringify(payload) }); }

  async orderHelpdeskQuestions(): Promise<unknown> { return this.request("/api/orders/v1/helpdesk/questions"); }

  async visitorNavigation(): Promise<unknown> {
    // Live correction (2026-09-10, row C13): webapi host + required country query field.
    return this.request(`https://webapi.alza.cz/api/visitors/${encodeURIComponent(this.visitorId)}/mainNavigation?country=${this.country}`);
  }

  async branches(latitude: number, longitude: number): Promise<unknown> {
    const query = `?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}`;
    return this.request(`/api/branches/v1/cityBranches${query}`);
  }

  async zipCodes(query?: string): Promise<unknown> {
    const params = new URLSearchParams({ deliveryId: "0" });
    if (query) params.set("search", query);
    return this.request(`/services/restservice.svc/v1/getZipCodes?${params}`);
  }

  async userData(): Promise<unknown> { return this.request("/services/restservice.svc/v2/getUserData"); }
  async contacts(): Promise<unknown> { return this.request("/services/restservice.svc/v4/contacts"); }

  async anonymousOrders(invoiceNumber: string): Promise<unknown> { return this.request(`/api/anonymous/v1/orders?invoiceNumber=${encodeURIComponent(invoiceNumber)}`); }
  async anonymousOrder(orderId: string): Promise<unknown> { return this.request(`/api/anonymous/v1/orders/${encodeURIComponent(orderId)}`); }
  /** OR1 (corrected 2026-10-07, issue #60): the path segment is the numeric
   * Alza user id — the same `/api/users/{userId}/v1/orders/…` family as the
   * archive/search reads, whose `self.href` links point here. The old code put
   * the APK's 0/1 scope flag in that segment, which Alza answers with 403. */
  async userOrder(userId: string, orderId: string, initialCreated = false): Promise<unknown> {
    const query = new URLSearchParams({ country: this.country });
    if (initialCreated) query.set("initialCreated", "1");
    return this.request(`/api/users/${encodeURIComponent(userId)}/v1/orders/${encodeURIComponent(orderId)}?${query}`);
  }
  async orderPart(orderId: string, partId: string): Promise<unknown> { return this.request(`/api/v1/orders/${encodeURIComponent(orderId)}/${encodeURIComponent(partId)}`); }

  /** OR11 (order cancellation, live-verified 2026-09-06/2026-09-16 and again
   * 2026-09-26 against a real anonymous order): the HATEOAS create-form GET
   * exposes the `reason` enum (0-5) + a `submit` button; the PUT commits it.
   * `hash` is the `?x=` token from the order's `GetOrderDetailAction.webLink`
   * (or `/api/anonymous/v1/orders/{id}/hashRequests` for a hashless order). */
  async orderCancelForm(orderId: string, hash: string, partId: string): Promise<unknown> {
    return this.request(`/api/v1/orders/${encodeURIComponent(orderId)}/${encodeURIComponent(hash)}/parts/${encodeURIComponent(partId)}/cancelForm`);
  }
  async orderCancel(orderId: string, hash: string, partId: string, reason: number): Promise<unknown> {
    const body = JSON.stringify({ value: [{ name: "reason", value: String(reason) }, { name: "submit" }] });
    return this.request(`/api/v1/orders/${encodeURIComponent(orderId)}/${encodeURIComponent(hash)}/parts/${encodeURIComponent(partId)}/cancellations`, {
      method: "PUT",
      body,
      headers: { "content-type": "application/json" },
    });
  }
  async orderAddInfo(): Promise<unknown> { return this.request("/services/restservice.svc/v2/getOrderAddInfo?isGiftsEnabled=true"); }
  async order2Info(country = this.country): Promise<unknown> {
    // Live correction (2026-09-09): requestModel.Country is required (HTTP 400 without).
    return this.request(`/services/restservice.svc/v8/getOrder2Info?country=${encodeURIComponent(country)}`);
  }
  async afterOrderPayments(orderId: string, partId: string): Promise<unknown> { return this.request(`/services/restservice.svc/v2/getafterorderpayments/${encodeURIComponent(orderId)}/${encodeURIComponent(partId)}`); }
  async deliveryCountries(): Promise<unknown> { return this.request("/services/restservice.svc/v1/getAllDeliveryCountries"); }
  async costEstimate(payload: Record<string, unknown>): Promise<unknown> { return this.request("/api/orders/v1/costEstimate", { method: "POST", body: JSON.stringify(payload) }); }

  async paymentMethods(selectedDeliveryOptionId?: number): Promise<unknown> {
    const groups = await this.deliveryPaymentGroups(selectedDeliveryOptionId) as { payments?: unknown; paymentTip?: string; warnings?: string[] } | unknown[];
    if (groups && typeof groups === "object" && !Array.isArray(groups) && "payments" in (groups as Record<string, unknown>)) {
      const g = groups as { payments?: unknown; paymentTip?: string; warnings?: string[] };
      return { payments: g.payments ?? [], paymentTip: g.paymentTip ?? null, warnings: g.warnings ?? [] };
    }
    return { payments: groups ?? [], paymentTip: null, warnings: [] };
  }

  async commodityLists(type?: number): Promise<unknown> { return this.request(`/services/restservice.svc/v1/getCommodityLists${type === undefined ? "" : `?type=${encodeURIComponent(type)}`}`); }
  async commodityList(listId: number): Promise<unknown> { return this.request(`/services/restservice.svc/v1/getCommodityLists/${listId}`); }
  async createCommodityList(payload: Record<string, unknown>): Promise<unknown> { return this.request("/services/restservice.svc/v1/createCommodityList", { method: "POST", body: JSON.stringify(payload) }); }
  async renameCommodityList(payload: Record<string, unknown>): Promise<unknown> { return this.request("/services/restservice.svc/v1/renameCommodityList", { method: "POST", body: JSON.stringify(payload) }); }
  async deleteCommodityList(payload: Record<string, unknown>): Promise<unknown> { return this.request("/services/restservice.svc/v1/deleteCommodityList", { method: "POST", body: JSON.stringify(payload) }); }
  async addCommodityToList(payload: Record<string, unknown>): Promise<unknown> { return this.request("/services/restservice.svc/v2/addCommodityToList", { method: "POST", body: JSON.stringify(payload) }); }
  async deleteCommodityFromList(payload: Record<string, unknown>): Promise<unknown> { return this.request("/services/restservice.svc/v2/deleteCommodityFromList", { method: "POST", body: JSON.stringify(payload) }); }
  async moveCommodityToList(payload: Record<string, unknown>): Promise<unknown> { return this.request("/services/restservice.svc/v2/moveCommodityToList", { method: "POST", body: JSON.stringify(payload) }); }

  async updateBasket(basketId: number, flag: boolean, isDelayedPayment = false): Promise<unknown> {
    return this.request(`/services/restservice.svc/v2/updBasket/${encodeURIComponent(basketId)}/${flag ? 1 : 0}?isDelayedPayment=${isDelayedPayment ? "true" : "false"}`);
  }
  async unlockBasket(country = ACCOUNT_WRITE_COUNTRY): Promise<unknown> {
    // Live correction (2026-09-09): GET (POST → 405) and requestModel.Country is required.
    return this.request(`/services/restservice.svc/v1/unlockbasket?country=${encodeURIComponent(country)}`);
  }
  async addCoupon(coupon: string): Promise<unknown> { return this.request(`/services/restservice.svc/v1/addcoupon/${encodeURIComponent(coupon)}`); }
  // Live correction (2026-09-10, row B7): delcoupon binds couponId (Int32) — addcoupon takes the code string, delcoupon takes the id.
  async deleteCoupon(couponId: string | number): Promise<unknown> { return this.request(`/services/restservice.svc/v1/delcoupon/${couponId}`); }


  async cart(): Promise<unknown> { return this.request("/services/restservice.svc/v10/gridOrder1"); }

  async cartInfo(): Promise<unknown> {
    return this.request("/services/restservice.svc/v3/basketInfo");
  }

  async addByCode(code: string, amount = 1): Promise<unknown> {
    return this.request("/services/restservice.svc/v2/basket/add", { method: "POST", body: JSON.stringify({ code, amount }) });
  }

  async deliveryPaymentGroups(selectedDeliveryOptionId?: number): Promise<unknown> {
    const query = selectedDeliveryOptionId === undefined ? "" : `?selectedDeliveryOptionId=${selectedDeliveryOptionId}`;
    // App 2026.17 calls v13; v12 is served in parallel (both versions
    // live-verified 2026-09-07 and 2026-09-08). Use v13 and fall back to v12
    // only if the server stops serving that version.
    try {
      return await this.request(`/services/restservice.svc/v13/getDeliveryPaymentGroups${query}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("/v13/getDeliveryPaymentGroups") && msg.includes("HTTP 404")) {
        return await this.request(`/services/restservice.svc/v12/getDeliveryPaymentGroups${query}`);
      }
      throw err;
    }
  }

  /** Web pickup family (m.alza.cz checkout; live-mapped 2026-09-08, rows W11–W14). */
  async webPickupPlaceForm(params: { orderId?: number; groupId?: number; latitude?: number; longitude?: number }): Promise<unknown> {
    const q = new URLSearchParams();
    if (params.orderId !== undefined) q.set("orderId", String(params.orderId));
    if (params.groupId !== undefined) q.set("groupId", String(params.groupId));
    if (params.latitude !== undefined) q.set("latitude", String(params.latitude));
    if (params.longitude !== undefined) q.set("longitude", String(params.longitude));
    const qs = q.toString();
    return this.request(`/api/personalPickup/v1/pickupPlaceForm${qs ? `?${qs}` : ""}`);
  }

  async webPickupPlaces(params: { types?: number[]; latitude?: number; longitude?: number; orderId?: number; groupId?: number; limit?: number; offset?: number }): Promise<unknown> {
    const q = new URLSearchParams();
    for (const [i, t] of (params.types ?? []).entries()) q.set(`types[${i}]`, String(t));
    if (params.latitude !== undefined) q.set("latitude", String(params.latitude));
    if (params.longitude !== undefined) q.set("longitude", String(params.longitude));
    if (params.orderId !== undefined) q.set("orderId", String(params.orderId));
    if (params.groupId !== undefined) q.set("groupId", String(params.groupId));
    if (params.limit !== undefined) q.set("limit", String(params.limit));
    if (params.offset !== undefined) q.set("offset", String(params.offset));
    const qs = q.toString();
    return this.request(`/api/personalPickup/v1/places${qs ? `?${qs}` : ""}`);
  }

  /** Web HATEOAS cart family (m.alza.cz checkout; W3–W5, gap-analysis G4).
   * The basket is visitor-keyed: the add works with the Balancer-Guid header
   * alone (live-verified cookie-less 2026-09-09) and its response carries the
   * `order/{basketId}/item/{itemId}` link that yields the basket id. */
  async webAddToCart(commodityId: number, count: number): Promise<unknown> {
    return this.request("/api/basket/v1/items", { method: "POST", body: JSON.stringify({ items: [{ commodityId, count }] }) });
  }

  async webCart(basketId: number): Promise<{ cart: unknown; items: unknown }> {
    const cart = await this.request(`/api/v1/visitors/${this.visitorId}/baskets/${basketId}/checkout/cart?country=${this.country}`);
    const items = await this.request(`/api/v1/anonymous/baskets/${basketId}/checkout/cart/items?country=${this.country}`);
    return { cart, items };
  }

  /** Home category carousel (C12): the full route is server-provided in the
   * C11 navigation response (`appLink catalogLocalTitlePage`); the `pgri`/`ui`
   * params are required (the bare route returns HTTP 400). */
  async homeCategories(categoryId: number, pgri?: string, ui?: string): Promise<unknown> {
    const q = new URLSearchParams();
    if (pgri !== undefined) q.set("pgri", pgri);
    if (ui !== undefined) q.set("ui", ui);
    const qs = q.toString();
    return this.request(`/api/catalog/v1/homePage/categories/${categoryId}${qs ? `?${qs}` : ""}`);
  }

  /** Chatbot family (chatbotapi.alza.cz, row W18 — live shapes 2026-09-09).
   * Navigation needs a `country` query field (HTTP 400 without); the chat POST
   * needs `ListCategoryId` in the body (an empty array works without product
   * context) and returns `{configuration {configId, teamName, welcomeText,
   * sessionExist, messages…}, showChat}`. */
  async chatNavigation(country = this.country): Promise<unknown> {
    return this.request(`https://chatbotapi.alza.cz/api/visitors/${this.visitorId}/v1/navigation?country=${encodeURIComponent(country)}`);
  }

  async chatSend(payload: { country: string; pageType: number; forceInitialize: boolean; initialInput: string | null; referrer: string | null; listCategoryId: unknown[]; commodityType?: number; commodityCode?: string | null; manufacturer?: string | null; entityId?: string | null; seoPrefix?: string | null }): Promise<unknown> {
    return this.request(`https://chatbotapi.alza.cz/api/visitors/${this.visitorId}/v1/chat?country=${encodeURIComponent(payload.country)}`, { method: "POST", body: JSON.stringify(payload) });
  }

  /** OR6 (2026-09-22): order search. The `orders` navigation carries the search
   * form (`userOrdersSearch`): `POST /api/users/{userId}/v1/orders/search/results?country=CZ`
   * with `{searchTerm, productFilterType:0}`. `searchTerm` is a required bound field
   * (400 without — live 2026-09-22); both form-urlencoded and JSON bodies returned
   * 200 with `orders[]` + `commodities[]` (each order carrying `documents[]`), so the
   * implementation sends form-urlencoded to match the APK form. Live-verified 2026-09-22.
   * `productFilterType` is a hidden form field with the fixed value 0. */
  async orderSearch(userId: string, searchTerm: string): Promise<unknown> {
    const body = new URLSearchParams({ searchTerm, productFilterType: "0" }).toString();
    return this.request(`/api/users/${encodeURIComponent(userId)}/v1/orders/search/results?country=${this.country}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
  }

  /** AT3 (2026-09-24): vision/barcode product lookup. The APK 2026.17.0 string
   * pool carries the static route `POST /services/restservice.svc/v1/getProductByEANlist`
   * (request model `ProductByEanRequest {eanList: List<String>}`, response
   * `ProductDetailEanResponse extends BaseResponse {data}` — the app's camera
   * barcode-scan → product flow, `cz.alza.base.{api,lib,android}.vision`).
   * Live probe 2026-09-24: unknown EAN → 200 `err:1` "No products found." (route
   * up, DTO bound, standard envelope; docs/live-evidence/at3-vision-rescan-2026-09-24.md).
   * Read-only. */
  async productByEan(eans: string[]): Promise<unknown> {
    return this.request("/services/restservice.svc/v1/getProductByEANlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eanList: eans }),
    });
  }

  /** OR7 (2026-09-24): order archive read. The orders navigation (`userOrders`)
   * carries `archiveOrders` → `GET /api/users/{userId}/v1/orders/archive`
   * with `hideCancelledOrders` (optional boolean; the APK form default is false,
   * label "Skrýt zrušené" = hide cancelled) and the fixed `productFilterType=0`.
   * Returns `{self, paging, value[]}` (same order shape as the search results).
   * Live-verified 2026-09-24 on disposable account 100000002: 200 with empty
   * `value[]` + `paging` for both `hideCancelledOrders` variants
   * (`docs/live-evidence/task6b-remaining-candidates-2026-09-24.json`). */
  async orderArchive(userId: string, hideCancelledOrders = false, limit?: number): Promise<unknown> {
    const q = new URLSearchParams({ hideCancelledOrders: hideCancelledOrders ? "true" : "false", productFilterType: "0" });
    if (limit !== undefined) q.set("limit", String(limit));
    return this.request(`/api/users/${encodeURIComponent(userId)}/v1/orders/archive?${q.toString()}`);
  }

  /** K1 (typed, issue #72): warranty-claim lists. The `warrantyClaims` section
   * links `activeWarrantyClaims` → `.../v1/warrantyClaims/active` and
   * `archiveWarrantyClaims` → `.../v1/warrantyClaims/archive` (both probed live
   * 2026-09-22: 200, `docs/live-evidence/task5-a17-or6-or10-k2-2026-09-22.md`). */
  async warrantyClaims(userId: string, scope: "active" | "archive"): Promise<unknown> {
    return this.request(`/api/users/${encodeURIComponent(userId)}/v1/warrantyClaims/${scope}?country=${this.country}`);
  }

  /** S1 (typed, issue #72): the subscription section that the authenticated
   * main navigation links as `userSubscription` (webapi host, observed live
   * 2026-09-22 in `docs/live-evidence/task6-orders-sub-2026-09-22.json`). */
  async userSubscription(userId: string): Promise<unknown> {
    return this.request(`https://webapi.alza.cz/api/users/${encodeURIComponent(userId)}/v1/subscription?country=${this.country}`);
  }

  /** A17 (2026-09-22): the "Osobní údaje" section — APK `PersonalGdprDetails`
   * (`{title, gdprInfoAction, deleteAccountAction}`) served by webapi.
   * Live-verified 2026-09-22 (200 with both actions; sibling probes 404 — the
   * route is exactly `userAccount/personalDetails`). */
  async userAccountPersonalDetails(userId: string): Promise<unknown> {
    return this.request(`https://webapi.alza.cz/api/users/${encodeURIComponent(userId)}/v1/userAccount/personalDetails?country=${this.country}`);
  }

  /** A17 (2026-09-22): the GDPR export dialog — APK `AccountGdprDialog`
   * (`{title, description, emailInfo, sendGdprInfoForm}`); `sendGdprInfoForm`
   * points at `POST .../v1/userAccount/gdprInformation` (empty form values —
   * the server sends the data to the account's own login email). Live-verified
   * 2026-09-22 (200, emailInfo = the E2E login email). */
  async gdprDialog(userId: string): Promise<unknown> {
    return this.request(`https://webapi.alza.cz/api/users/${encodeURIComponent(userId)}/v1/userAccount/gdprDialog`);
  }

  /** A17 (2026-09-22): trigger the GDPR data export (sendGdprInfoForm target).
   * Live-verified 2026-09-22: POST → 202 Accepted, empty body (the XML export
   * is queued for the account's login email). Low-risk write — the data goes to
   * the user's own address; still guarded by a one-time token. */
  async gdprExport(userId: string): Promise<unknown> {
    return this.request(`https://webapi.alza.cz/api/users/${encodeURIComponent(userId)}/v1/userAccount/gdprInformation`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
  }

  /** A14 (2026-09-22): change the account password. Live route (dialog probe,
   * `userAccountChangePasswordDialog`): `POST /api/users/{id}/v2/account/password`
   * with `{oldPassword, password1, password2}` (password1/2 = new + confirm).
   * Side effect: logs the user out of every device. */
  async changePassword(userId: string, oldPassword: string, newPassword: string): Promise<unknown> {
    return this.request(`https://www.alza.cz/api/users/${encodeURIComponent(userId)}/v2/account/password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ oldPassword, password1: newPassword, password2: newPassword }),
    });
  }

  /** A15 (2026-09-22): enable/disable SMS two-factor. Live route (2fa info
   * probe, `userAccount2FaInfo` changeAction): `PATCH /api/users/{id}/v1/account?country=CZ`
   * with the JSON-Patch-shaped body `{op:"replace", path:"/2faEnabled", value:<bool>}`. */
  async setTwoFactor(userId: string, enabled: boolean): Promise<unknown> {
    return this.request(`https://www.alza.cz/api/users/${encodeURIComponent(userId)}/v1/account?country=${ACCOUNT_WRITE_COUNTRY}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "replace", path: "/2faEnabled", value: enabled }),
    });
  }

  /** A16 (2026-09-22): change the contact phone number. Live route
   * (`userAccountChangePhoneDialog` form): `PATCH /api/users/{id}/v1/account?country=CZ`
   * with `{op:"replace", path:"/phone", value:<phone>}`. */
  async changePhone(userId: string, phone: string): Promise<unknown> {
    return this.request(`https://www.alza.cz/api/users/${encodeURIComponent(userId)}/v1/account?country=${ACCOUNT_WRITE_COUNTRY}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "replace", path: "/phone", value: phone }),
    });
  }

  /** A16 bonus (2026-09-22): change the contact email. Live route
   * (`userAccountChangeEmailDialog` form): `PATCH /api/users/{id}/v1/account?country=CZ`
   * with `{op:"replace", path:"/email", value:<email>}`. */
  async changeEmail(userId: string, email: string): Promise<unknown> {
    return this.request(`https://www.alza.cz/api/users/${encodeURIComponent(userId)}/v1/account?country=${ACCOUNT_WRITE_COUNTRY}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "replace", path: "/email", value: email }),
    });
  }

  /** A18 (2026-09-22): delete the account (irreversible). Live route
   * (`personalDetails.deleteAccountAction` → `deleteValidations` →
   * `deleteUserAccountAction`): `DELETE /api/users/{id}/v1/account?country=cz`
   * with `{acknowledgeAndDelete:true}`. The country is lower-case on purpose:
   * that is what the live action sends, unlike the other account routes. */
  async deleteAccount(userId: string): Promise<unknown> {
    return this.request(`https://www.alza.cz/api/users/${encodeURIComponent(userId)}/v1/account?country=${ACCOUNT_WRITE_COUNTRY.toLowerCase()}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ acknowledgeAndDelete: true }),
    });
  }

  /** B9 family (live-verified 2026-10-06): the per-product watchdog dialog
   * (`productAvailabilityWatchdogDialog`). Carries the create form (POST
   * `webapi.alza.cz/api/watchdog/v1`, fields commodityId/email/isTrackingStock/
   * price with `max` = current price, email pre-filled with the login address)
   * and, once a watchdog exists for the product, a `deleteAction`
   * (`removeProductAvailabilityWatchdog`, DELETE `.../watchdog/v1/{watchdogId}`). */
  async watchdogDialog(userId: string, commodityId: number): Promise<unknown> {
    return this.request(`/api/v1/users/${encodeURIComponent(userId)}/products/${encodeURIComponent(commodityId)}/watchdogDialog?country=${this.country}`);
  }

  /** B9a (live-verified 2026-10-06): the user's watchdog list
   * (`userWatchDogsCommodities`, from the user navigation's `watchDogs` link).
   * Paged `{emptyInfo, paging, value[]}`; each item carries `updateForm`
   * (PATCH `.../watchdog/v1/{watchdogId}`) and `deleteAction`. */
  async watchdogList(userId: string, limit?: number): Promise<unknown> {
    const q = new URLSearchParams({ country: this.country });
    if (limit !== undefined) q.set("limit", String(limit));
    return this.request(`/api/users/${encodeURIComponent(userId)}/v1/watchDogs/commodities?${q.toString()}`);
  }

  /** B9 (live-verified 2026-10-06): create a watchdog — the dialog form's
   * target. 200 with `{watchdogId, commodityId, isTrackingStock, price, created,
   * actions:{delete, update}}` (the response also echoes the email). */
  async watchdogCreate(userId: string, payload: { commodityId: number; email: string; isTrackingStock: boolean; price: number | null }): Promise<unknown> {
    return this.request(`https://webapi.alza.cz/api/watchdog/v1?country=${ACCOUNT_WRITE_COUNTRY}&commodityClientId=${encodeURIComponent(userId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  /** B9b (live-verified 2026-10-06): delete a watchdog — the dialog's
   * `deleteAction` target. 2xx with an empty body. */
  async watchdogDelete(userId: string, watchdogId: string): Promise<unknown> {
    return this.request(`https://webapi.alza.cz/api/watchdog/v1/${encodeURIComponent(watchdogId)}?country=${ACCOUNT_WRITE_COUNTRY}&commodityClientId=${encodeURIComponent(userId)}`, {
      method: "DELETE",
    });
  }

  /** OR10 (2026-09-22): invoice/document download following a server-provided
   * `self.href` (APK `Document`/`Attachment` models carry `self` descriptors;
   * the app's PDF resolver accepts `.pdf`/`pdfdoc` URLs). The href is
   * origin-validated against the Alza host family (live invoices serve from
   * `pdf.alza.cz`, e.g. `https://pdf.alza.cz/Apps/pdfdoc.asp?d={orderId}P&x={hash}`
   * — live-verified 2026-09-22: 200, `%PDF-1.7`, 332,276 bytes).
   * Max 8 MiB; text-like bodies come back as UTF-8 text, binary as base64. */
  async downloadDocument(href: string): Promise<{ href: string; contentType: string | null; byteLength: number; text: string | null; base64: string | null }> {
    let u: URL;
    try { u = new URL(href); } catch { throw new Error("document href must be an absolute URL"); }
    if (u.protocol !== "https:") throw new Error("document href must use HTTPS");
    if (!MobileApi.DOCUMENT_HOSTS.has(u.hostname)) {
      throw new Error(`document host is not an allowed Alza origin: ${u.hostname} (allowed: ${[...MobileApi.DOCUMENT_HOSTS].join(", ")})`);
    }
    const MAX_BYTES = 8 * 1024 * 1024;
    await this.ensureFreshAccessToken();
    const headers: Record<string, string> = {
      accept: "application/pdf, application/json, application/xml, text/plain, application/octet-stream",
      "user-agent": "Alza/2026.17.0 (Android)",
      "accept-language": this.acceptLanguage,
      "Balancer-Guid": this.visitorId,
    };
    if (this.accessToken) headers.authorization = `Bearer ${this.accessToken}`;

    let status: number;
    let contentType: string | null;
    let buf: Buffer;
    if (this.httpFetch) {
      const r = await this.httpFetch(u.toString(), { method: "GET", headers, redirect: "manual" });
      status = r.status;
      if (status >= 300 && status < 400) {
        // Never follow with the bearer token attached (same rule as the direct-fetch path).
        const location = r.header?.("location") ?? null;
        throw new Error(`document download redirected to a non-allowlisted location: ${location ?? "(unknown)"}`);
      }
      if (r.arrayBuffer) {
        contentType = r.header?.("content-type") ?? null;
        buf = Buffer.from(await r.arrayBuffer());
      } else {
        contentType = null;
        buf = Buffer.from(await r.text(), "utf8");
      }
    } else {
      assertDirectFetchAllowed("document download");
      const r = await fetch(u.toString(), { method: "GET", headers, redirect: "manual" });
      status = r.status;
      contentType = r.headers.get("content-type") ?? null;
      buf = Buffer.from(await r.arrayBuffer());
      if (status >= 300 && status < 400) {
        const location = r.headers.get("location");
        throw new Error(`document download redirected to a non-allowlisted location: ${location ?? "(unknown)"}`);
      }
    }
    if (status < 200 || status >= 300) {
      const snippet = buf.toString("utf8").replace(/\s+/g, " ").slice(0, 200);
      throw new Error(`document download failed with HTTP ${status}${snippet ? `: ${snippet}` : ""}`);
    }
    if (buf.length > MAX_BYTES) throw new Error(`document exceeds the ${MAX_BYTES} byte download limit (got ${buf.length})`);
    const ct = (contentType ?? "").toLowerCase();
    const looksBinary =
      (buf.length >= 2 && buf[0] === 0x25 && buf[1] === 0x50) || // %P… — PDF
      (buf.length >= 2 && buf[0] === 0x89) || // PNG signature
      (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b) || // PK… — zip/office
      (buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49); // GI… — GIF
    const isTextLike = ct.includes("json") || ct.includes("xml") || ct.includes("text") || (!ct && !looksBinary);
    if (isTextLike) return { href: u.toString(), contentType, byteLength: buf.length, text: buf.toString("utf8"), base64: null };
    return { href: u.toString(), contentType, byteLength: buf.length, text: null, base64: buf.toString("base64") };
  }

  /** WCF GetZipCodes twin (D5 twin, live-verified 2026-09-09): the body field is
   * `Search` (PascalCase); the response Value is an HTML snippet of `zip-item`
   * divs (data-id/data-city/data-text); ErrorLevel 14 when nothing matches. */
  async webZipCodes(search: string): Promise<unknown> {
    return this.webWcfStep("GetZipCodes", { Search: search });
  }

  async webPickupPlaceDetail(placeId: number, orderId?: number, groupId?: number): Promise<unknown> {
    const q = new URLSearchParams();
    if (orderId !== undefined) q.set("orderId", String(orderId));
    if (groupId !== undefined) q.set("groupId", String(groupId));
    const qs = q.toString();
    return this.request(`/api/personalPickup/v1/places/${placeId}${qs ? `?${qs}` : ""}`);
  }

  /** Legacy web WCF checkout pipeline (O11): EShopService.svc JSON operations.
   * Responses arrive WCF-wrapped as {"d":{...}}; the unwrapped step result
   * (with `ErrorLevel`, `Message`, `GetOrderDetailAction`, …) is returned. */
  async webWcfStep(op: string, body: unknown): Promise<Record<string, unknown>> {
    const res = (await this.request<Record<string, unknown>>(`/Services/EShopService.svc/${op}`, { method: "POST", body: JSON.stringify(body) })) ?? {};
    if ("d" in res && res.d !== null && typeof res.d === "object") return res.d as Record<string, unknown>;
    return res;
  }

  async deliveryAssociations(payload: Record<string, unknown>): Promise<unknown> {
    return this.request("/services/restservice.svc/v4/getDeliveryAssociations", { method: "POST", body: JSON.stringify(payload) });
  }

  async sendOrder1(): Promise<unknown> {
    return this.request("/services/restservice.svc/v4/sendOrder1");
  }

  async sendOrder2(payload: Record<string, unknown>): Promise<unknown> {
    return this.request("/services/restservice.svc/v7/sendOrder2", { method: "POST", body: JSON.stringify(payload) });
  }

  async sendOrder3(payload: Record<string, unknown>): Promise<unknown> {
    return this.request("/services/restservice.svc/v5/sendOrder3", { method: "POST", body: JSON.stringify(payload) });
  }

  async approveOrder4(): Promise<unknown> {
    return this.request("/services/restservice.svc/v1/approveOrder4");
  }

  async finishOrder(payload: Record<string, unknown>): Promise<unknown> {
    return this.request("/api/orders/v7/orderfinished", { method: "POST", body: JSON.stringify(payload) });
  }
}

interface RawHttp { status: number; text: string; via: "cf" | "plain" | "browser"; }

interface StoredTokens {
  access_token?: string;
  refresh_token?: string;
  visitor_id?: string;
  expires_in?: number | null;
  /** ISO timestamp (scripts/alza-auth-*) of when the access token was issued. */
  obtained_at?: string;
}

/** Refresh this long before the access token's real expiry. */
const TOKEN_EXPIRY_SKEW_MS = 60_000;

function isIdempotentMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD";
}

/** Legacy restservice writes that are sent as GET (coupon, basket flag/unlock,
 * order service, discussion rating). Their method looks idempotent, so they are
 * named here to keep them out of every automatic replay. */
const LEGACY_GET_WRITE_ROUTE = /\/services\/restservice\.svc\/v\d+\/(?:addcoupon|delcoupon|updBasket|unlockbasket|addOrderService|rateCommodityDiscussionPosts)(?:[/?]|$)/i;

/** May this request be sent a second time without risk of applying twice? */
function isReplaySafe(method: string, url: string): boolean {
  return isIdempotentMethod(method) && !LEGACY_GET_WRITE_ROUTE.test(url);
}

/** Anonymous catalog reads on the legacy restservice. Their answer is valid for
 * a visitor, so a user_id -1 envelope there is not treated as a stale token:
 * the data is returned as before instead of spending a refresh or raising a
 * sign-in error (POST search/EAN/filter reads included). */
const LEGACY_CATALOG_READ_ROUTE = /\/services\/restservice\.svc\/v\d+\/(?:search|category|alternatives|params|getProductByEANlist|hierarchicalFilter|getCommodityDiscussionPosts|getAllDeliveryCountries|getZipCodes)(?:[/?]|$)/i;

function isPreSendFailure(err: unknown): boolean {
  return err instanceof TransportUnavailableError || (err instanceof Error && err.name === "TransportUnavailableError");
}

/** Host + path for error messages (no query string). */
function displayTarget(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url.split("?")[0] ?? url;
  }
}

function proxyBypassRefused(cause: unknown): ConfigurationError {
  return new ConfigurationError(
    `ALZA_PROXY_URL is set, so alza-mcp-community does not fall back to an un-proxied connection, and the proxied Chrome-fingerprint transport failed: ${(cause instanceof Error ? cause.message : String(cause)).replace(/\.+\s*$/, "")}. ` +
      "Check that the proxy is reachable and its credentials are right, and that the curl_cffi sidecar is installed (scripts/ensure-cf-venv.sh).",
    cause,
  );
}

/** With ALZA_PROXY_URL set, a request must not go out over an un-proxied native
 * fetch just because the (proxied) sidecar is disabled (ALZA_CF_TRANSPORT=0). */
function assertDirectFetchAllowed(what: string): void {
  if (proxyConfigured()) throw proxyBypassRefused(new Error(`the Chrome-fingerprint sidecar is not available for ${what}`));
}

/** JWT `exp` claim in epoch ms; undefined for opaque or malformed tokens. */
function jwtExpiryMs(token: string): number | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function storedExpiryMs(stored: StoredTokens): number | undefined {
  if (typeof stored.expires_in !== "number" || typeof stored.obtained_at !== "string") return undefined;
  const obtained = Date.parse(stored.obtained_at);
  return Number.isFinite(obtained) ? obtained + stored.expires_in * 1000 : undefined;
}

function expiryFrom(accessToken: string, expiresIn: number | undefined): number | undefined {
  return jwtExpiryMs(accessToken) ?? (typeof expiresIn === "number" ? Date.now() + expiresIn * 1000 : undefined);
}

function isLegacyRestRoute(url: string): boolean {
  return /\/services\/restservice\.svc\//i.test(url);
}

/** The legacy restservice envelopes carry `user_id` at the top level (getUserData)
 * or under `info` (gridOrder1); -1 means Alza served the anonymous visitor. */
function isAnonymousEnvelope(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const top = value as Record<string, unknown>;
  if (top.user_id === -1) return true;
  const info = top.info;
  return Boolean(info && typeof info === "object" && (info as Record<string, unknown>).user_id === -1);
}

const HTML_BODY = /^\s*(<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]|<script[\s>])/i;

/** Error for a non-2xx answer. Never embeds a raw HTML page or the query string
 * (which carries the visitor id); sign-in and user_id problems are UserErrors. */
export function apiHttpFailure(method: string, url: string, status: number, value: unknown): Error {
  const target = displayTarget(url);
  if (typeof value === "string" && HTML_BODY.test(value)) {
    const challenge = status === 403 || status === 429 || status === 503 || /cloudflare|just a moment|cf-chl|cf_chl/i.test(value);
    return new Error(
      `Alza API ${method} ${target} failed with HTTP ${status}: ` +
        (challenge
          ? "Cloudflare bot challenge (HTML block page). Try another egress (ALZA_PROXY_URL) or retry later."
          : "the server answered with an HTML error page."),
    );
  }
  if (status === 401) {
    return new UserError(`Alza rejected the request to ${target} (HTTP 401): you are not signed in or the token expired. Sign in with \`auth_start\` → \`auth_exchange\` (check \`account_status\`).`);
  }
  if (status === 403 && /\/api\/users\/\d+/.test(url)) {
    return new UserError(`Alza refused ${target} (HTTP 403): \`user_id\` must equal the signed-in account's own id (\`profile.user_id\`).`);
  }
  return new Error(`Alza API ${method} ${target} failed with HTTP ${status}: ${summarize(value)}`);
}

function summarize(value: unknown): string {
  if (typeof value === "string") return value.replace(/\s+/g, " ").slice(0, 300);
  try { return JSON.stringify(value).slice(0, 500); } catch { return "unserializable response"; }
}

function base64Url(value: Buffer): string {
  return value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
