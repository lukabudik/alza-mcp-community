#!/usr/bin/env node
// Non-interactive PKCE login, step 2: finish the token exchange using the PKCE
// context persisted by alza-auth-login-noninteractive.mjs, then store the tokens
// so the MCP server (ALZA_TOKEN_FILE) and later runs can reuse them.
//
//   node scripts/alza-auth-exchange.mjs <redirect-url-or-code>
//   echo "alza://identity?code=...&state=..." | node scripts/alza-auth-exchange.mjs
//
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { oauthFetch, closeOAuthFetch } from "./oauth-fetch.mjs";

const TOKEN_FILE = process.env.ALZA_TOKEN_FILE ?? join(homedir(), ".alza-mcp", "tokens.json");
const PENDING_FILE = join(homedir(), ".alza-mcp", "pending-login.json");
// The `alza_Android` OAuth client is confidential — the token endpoint requires
// the APK-embedded client secret (source-verified + live-verified; see
// scripts/alza-client-secret.mjs and scripts/e2e-order-payment.browser.mjs).
const CLIENT_SECRET = process.env.ALZA_OAUTH_CLIENT_SECRET ?? process.env.ALZA_CLIENT_SECRET ?? "ZRtjXCjaYFmUbGNvbTK25uctj4nQRT6a";

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
  });
}

function parseRedirect(pasted) {
  const text = (pasted ?? "").trim();
  if (!text) throw new Error("no redirect pasted");
  if (!text.includes("=")) return { code: text, state: undefined };
  const query = text.includes("?") ? text.slice(text.indexOf("?") + 1) : text;
  const params = new URLSearchParams(query);
  const error = params.get("error");
  if (error) throw new Error(`authorization failed: ${error} ${params.get("error_description") ?? ""}`.trim());
  const code = params.get("code");
  if (!code) throw new Error("no `code` found in the pasted value");
  return { code, state: params.get("state") ?? undefined };
}

const main = async () => {
  let pending;
  try {
    pending = JSON.parse(readFileSync(PENDING_FILE, "utf8"));
  } catch {
    throw new Error(`no pending login at ${PENDING_FILE} — run scripts/alza-auth-login-noninteractive.mjs first`);
  }
  // Accept both the camelCase file written by alza-auth-login-noninteractive.mjs and
  // the snake_case file written by alza_auth_login.py (npm run auth:login:py).
  pending = {
    ...pending,
    clientId: pending.clientId ?? pending.client_id,
    redirectUri: pending.redirectUri ?? pending.redirect_uri,
    tokenEndpoint: pending.tokenEndpoint ?? pending.token_endpoint,
    visitorId: pending.visitorId ?? pending.visitor_id,
  };
  const pasted = process.argv[2] ?? (await readStdin());
  const parsed = parseRedirect(pasted);
  if (parsed.state && parsed.state !== pending.state) {
    throw new Error("state mismatch — the redirect does not belong to this login attempt; start again");
  }
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: pending.clientId,
    code: parsed.code,
    redirect_uri: pending.redirectUri,
    code_verifier: pending.verifier,
    ...(CLIENT_SECRET ? { client_secret: CLIENT_SECRET } : {}),
  });
  const res = await oauthFetch(pending.tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      "user-agent": "Alza/2026.15.0 (Android)",
      "accept-language": "cs-CZ,cs;q=0.9,en;q=0.8",
      "Balancer-Guid": pending.visitorId,
    },
    body,
  });
  if (!res.ok) throw new Error(`token exchange failed with HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  if (!json.access_token) throw new Error("token response contained no access_token");

  mkdirSync(dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
  const store = {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    token_type: json.token_type ?? "Bearer",
    scope: json.scope ?? "email openid profile alza offline_access",
    expires_in: json.expires_in ?? null,
    visitor_id: pending.visitorId,
    obtained_at: new Date().toISOString(),
  };
  writeFileSync(TOKEN_FILE, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  chmodSync(TOKEN_FILE, 0o600);
  console.log(JSON.stringify({ ok: true, token_file: TOKEN_FILE, expires_in: store.expires_in, visitor_id: store.visitor_id }, null, 2));
};
main()
  .catch((err) => { console.error(err.message ?? err); process.exitCode = 1; })
  .finally(closeOAuthFetch);
