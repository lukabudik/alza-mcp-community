import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// A file:// URL, not a path: ESM `import` rejects a bare Windows path (C:\...) as an unknown URL scheme.
const browserTs = new URL("../src/infra/browser.ts", import.meta.url).href;

/** Runs ensureChromiumInstalled with a fake installer in a child process so its stdout can be inspected. */
function run(installerScript: string) {
  const code = `
    import { ensureChromiumInstalled } from ${JSON.stringify(browserTs)};
    await ensureChromiumInstalled({ command: process.execPath, args: ["-e", ${JSON.stringify(installerScript)}] });
    console.log("DONE");
  `;
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    encoding: "utf8",
    timeout: 30_000,
  });
}

describe("ensureChromiumInstalled", () => {
  it("keeps the installer's progress output off stdout (the MCP stdio channel)", () => {
    const res = run(`console.log("Downloading Chrome Headless Shell from http://x"); console.error("progress on stderr")`);
    expect(res.status).toBe(0);
    // Only our own marker may reach stdout; Playwright's console.log output must be on stderr.
    expect(res.stdout.trim()).toBe("DONE");
    expect(res.stderr).toContain("Downloading Chrome Headless Shell");
    expect(res.stderr).toContain("progress on stderr");
  });

  it("still rejects when the installer fails, without writing to stdout", () => {
    const res = run(`console.log("Failed to install browsers"); process.exit(1)`);
    expect(res.status).not.toBe(0);
    expect(res.stdout).not.toContain("Failed to install");
    expect(res.stderr).toContain("Failed to install Chromium (exit 1)");
  });
});
