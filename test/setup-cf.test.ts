import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { informationalOutput, isSetupCf } from "../src/cli.js";
import { longPathHint, runSetupCf, venvPythonPath, WINDOWS_LONG_VENV_PATH, type RunResult, type Runner } from "../src/infra/setup-cf.js";

const roots: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "setupcf-"));
  roots.push(d);
  return d;
};
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function harness(root: string, platform: NodeJS.Platform, handler: (cmd: string, args: string[]) => Partial<RunResult>) {
  const calls: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const run: Runner = (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    return { status: 0, stdout: "", stderr: "", ...handler(cmd, args) };
  };
  return { calls, out, err, opts: { root, platform, env: {}, run, out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

describe("alza-mcp-community --setup-cf", () => {
  it("is parsed and documented in --help", () => {
    expect(isSetupCf(["--setup-cf"])).toBe(true);
    expect(isSetupCf(["--stdio"])).toBe(false);
    expect(informationalOutput(["--help"])).toContain("--setup-cf");
  });

  it("creates the venv, installs the pinned range and verifies the import", async () => {
    const root = tmp();
    const h = harness(root, "linux", (_c, args) => {
      if (args.includes("--version")) return { stdout: "Python 3.12.1\n" };
      if (args.includes("venv")) mkdirSync(path.join(root, ".venv-cf"));
      if (args[1]?.includes("__version__")) return { stdout: "0.16.3\n" };
      return {};
    });
    expect(await runSetupCf(h.opts)).toBe(0);
    expect(h.calls.some((c) => c.includes("-m pip install --quiet curl_cffi>=0.16,<0.17"))).toBe(true);
    expect(h.calls.some((c) => c.startsWith(path.join(root, ".venv-cf", "bin", "python")))).toBe(true);
    expect(h.out.join("\n")).toContain("ready");
    expect(h.out.join("\n")).toContain(`ALZA_CF_PYTHON=${path.join(root, ".venv-cf", "bin", "python")}`);
  });

  it("is idempotent when the venv already imports curl_cffi", async () => {
    const root = tmp();
    mkdirSync(path.join(root, ".venv-cf", "bin"), { recursive: true });
    writeFileSync(path.join(root, ".venv-cf", "bin", "python"), "");
    const h = harness(root, "linux", () => ({}));
    expect(await runSetupCf(h.opts)).toBe(0);
    expect(h.calls).toHaveLength(1);
    expect(h.out.join("")).toContain("up to date");
  });

  it("fails with exit 1 and a clear message when no python exists", async () => {
    const h = harness(tmp(), "linux", () => ({ status: null, error: new Error("ENOENT") }));
    expect(await runSetupCf(h.opts)).toBe(1);
    expect(h.err.join("\n")).toContain("no Python 3 found");
  });

  it("removes the half-built venv when pip fails", async () => {
    const root = tmp();
    const h = harness(root, "linux", (_c, args) => {
      if (args.includes("--version")) return { stdout: "Python 3.11.0" };
      if (args.includes("venv")) mkdirSync(path.join(root, ".venv-cf"));
      if (args.includes("pip")) return { status: 1, stderr: "boom" };
      return {};
    });
    expect(await runSetupCf(h.opts)).toBe(1);
    expect(existsSync(path.join(root, ".venv-cf"))).toBe(false);
    expect(h.err.join("\n")).toContain("removed the partial venv");
  });

  it("leaves a pre-existing venv alone on failure", async () => {
    const root = tmp();
    mkdirSync(path.join(root, ".venv-cf"));
    const h = harness(root, "linux", (_c, args) => {
      if (args.includes("--version")) return { stdout: "Python 3.11.0" };
      if (args.includes("pip")) return { status: 1 };
      return {};
    });
    expect(await runSetupCf(h.opts)).toBe(1);
    expect(existsSync(path.join(root, ".venv-cf"))).toBe(true);
  });

  it("honours ALZA_MCP_SKIP_VENV", async () => {
    const h = harness(tmp(), "linux", () => ({}));
    expect(await runSetupCf({ ...h.opts, env: { ALZA_MCP_SKIP_VENV: "1" } })).toBe(0);
    expect(h.calls).toHaveLength(0);
  });

  it("uses py -3 and Scripts\\python.exe on Windows", async () => {
    const root = "C:\\pkg";
    const h = harness(root, "win32", (_c, args) => {
      if (args.includes("--version")) return { stdout: "Python 3.12.0" };
      return { stdout: "0.16.3" };
    });
    expect(await runSetupCf(h.opts)).toBe(0);
    expect(h.calls[0]).toBe("py -3 --version");
    expect(h.calls.some((c) => c.startsWith("py -3 -m venv C:\\pkg\\.venv-cf"))).toBe(true);
    expect(venvPythonPath(root, "win32")).toBe("C:\\pkg\\.venv-cf\\Scripts\\python.exe");
    expect(h.calls.some((c) => c.startsWith("C:\\pkg\\.venv-cf\\Scripts\\python.exe -m pip install"))).toBe(true);
  });

  describe("long install paths on Windows (issue #119)", () => {
    const deep = "C:\\Users\\someone\\AppData\\Local\\npm-cache\\_npx\\" + "x".repeat(WINDOWS_LONG_VENV_PATH) + "\\node_modules\\alza-mcp-community";
    const pyWin = (failOn: "pip" | "import" | "venv") => (_c: string, args: string[]): Partial<RunResult> => {
      if (args.includes("--version")) return { stdout: "Python 3.12.0" };
      if (failOn === "venv" && args.includes("venv")) return { status: 1, stderr: "venv failed" };
      if (failOn === "pip" && args.includes("pip")) return { status: 1, stderr: "OSError: [Errno 2] No such file or directory" };
      if (failOn === "import" && args[1]?.includes("__version__")) return { status: 1, stderr: "ImportError: DLL load failed" };
      return { stdout: "0.16.3" };
    };

    it("explains MAX_PATH when the import check fails in a long path", async () => {
      const h = harness(deep, "win32", pyWin("import"));
      expect(await runSetupCf(h.opts)).toBe(1);
      const err = h.err.join("\n");
      expect(err).toContain("curl_cffi installed but cannot be imported");
      expect(err).toContain("MAX_PATH");
      expect(err).toContain("LongPathsEnabled");
      expect(err).toContain("ALZA_CF_PYTHON");
    });

    it("explains MAX_PATH when pip fails in a long path", async () => {
      const h = harness(deep, "win32", pyWin("pip"));
      expect(await runSetupCf(h.opts)).toBe(1);
      expect(h.err.join("\n")).toContain("MAX_PATH");
    });

    it("does not blame the path when the venv itself could not be created", async () => {
      const h = harness(deep, "win32", pyWin("venv"));
      expect(await runSetupCf(h.opts)).toBe(1);
      expect(h.err.join("\n")).not.toContain("MAX_PATH");
    });

    it("says nothing about the path for a short path, or on other platforms", async () => {
      const h = harness("C:\\alza", "win32", pyWin("import"));
      expect(await runSetupCf(h.opts)).toBe(1);
      expect(h.err.join("\n")).not.toContain("MAX_PATH");
      expect(longPathHint("/" + "x".repeat(300), "linux")).toBeUndefined();
      expect(longPathHint("C:\\" + "x".repeat(300), "win32")).toContain("MAX_PATH");
    });
  });

  const havePy = spawnSync("python3", ["-c", "import venv, ensurepip"]).status === 0;
  it.skipIf(!havePy)(
    "real run against a temp dir",
    async () => {
      const root = tmp();
      const out: string[] = [];
      const code = await runSetupCf({ root, env: {}, out: (l) => out.push(l), err: (l) => out.push(l) });
      // pip may be offline: success must leave an importable venv, failure must clean up
      if (code === 0) expect(existsSync(venvPythonPath(root, process.platform))).toBe(true);
      else expect(existsSync(path.join(root, ".venv-cf"))).toBe(false);
      if (code === 0) expect(await runSetupCf({ root, env: {}, out: (l) => out.push(l) })).toBe(0);
    },
    300_000,
  );
});
