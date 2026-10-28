// Shared HTTP for the alza-auth-* scripts: identity.alza.cz sits behind the same
// Cloudflare bot wall as www/webapi and keys off the TLS/HTTP2 fingerprint, so a
// plain Node fetch of the token endpoint can get 403 (`cf-mitigated: challenge`).
// Like the server's MobileApi, send the requests through the curl_cffi sidecar
// (scripts/cf-transport.py, set up by `alza-mcp-community --setup-cf`) when it is
// available, and fall back to plain fetch otherwise.
//
//   ALZA_CF_TRANSPORT=0  plain fetch only (no sidecar, no note)
//   ALZA_PROXY_URL       set: refuse the un-proxied fallback, like the server does
//
// The transport logs JSON lines to stderr for the server; keep a CLI quiet.
process.env.ALZA_LOG_LEVEL ??= "error";

let transport;
let cfFetchImpl;
let unavailable;

async function sidecar() {
  if (cfFetchImpl || unavailable) return cfFetchImpl;
  if (process.env.ALZA_CF_TRANSPORT === "0") {
    unavailable = "disabled by ALZA_CF_TRANSPORT=0";
    return undefined;
  }
  try {
    const mod = await import(new URL("../dist/infra/impersonate-transport.js", import.meta.url).href);
    transport = new mod.ImpersonateTransport();
    cfFetchImpl = mod.cfFetch(transport);
    return cfFetchImpl;
  } catch (err) {
    unavailable = `dist/ not built (${err.code ?? err.message}); run npm run build`;
    return undefined;
  }
}

function fallback(url, init, reason) {
  if (process.env.ALZA_PROXY_URL) {
    throw new Error(`Chrome-fingerprint transport unavailable (${reason}) and ALZA_PROXY_URL is set; refusing to send ${new URL(url).host} an un-proxied request. Run alza-mcp-community --setup-cf.`);
  }
  if (process.env.ALZA_CF_TRANSPORT !== "0") {
    console.error(`note: Chrome-fingerprint transport unavailable (${reason}); using plain fetch, which Cloudflare may refuse with 403. Run alza-mcp-community --setup-cf to fix.`);
  }
  return fetch(url, init);
}

/** fetch() for OAuth requests: sidecar first, plain fetch as the fallback. */
export async function oauthFetch(url, init = {}) {
  const impl = await sidecar();
  if (!impl) return fallback(url, init, unavailable);
  try {
    return await impl(url, init);
  } catch (err) {
    if (err?.name !== "TransportUnavailableError") throw err;
    unavailable = err.message.replace(/^Chrome-fingerprint transport unavailable: /, "");
    cfFetchImpl = undefined;
    return fallback(url, init, unavailable);
  }
}

/** Stop the sidecar so the script can exit. */
export function closeOAuthFetch() {
  transport?.close();
  transport = undefined;
}
