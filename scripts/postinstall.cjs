// Triggered automatically when alza-mcp-community is installed (incl. via `npx -y`).
// Sets up the two optional runtime helpers the MCP server uses:
//   1. the Chrome-fingerprint transport venv (curl_cffi, scripts/ensure-cf-venv.sh)
//   2. the Chromium headless-shell binary for the browser-driven fallback
//
// Skip cases (each is independent):
//   - Running inside this repo's own dev install (the package root is not under
//     a node_modules directory): skips BOTH steps. Run `npm run setup:cf` and
//     `npx playwright install chromium --only-shell` manually when needed.
//   - ALZA_MCP_SKIP_INSTALL=1 / PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1: skip only the
//     Chromium download (CI / Docker images that pre-stage browsers, CDP users).
//   - ALZA_MCP_SKIP_VENV=1: skip only the curl_cffi venv.
//
// We use chromium *headless-shell* (~92 MB) instead of full Chromium (~280 MB)
// since the MCP server is always headless.

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

/** True when this package root is a development checkout rather than a dependency. */
function isDevInstall(root) {
  return !root.split(path.sep).includes("node_modules");
}

if (isDevInstall(path.resolve(__dirname, ".."))) {
  process.exit(0);
}

const skipBrowser =
  process.env.ALZA_MCP_SKIP_INSTALL === "1" || process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === "1";
const skipVenv = process.env.ALZA_MCP_SKIP_VENV === "1";

const logFile = path.join(__dirname, "..", ".postinstall.log");

function log(msg) {
  process.stdout.write("[alza-mcp-community] " + msg + "\n");
  try { fs.appendFileSync(logFile, msg + "\n"); } catch { /* ignore */ }
}

// Chrome-fingerprint transport (scripts/cf-transport.py). Without it every request
// — including the OAuth endpoints — falls back to plain fetch, which Alza's edge
// answers with a 403 challenge. Best-effort by design: ensure-cf-venv.sh exits 0
// when python3 is absent, and the server degrades to the browser transport.
// On Windows it runs the Node-only `--setup-cf` instead: `bash` there is often
// WSL's, which mangles the backslash path and would build a Linux venv anyway.
const ensureVenv = path.join(__dirname, "ensure-cf-venv.sh");
const cli = path.join(__dirname, "..", "dist", "index.js");
if (!skipVenv && process.platform === "win32") {
  if (fs.existsSync(cli)) {
    log("setting up the Chrome-fingerprint transport venv (curl_cffi) …");
    const venv = spawnSync(process.execPath, [cli, "--setup-cf"], { stdio: "inherit" });
    if (venv.error) {
      log("cf-venv setup skipped (" + venv.error.message + "); the server will fall back to the browser transport.");
    } else if (venv.status !== 0) {
      log("cf-venv setup exited with code " + venv.status + "; the server will fall back to the browser transport.");
    }
  } else {
    log("cf-venv setup skipped (dist/index.js not built); run `alza-mcp-community --setup-cf` after building.");
  }
} else if (!skipVenv && fs.existsSync(ensureVenv)) {
  log("setting up the Chrome-fingerprint transport venv (curl_cffi) …");
  const venv = spawnSync("bash", [ensureVenv], { stdio: "inherit" });
  if (venv.error) {
    log("cf-venv setup skipped (bash not available: " + venv.error.message + "); the server will fall back to the browser transport.");
  } else if (venv.status !== 0) {
    log("cf-venv setup exited with code " + venv.status + "; the server will fall back to the browser transport.");
  }
}

if (skipBrowser) {
  process.exit(0);
}

// Locate playwright's CLI. The `cli.js` file is not in the package's
// `exports` map, so we resolve via package.json instead.
let cliPath;
try {
  const pkgJsonPath = require.resolve("playwright/package.json");
  cliPath = path.join(path.dirname(pkgJsonPath), "cli.js");
  if (!fs.existsSync(cliPath)) throw new Error("cli.js missing");
} catch {
  console.warn(
    "[alza-mcp-community] postinstall: playwright not yet installed; skipping browser download. " +
      "Run `npx playwright install chromium --only-shell` manually if the server fails to launch."
  );
  process.exit(0);
}

log("downloading chromium headless-shell (~92 MB) for the browser-driven MCP …");
const result = spawnSync(
  process.execPath,
  [cliPath, "install", "chromium", "--only-shell"],
  { stdio: "inherit" }
);

if (result.status === 0) {
  log("chromium headless-shell installed.");
  process.exit(0);
}

// Don't fail the parent npm install over this — alza-mcp-community will retry the install
// at runtime with a clearer error message.
log(
  "chromium install exited with code " +
    result.status +
    ". The MCP will retry on first launch and explain what to do if it still fails."
);
process.exit(0);
