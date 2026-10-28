#!/usr/bin/env node
// Refresh the stored Alza access token using the refresh_token grant.
// Run this instead of a full re-login when the access token has expired.
//
//   node scripts/alza-auth-refresh.mjs
//
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { oauthFetch, closeOAuthFetch } from "./oauth-fetch.mjs";

const AUTHORITY = process.env.ALZA_OAUTH_AUTHORITY ?? "https://identity.alza.cz";
const CLIENT_ID = process.env.ALZA_OAUTH_CLIENT_ID ?? "alza_Android";
// The `alza_Android` OAuth client is confidential — the token endpoint requires
// the APK-embedded client secret (source-verified; see scripts/alza-client-secret.mjs).
const CLIENT_SECRET = process.env.ALZA_OAUTH_CLIENT_SECRET ?? process.env.ALZA_CLIENT_SECRET ?? "ZRtjXCjaYFmUbGNvbTK25uctj4nQRT6a";
const TOKEN_FILE = process.env.ALZA_TOKEN_FILE ?? join(homedir(), ".alza-mcp", "tokens.json");

const main = async () => {
  let stored;
  try {
    stored = JSON.parse(readFileSync(TOKEN_FILE, "utf8"));
  } catch {
    throw new Error(`no token store at ${TOKEN_FILE} — run scripts/alza-auth-login.mjs first`);
  }
  if (!stored.refresh_token) {
    throw new Error("stored tokens have no refresh_token — a full re-login is required");
  }

  const visitorId = stored.visitor_id ?? process.env.ALZA_VISITOR_ID ?? randomUUID();
  const discoveryRes = await oauthFetch(`${AUTHORITY}/.well-known/openid-configuration`, {
    headers: {
      accept: "application/json",
      "user-agent": "Alza/2026.15.0 (Android)",
      "accept-language": "cs-CZ,cs;q=0.9,en;q=0.8",
      "x-correlation-id": randomUUID(),
      "Balancer-Guid": visitorId,
    },
  });
  // Discovery is best-effort: Cloudflare may challenge the GET from some egresses;
  // fall back to the APK's built-in IdentityServer default (same as MobileApi).
  let tokenEndpoint = `${AUTHORITY}/connect/token`;
  if (discoveryRes.ok) {
    tokenEndpoint = ((await discoveryRes.json()).token_endpoint) ?? tokenEndpoint;
  } else {
    console.error(`note: discovery HTTP ${discoveryRes.status}; using APK default token endpoint`);
  }

  const res = await oauthFetch(tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      "user-agent": "Alza/2026.15.0 (Android)",
      "accept-language": "cs-CZ,cs;q=0.9,en;q=0.8",
      "x-correlation-id": randomUUID(),
      "Balancer-Guid": visitorId,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: stored.refresh_token,
      ...(CLIENT_SECRET ? { client_secret: CLIENT_SECRET } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`refresh failed with HTTP ${res.status}: ${(await res.text()).slice(0, 300)} — re-run the login script`);
  }
  const json = await res.json();
  if (!json.access_token) throw new Error("refresh response contained no access_token");

  const next = {
    ...stored,
    access_token: json.access_token,
    // IdPs may rotate the refresh token; keep the old one only if none returned.
    refresh_token: json.refresh_token ?? stored.refresh_token,
    expires_in: json.expires_in ?? stored.expires_in,
    obtained_at: new Date().toISOString(),
    visitor_id: visitorId,
  };
  writeFileSync(TOKEN_FILE, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  chmodSync(TOKEN_FILE, 0o600);

  console.log(`Refreshed. expires_in=${json.expires_in ?? "?"}s`);
  console.log(`refresh_token ${json.refresh_token ? "rotated" : "reused"}.`);
};

main()
  .catch((err) => {
    console.error(`Refresh failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(closeOAuthFetch);
