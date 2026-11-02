#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseCliConfig, startHttpServer } from "./http.js";
import { informationalOutput, isSetupCf, isWebLogin, replyForTransportError } from "./cli.js";
import { ConfigurationError } from "./infra/errors.js";
import { resolveLocale } from "./infra/locale.js";
import { InitializeGuardTransport } from "./infra/initialize-guard.js";
import { log } from "./infra/logger.js";
import { proxyFromEnv } from "./infra/proxy.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const info = informationalOutput(process.argv.slice(2));
  if (info !== undefined) {
    process.stdout.write(info);
    return;
  }
  if (isSetupCf(process.argv.slice(2))) {
    const { runSetupCf } = await import("./infra/setup-cf.js");
    process.exitCode = await runSetupCf();
    return;
  }
  if (isWebLogin(process.argv.slice(2))) {
    const { runWebLogin } = await import("./infra/web-login.js");
    process.exit(await runWebLogin());
  }
  const config = parseCliConfig(process.argv.slice(2));
  // Fail fast on a bad ALZA_PROXY_URL instead of starting and silently
  // sending traffic some other way (the browser only parses it on first use).
  proxyFromEnv();
  resolveLocale(process.env.ALZA_BASE_URL); // reject an unsupported ALZA_BASE_URL before serving
  if (config.transport === "http") return mainHttp(config.http);

  const { server, close } = buildServer({
    baseUrl: process.env.ALZA_BASE_URL?.trim() || undefined,
    cdpUrl: process.env.ALZA_CDP_URL,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`alza-mcp-community shutting down on ${signal}`);
    try {
      // Don't let a stuck browser/sidecar close keep an orphaned server alive.
      await Promise.race([close(), new Promise((r) => setTimeout(r, 5000).unref())]);
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  const transport = new StdioServerTransport();
  // The SDK drops unparseable lines silently; a client waiting on a reply would hang.
  // Answer with the JSON-RPC parse / invalid-request error (id null: the id is unknowable).
  server.server.onerror = (err) => {
    const reply = replyForTransportError(err);
    if (reply) process.stdout.write(reply);
    else log.warn("transport error", { error: err instanceof Error ? err.message : String(err) });
  };
  await server.connect(new InitializeGuardTransport(transport));
  // The host closed (or crashed and dropped) our stdin: there is nobody left to talk to. Without
  // this, the sidecar's piped stdio and Chromium keep the event loop alive forever.
  process.stdin.on("end", () => void shutdown("stdin end"));
  process.stdin.on("close", () => void shutdown("stdin close"));
  log.info("alza-mcp-community ready", {
    baseUrl: process.env.ALZA_BASE_URL?.trim() || "https://www.alza.cz",
    cdp: !!process.env.ALZA_CDP_URL,
  });
}

async function mainHttp(opts: Parameters<typeof startHttpServer>[0]): Promise<void> {
  const running = await startHttpServer(opts);
  const shutdown = async (signal: string) => {
    log.info(`alza-mcp-community shutting down on ${signal}`);
    try {
      await running.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  log.info("alza-mcp-community ready (Streamable HTTP)", {
    url: running.url,
    baseUrl: process.env.ALZA_BASE_URL?.trim() || "https://www.alza.cz",
    account: opts?.allowAccount ?? false,
    tokenFile: Boolean(opts?.allowAccount && opts?.allowTokenFile),
  });
}

main().catch((err) => {
  if (err instanceof ConfigurationError) {
    process.stderr.write(`alza-mcp-community: ${err.message}\n`);
    process.exit(1);
  }
  const message = err instanceof Error ? err.message : String(err);
  if (process.env.ALZA_DEBUG) log.error("fatal", { error: message, stack: (err as Error)?.stack });
  else process.stderr.write(`alza-mcp-community: ${message.split("\n")[0]}\n`);
  process.exit(1);
});
