import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { log } from "./logger.js";

/**
 * Signed-in alza.cz web session for the catalog browser.
 *
 * The catalog tools scrape storefront pages, and Alza renders account-specific
 * prices (business price lists, member prices) into those pages only for a
 * signed-in visitor. The mobile-API OAuth token (ALZA_TOKEN_FILE) does not reach
 * the web pages, so the web session is kept separately: `--login` saves a
 * Playwright storage state (cookies + localStorage) after the user signs in by
 * hand, and every catalog browser context starts from it.
 */

/** Playwright `storageState` shape, kept structural so this module stays playwright-free. */
export interface WebSessionState {
  cookies: unknown[];
  origins: unknown[];
}

/** ALZA_WEB_SESSION_FILE, default ~/.alza-mcp/web-session.json; `none` disables it. */
export function webSessionFile(): string | undefined {
  const env = process.env.ALZA_WEB_SESSION_FILE?.trim();
  if (env === "none") return undefined;
  return env || join(homedir(), ".alza-mcp", "web-session.json");
}

/** A loaded session plus the file's mtime, so a write-back can tell whether `--login` replaced it meanwhile. */
export interface LoadedWebSession {
  state: WebSessionState;
  mtimeMs: number;
}

export function loadWebSession(path: string | undefined): LoadedWebSession | undefined {
  if (!path) return undefined;
  let raw: string;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const state = JSON.parse(raw) as WebSessionState;
    if (!Array.isArray(state?.cookies) || !Array.isArray(state?.origins)) throw new Error("not a storage state");
    return { state, mtimeMs };
  } catch (err) {
    log.warn("web-session: ignoring unreadable session file", { path, error: (err as Error).message });
    return undefined;
  }
}

/** Atomic, owner-only write (same treatment as the OAuth token store). */
export function saveWebSession(path: string, state: WebSessionState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Write refreshed cookies back, unless the file changed since it was loaded
 * (a newer `--login` must not be overwritten by a server's older session).
 */
export function writeBackWebSession(path: string, loadedMtimeMs: number, state: WebSessionState): boolean {
  try {
    if (statSync(path).mtimeMs !== loadedMtimeMs) return false;
  } catch {
    return false;
  }
  saveWebSession(path, state);
  return true;
}
