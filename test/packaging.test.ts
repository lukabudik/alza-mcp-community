import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { candidatePythons } from "../src/infra/impersonate-transport.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = path.join(root, "scripts");

/** A fake package: <tmp>/[node_modules/alza-mcp-community/]scripts with the real postinstall, plus a stub
 * venv script and a stub CLI that each write which of them ran into `marker`. */
function fakePackage(underNodeModules: boolean) {
  const base = mkdtempSync(path.join(tmpdir(), "alza-pkg-"));
  const pkg = underNodeModules ? path.join(base, "node_modules", "alza-mcp-community") : path.join(base, "alza-mcp-community");
  mkdirSync(path.join(pkg, "scripts"), { recursive: true });
  mkdirSync(path.join(pkg, "dist"));
  copyFileSync(path.join(scripts, "postinstall.cjs"), path.join(pkg, "scripts", "postinstall.cjs"));
  const marker = path.join(pkg, "venv-ran");
  writeFileSync(path.join(pkg, "scripts", "ensure-cf-venv.sh"), `#!/usr/bin/env bash\necho bash > "$(dirname "$0")/../venv-ran"\n`, { mode: 0o755 });
  writeFileSync(
    path.join(pkg, "dist", "index.js"),
    `if (process.argv.includes("--setup-cf")) require("node:fs").writeFileSync(${JSON.stringify(marker)}, "cli\\n");\n`
  );
  return { pkg, marker };
}

function runPostinstall(pkg: string, env: Record<string, string>) {
  return spawnSync(process.execPath, [path.join(pkg, "scripts", "postinstall.cjs")], {
    env: { ...process.env, ALZA_MCP_SKIP_INSTALL: "", PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "", ALZA_MCP_SKIP_VENV: "", ...env },
    encoding: "utf8",
    timeout: 20_000,
  });
}

describe("postinstall skip rules", () => {
  it("does nothing in this repository's own dev install", () => {
    const { pkg, marker } = fakePackage(false);
    const run = runPostinstall(pkg, {});
    expect(run.status).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(run.stdout).toBe("");
  });

  it("still sets up the venv when only the Chromium download is skipped", () => {
    for (const flag of ["ALZA_MCP_SKIP_INSTALL", "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD"]) {
      const { pkg, marker } = fakePackage(true);
      const run = runPostinstall(pkg, { [flag]: "1" });
      expect(run.status).toBe(0);
      expect(existsSync(marker), flag).toBe(true);
    }
  });

  it("sets up the venv with the Node CLI on Windows and with bash elsewhere", () => {
    const { pkg, marker } = fakePackage(true);
    const run = runPostinstall(pkg, { ALZA_MCP_SKIP_INSTALL: "1" });
    expect(run.status).toBe(0);
    expect(readFileSync(marker, "utf8").trim()).toBe(process.platform === "win32" ? "cli" : "bash");
  });

  it("ALZA_MCP_SKIP_VENV=1 skips the venv", () => {
    const { pkg, marker } = fakePackage(true);
    const run = runPostinstall(pkg, { ALZA_MCP_SKIP_VENV: "1", ALZA_MCP_SKIP_INSTALL: "1" });
    expect(run.status).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("ensure-cf-venv.sh", () => {
  const script = readFileSync(path.join(scripts, "ensure-cf-venv.sh"), "utf8");

  it("pins curl_cffi to the tested range and does not upgrade pip", () => {
    expect(script).toContain('CURL_CFFI_SPEC="curl_cffi>=0.16,<0.17"');
    expect(script).not.toContain("--upgrade pip");
  });

  const hasVenv = spawnSync("python3", ["-c", "import ensurepip, venv"]).status === 0;
  it.skipIf(!hasVenv)("removes the venv it created when the pip install fails", () => {
    const base = mkdtempSync(path.join(tmpdir(), "alza-venv-"));
    mkdirSync(path.join(base, "scripts"));
    copyFileSync(path.join(scripts, "ensure-cf-venv.sh"), path.join(base, "scripts", "ensure-cf-venv.sh"));
    const run = spawnSync("bash", [path.join(base, "scripts", "ensure-cf-venv.sh")], {
      env: { ...process.env, PIP_INDEX_URL: "http://127.0.0.1:9/simple", PIP_RETRIES: "0", PIP_DISABLE_PIP_VERSION_CHECK: "1", PIP_TIMEOUT: "2" },
      encoding: "utf8",
      timeout: 90_000,
    });
    expect(run.status).not.toBe(0);
    expect(existsSync(path.join(base, ".venv-cf"))).toBe(false);
  }, 100_000);
});

describe("candidatePythons", () => {
  it("uses bin/python and python3 on POSIX", () => {
    const c = candidatePythons("linux");
    expect(c).toContain("python3");
    expect(c.some((p) => p.endsWith(path.join(".venv-cf", "bin", "python")))).toBe(true);
    expect(c).not.toContain("py");
  });

  it("tries Scripts\\python.exe, python and py on Windows", () => {
    const c = candidatePythons("win32");
    expect(c.some((p) => p.endsWith("\\.venv-cf\\Scripts\\python.exe"))).toBe(true);
    expect(c).toEqual(expect.arrayContaining(["python", "py"]));
    expect(c).not.toContain("python3");
  });
});

describe("package contents", () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { files: string[] };

  it("ships every script that a shipped login script points users to", () => {
    for (const f of pkg.files.filter((f) => f.startsWith("scripts/alza-auth-login"))) {
      const text = readFileSync(path.join(root, f), "utf8");
      for (const m of text.matchAll(/scripts\/([\w.-]+\.(?:mjs|cjs|py|sh))/g)) {
        expect(pkg.files, `${f} references scripts/${m[1]}`).toContain(`scripts/${m[1]}`);
      }
    }
  });

  it("does not point runtime strings at docs/ paths that the package does not contain", () => {
    for (const f of ["src/server.ts", "src/tools/account.ts", "src/tools/advanced.ts"]) {
      const text = readFileSync(path.join(root, f), "utf8");
      const bad = text.split("\n").filter((l) => /^\s*(".*"|\+|AUTH_PREREQ)/.test(l) && /(?<!blob\/main\/)docs\/(gap-analysis|live-evidence)/.test(l));
      expect(bad.map((l) => l.trim().slice(0, 80)), f).toEqual([]);
    }
  });
});

describe("alza-auth-exchange.mjs pending-login.json", () => {
  const servers: http.Server[] = [];
  afterEach(() => servers.splice(0).forEach((s) => s.close()));

  it("accepts the snake_case file written by alza_auth_login.py", async () => {
    let seen = "";
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen = body;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ access_token: "tok", refresh_token: "ref", expires_in: 3600 }));
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;

    const home = mkdtempSync(path.join(tmpdir(), "alza-home-"));
    mkdirSync(path.join(home, ".alza-mcp"));
    writeFileSync(
      path.join(home, ".alza-mcp", "pending-login.json"),
      JSON.stringify({ verifier: "v", state: "s", token_endpoint: `http://127.0.0.1:${port}/token`, client_id: "cid", redirect_uri: "alza://identity", visitor_id: "vis" }),
    );
    const tokenFile = path.join(home, "tokens.json");
    const child = spawn(process.execPath, [path.join(scripts, "alza-auth-exchange.mjs"), "alza://identity?code=abc&state=s"], {
      env: { ...process.env, HOME: home, ALZA_TOKEN_FILE: tokenFile },
    });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(seen).toContain("client_id=cid");
    expect(JSON.parse(readFileSync(tokenFile, "utf8")).visitor_id).toBe("vis");
  }, 30_000);
});
