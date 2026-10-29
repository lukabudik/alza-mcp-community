import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const indexTs = fileURLToPath(new URL("../src/index.ts", import.meta.url));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  // A zombie awaiting reaping by init counts as dead.
  try {
    if (/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"))) return false;
  } catch {
    /* no procfs: fall back to kill(0) */
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// The fake interpreter below is a `#!/bin/sh` script. Windows cannot run it: the server starts
// ALZA_CF_PYTHON with execFile/spawn (no shell), which only accepts real executables there, and
// Node refuses to run .cmd/.bat files without a shell. The shutdown path itself is not POSIX-only.
const posixOnly = process.platform === "win32";

describe("stdio server lifecycle", () => {
  it.skipIf(posixOnly)("exits with code 0 and stops the sidecar when the host closes stdin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alza-mcp-community-stdio-"));
    const pidFile = join(dir, "sidecar.pid");
    // Fake "python": passes the `-c "import curl_cffi"` probe, then behaves like a sidecar that
    // never answers (and, as a pipe-connected child, keeps the parent's event loop alive).
    const fake = join(dir, "fake-python.sh");
    writeFileSync(fake, `#!/bin/sh\nif [ "$1" = "-c" ]; then exit 0; fi\necho $$ > "${pidFile}"\nexec sleep 120\n`);
    chmodSync(fake, 0o755);

    const child = spawn(process.execPath, ["--import", "tsx", indexTs], {
      env: { ...process.env, ALZA_TOKEN_FILE: "none", ALZA_CF_PYTHON: fake, ALZA_CF_TRANSPORT: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let sidecarPid = 0;
    try {
      const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
      const send = (m: object) => child.stdin.write(JSON.stringify(m) + "\n");
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
      await sleep(1500);
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "autocomplete", arguments: { query: "iphone", limit: 3 } } });

      for (let i = 0; i < 100 && !existsSync(pidFile); i++) await sleep(100);
      expect(existsSync(pidFile), "sidecar should have started").toBe(true);
      sidecarPid = Number(readFileSync(pidFile, "utf8").trim());
      expect(alive(sidecarPid)).toBe(true);

      child.stdin.end(); // the host went away
      const code = await Promise.race([exited, sleep(10_000).then(() => "timeout" as const)]);
      expect(code).toBe(0);
      for (let i = 0; i < 30 && alive(sidecarPid); i++) await sleep(100);
      expect(alive(sidecarPid), "sidecar must not be orphaned").toBe(false);
    } finally {
      child.kill("SIGKILL");
      if (sidecarPid && alive(sidecarPid)) process.kill(sidecarPid, "SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);
});
