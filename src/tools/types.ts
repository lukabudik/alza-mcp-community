import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Catalog } from "../domain/catalog.js";
import type { Reviews } from "../domain/reviews.js";
import type { Pickup } from "../domain/pickup.js";
import type { Autocomplete } from "../domain/autocomplete.js";
import type { Alternatives } from "../domain/alternatives.js";
import type { MobileAccount } from "../domain/mobile-account.js";
import type { WebSessionStatus } from "../infra/browser.js";

/** The catalog browser's saved `--login` session, for `account_status`. */
export interface WebSessionProbe {
  status(opts?: { check?: boolean }): Promise<WebSessionStatus>;
  /** Command that signs in again (see web-session.ts `loginCommand`). */
  loginCommand(): string;
}

export interface ToolDeps {
  catalog: Catalog;
  reviews: Reviews;
  pickup: Pickup;
  mobileAccount: MobileAccount;
  autocomplete: Autocomplete;
  alternatives: Alternatives;
  webSession?: WebSessionProbe;
}

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * A tool factory returns a `register` closure. Each tool keeps its own
 * Zod schema type narrow — by the time `register(server)` runs, the SDK
 * call is fully concrete.
 */
export interface RegisterableTool {
  name: string;
  register(server: McpServer, errorWrap: (name: string, fn: () => Promise<ToolResult>) => Promise<ToolResult>): RegisteredTool;
}
