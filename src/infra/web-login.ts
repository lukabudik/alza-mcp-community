import { createInterface } from "node:readline";
import { chromium, type Browser } from "playwright";
import { browserContextOptions } from "./browser.js";
import { resolveLocale } from "./locale.js";
import { proxyFromEnv } from "./proxy.js";
import { saveWebSession, webSessionFile, type WebSessionState } from "./web-session.js";

const SNAPSHOT_EVERY_MS = 3_000;

/**
 * `--login`: open the user's own Chrome (or Edge) on the storefront, let them sign
 * in by hand, and save the resulting cookies to ALZA_WEB_SESSION_FILE. The password
 * never passes through this process. Returns the process exit code.
 */
export async function runWebLogin(): Promise<number> {
  const file = webSessionFile();
  if (!file) {
    process.stderr.write("alza-mcp-community: ALZA_WEB_SESSION_FILE=none, nothing to log in to.\n");
    return 1;
  }
  const locale = resolveLocale(process.env.ALZA_BASE_URL?.trim() || undefined);
  const browser = await launchInstalledBrowser();
  try {
    const context = await browser.newContext({ ...browserContextOptions(locale), viewport: null });
    const page = await context.newPage();
    await page.goto(locale.baseUrl, { waitUntil: "domcontentloaded" }).catch(() => {});

    process.stderr.write(
      `\nSign in to ${new URL(locale.baseUrl).host} in the browser window that just opened.\n` +
        "When you see your account (and your prices), press Enter here, or close the window.\n\n"
    );

    let last: WebSessionState | undefined;
    const snapshot = async () => {
      last = ((await context.storageState().catch(() => undefined)) as WebSessionState | undefined) ?? last;
    };
    const timer = setInterval(() => void snapshot(), SNAPSHOT_EVERY_MS);
    await new Promise<void>((resolve) => {
      const rl = createInterface({ input: process.stdin });
      const done = () => {
        rl.close();
        resolve();
      };
      rl.once("line", done);
      rl.once("close", done);
      page.once("close", done);
      browser.once("disconnected", done);
    });
    clearInterval(timer);
    await snapshot();

    const cookies = last?.cookies.length ?? 0;
    if (!last || cookies === 0) {
      process.stderr.write("No cookies were captured; the session file was not changed.\n");
      return 1;
    }
    saveWebSession(file, last);
    process.stderr.write(`Saved ${cookies} cookies to ${file}. Restart the MCP server (or wait for its idle restart) to use them.\n`);
    return 0;
  } finally {
    await browser.close().catch(() => {});
  }
}

/** A headed, real browser: the bundled headless shell cannot show a window. */
async function launchInstalledBrowser(): Promise<Browser> {
  const proxy = proxyFromEnv();
  const errors: string[] = [];
  for (const channel of ["chrome", "msedge"]) {
    try {
      return await chromium.launch({
        channel,
        headless: false,
        args: ["--disable-blink-features=AutomationControlled", "--no-default-browser-check", "--no-first-run"],
        ...(proxy ? { proxy } : {}),
      });
    } catch (err) {
      errors.push(`${channel}: ${((err as Error)?.message ?? String(err)).split("\n")[0]}`);
    }
  }
  throw new Error(`--login needs Google Chrome or Microsoft Edge installed (${errors.join("; ")})`);
}
