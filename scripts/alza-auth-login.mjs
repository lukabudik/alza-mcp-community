#!/usr/bin/env node
// Interactive OAuth 2.0 Authorization Code + PKCE login for the Alza mobile API.
//
// The discovery and token requests go through the curl_cffi sidecar when it is
// set up (see scripts/oauth-fetch.mjs), because Cloudflare can refuse a plain fetch.
//
// Why this exists as a script rather than an MCP tool pair:
// MobileApi keeps `pendingCodeVerifier` in memory, so alza_auth_start and
// alza_auth_exchange only work inside ONE process lifetime. The browser step
// happens between them, which an MCP process usually does not survive — so the
// exchange fails with "OAuth state is missing or does not match". Running both
// halves here keeps the verifier alive, and persists the tokens so later runs
// (and the server, via ALZA_TOKEN_FILE) can reuse them.
//
// You complete the sign-in yourself in a browser. No password is ever passed
// to, read by, or stored by this script.
//
//   node scripts/alza-auth-login.mjs
//
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { oauthFetch, closeOAuthFetch } from "./oauth-fetch.mjs";

const AUTHORITY = process.env.ALZA_OAUTH_AUTHORITY ?? "https://identity.alza.cz";
const CLIENT_ID = process.env.ALZA_OAUTH_CLIENT_ID ?? "alza_Android";
const REDIRECT_URI = process.env.ALZA_OAUTH_REDIRECT_URI ?? "alza://identity";
// The `alza_Android` OAuth client is confidential: the token endpoint requires the
// APK-embedded client secret, as MobileApi.exchangeOAuthCode sends it. "" omits it.
const CLIENT_SECRET = process.env.ALZA_OAUTH_CLIENT_SECRET ?? process.env.ALZA_CLIENT_SECRET ?? "ZRtjXCjaYFmUbGNvbTK25uctj4nQRT6a";
const SCOPE = "email openid profile alza offline_access";
const TOKEN_FILE = process.env.ALZA_TOKEN_FILE ?? join(homedir(), ".alza-mcp", "tokens.json");
const VISITOR_ID = process.env.ALZA_VISITOR_ID ?? randomUUID();

const base64Url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Same header set MobileApi sends, so the IdP sees a consistent client.
const mobileHeaders = (extra = {}) => ({
  "user-agent": "Alza/2026.15.0 (Android)",
  "accept-language": "cs-CZ,cs;q=0.9,en;q=0.8",
  "x-correlation-id": randomUUID(),
  "Balancer-Guid": VISITOR_ID,
  ...extra,
});

/** Discovery is best-effort: Cloudflare may challenge the GET from some egresses;
 * fall back to the APK's built-in IdentityServer defaults (same as MobileApi). */
async function discovery() {
  try {
    const res = await oauthFetch(`${AUTHORITY}/.well-known/openid-configuration`, {
      headers: mobileHeaders({ accept: "application/json" }),
    });
    if (res.ok) return await res.json();
    console.error(`note: discovery HTTP ${res.status}; using APK defaults (${AUTHORITY}/connect/authorize, ${AUTHORITY}/connect/token)`);
  } catch (err) {
    console.error(`note: discovery unreachable (${err}); using APK defaults`);
  }
  return {};
}

/** Accept a full alza://identity?... redirect, a bare code, or a ?code=... query. */
function parseRedirect(pasted) {
  const text = pasted.trim();
  if (!text) throw new Error("nothing pasted");
  if (!text.includes("=")) return { code: text, state: undefined };
  const query = text.includes("?") ? text.slice(text.indexOf("?") + 1) : text;
  const params = new URLSearchParams(query);
  const error = params.get("error");
  if (error) throw new Error(`authorization failed: ${error} ${params.get("error_description") ?? ""}`.trim());
  const code = params.get("code");
  if (!code) throw new Error("no `code` found in the pasted value");
  return { code, state: params.get("state") ?? undefined };
}

function persist(tokens) {
  mkdirSync(dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2) + "\n", { mode: 0o600 });
  chmodSync(TOKEN_FILE, 0o600);
}

const main = async () => {
  const oidc = await discovery();
  const authorizationEndpoint = oidc.authorization_endpoint ?? `${AUTHORITY}/connect/authorize`;
  const tokenEndpoint = oidc.token_endpoint ?? `${AUTHORITY}/connect/token`;

  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  const state = base64Url(randomBytes(32));

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    scope: SCOPE,
    redirect_uri: REDIRECT_URI,
    code_challenge_method: "S256",
    code_challenge: challenge,
    state,
    nonce: base64Url(randomBytes(32)),
    countryCode: process.env.ALZA_COUNTRY ?? "CZ",
    culture: process.env.ALZA_CULTURE ?? "cs-CZ",
  });

  console.log(`Authority: ${AUTHORITY}`);
  console.log(`Token store: ${TOKEN_FILE}\n`);
  console.log("1. Open this URL in a browser and sign in to YOUR Alza account:\n");
  console.log(`   ${authorizationEndpoint}?${params}\n`);
  console.log(`2. The browser will try to open ${REDIRECT_URI} and fail — that is expected.`);
  console.log("   Copy the FULL redirect URL from the address bar (or just the code) and paste it below.\n");

  const rl = readline.createInterface({ input, output });
  const pasted = await rl.question("Paste redirect URL (or code): ");
  rl.close();

  const parsed = parseRedirect(pasted);
  if (parsed.state && parsed.state !== state) {
    throw new Error("state mismatch — the redirect does not belong to this login attempt; start again");
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code: parsed.code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
    ...(CLIENT_SECRET ? { client_secret: CLIENT_SECRET } : {}),
  });
  const res = await oauthFetch(tokenEndpoint, {
    method: "POST",
    headers: mobileHeaders({ "content-type": "application/x-www-form-urlencoded", accept: "application/json" }),
    body,
  });
  if (!res.ok) {
    throw new Error(`token exchange failed with HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const json = await res.json();
  if (!json.access_token) throw new Error("token response contained no access_token");

  persist({
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    token_type: json.token_type ?? "Bearer",
    scope: json.scope ?? SCOPE,
    expires_in: json.expires_in,
    obtained_at: new Date().toISOString(),
    visitor_id: VISITOR_ID,
  });

  console.log(`\nSigned in. access_token stored (expires_in=${json.expires_in ?? "?"}s).`);
  console.log(`refresh_token: ${json.refresh_token ? "present" : "ABSENT — offline_access may not be granted"}`);
  console.log(`Saved to ${TOKEN_FILE} (0600).`);
  console.log("\nNext: node scripts/alza-auth-smoke.mjs");
};

main()
  .catch((err) => {
    console.error(`\nLogin failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(closeOAuthFetch);
