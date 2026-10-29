import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "./impersonate-transport.js";

/** Same tested range as scripts/ensure-cf-venv.sh. Widen deliberately. */
export const CURL_CFFI_SPEC = "curl_cffi>=0.16,<0.17";

export interface RunResult { status: number | null; stdout: string; stderr: string; error?: Error }
export type Runner = (cmd: string, args: string[]) => RunResult;

export interface SetupCfOptions {
  root?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  run?: Runner;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

const defaultRun: Runner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 600_000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
};

/** Interpreter used inside the venv (Scripts\python.exe on Windows). */
export function venvPythonPath(root: string, platform: NodeJS.Platform): string {
  return platform === "win32"
    ? path.win32.join(root, ".venv-cf", "Scripts", "python.exe")
    : path.join(root, ".venv-cf", "bin", "python");
}

/** System interpreters to try, as [command, ...leadingArgs]. */
export function systemPythons(platform: NodeJS.Platform): string[][] {
  return platform === "win32" ? [["py", "-3"], ["python"], ["python3"]] : [["python3"], ["python"]];
}

/** Venv paths longer than this leave little room under Windows' 260-character MAX_PATH for
 * curl_cffi's own files (Lib\site-packages\curl_cffi\...), so a failure there is likely the
 * path, not the package (issue #119). */
export const WINDOWS_LONG_VENV_PATH = 150;

/** Explains a likely MAX_PATH failure on Windows, or returns undefined when the path is short. */
export function longPathHint(venv: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32" || venv.length <= WINDOWS_LONG_VENV_PATH) return undefined;
  return (
    `cf-venv: the venv path is ${venv.length} characters long, so curl_cffi's files probably exceed Windows' ` +
    "260-character path limit (MAX_PATH). Either enable long paths (set the registry value " +
    "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem\\LongPathsEnabled to 1, then open a new terminal) " +
    "and run --setup-cf again, or install alza-mcp-community in a shorter folder (npm install alza-mcp-community " +
    "in e.g. C:\\alza), run --setup-cf there and set ALZA_CF_PYTHON to the interpreter it prints."
  );
}

/**
 * Create (idempotently) the .venv-cf holding curl_cffi. Never runs implicitly:
 * only via `alza-mcp-community --setup-cf`. Returns the process exit code.
 */
export async function runSetupCf(opts: SetupCfOptions = {}): Promise<number> {
  const root = opts.root ?? repoRoot;
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const run = opts.run ?? defaultRun;
  const out = opts.out ?? ((l) => process.stdout.write(l + "\n"));
  const err = opts.err ?? ((l) => process.stderr.write(l + "\n"));
  const venv = platform === "win32" ? path.win32.join(root, ".venv-cf") : path.join(root, ".venv-cf");
  const venvPy = venvPythonPath(root, platform);

  if (env.ALZA_MCP_SKIP_VENV === "1") {
    out("cf-venv: skipped (ALZA_MCP_SKIP_VENV=1)");
    return 0;
  }

  if (existsSync(venvPy) && run(venvPy, ["-c", "import curl_cffi"]).status === 0) {
    out(`cf-venv: up to date (${venv})`);
    return 0;
  }

  let python: string[] | undefined;
  for (const cand of systemPythons(platform)) {
    const r = run(cand[0]!, [...cand.slice(1), "--version"]);
    if (!r.error && r.status === 0 && /Python 3\./.test(r.stdout + r.stderr)) { python = cand; break; }
  }
  if (!python) {
    err(
      "cf-venv: no Python 3 found (tried " +
        systemPythons(platform).map((c) => c.join(" ")).join(", ") +
        "). Install Python 3 with the venv module, or set ALZA_CF_PYTHON to an interpreter that has curl_cffi. The server still works without it (slower, more Cloudflare challenges).",
    );
    return 1;
  }

  const created = !existsSync(venv);
  // Set once the venv exists: only pip/import failures can be MAX_PATH failures.
  let installing = false;
  const fail = (msg: string, r?: RunResult): number => {
    err(`cf-venv: ${msg}`);
    if (r) err((r.stderr || r.stdout || String(r.error ?? "")).trim().split("\n").slice(-5).join("\n"));
    const hint = installing ? longPathHint(venv, platform) : undefined;
    if (hint) err(hint);
    if (created) {
      rmSync(venv, { recursive: true, force: true });
      err(`cf-venv: setup failed; removed the partial venv (${venv})`);
    }
    return 1;
  };

  let r = run(python[0]!, [...python.slice(1), "-m", "venv", venv]);
  if (r.error || r.status !== 0) return fail("could not create the venv (is the Python venv module installed?)", r);
  installing = true;
  r = run(venvPy, ["-m", "pip", "install", "--quiet", CURL_CFFI_SPEC]);
  if (r.error || r.status !== 0) return fail(`pip install ${CURL_CFFI_SPEC} failed`, r);
  r = run(venvPy, ["-c", "import curl_cffi; print(curl_cffi.__version__)"]);
  if (r.error || r.status !== 0) return fail("curl_cffi installed but cannot be imported", r);
  out(`cf-venv: ready (${venv}, curl_cffi ${r.stdout.trim()})`);
  out(`cf-venv: only a server running from this same package directory finds it automatically; for any other install (e.g. the .mcpb bundle) set ALZA_CF_PYTHON=${venvPy}`);
  return 0;
}
