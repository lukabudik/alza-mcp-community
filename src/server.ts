import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ZodError } from "zod";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Catalog } from "./domain/catalog.js";
import { MobileAccount } from "./domain/mobile-account.js";
import { Pickup } from "./domain/pickup.js";
import { Alternatives } from "./domain/alternatives.js";
import { Reviews } from "./domain/reviews.js";
import { AlzaBrowser } from "./infra/browser.js";
import { AlzaRejectedError, AuthenticationError, ConfigurationError, NotFoundError, OutcomeUnknownError, UpstreamError, UserError, truncateInput } from "./infra/errors.js";
import { log } from "./infra/logger.js";
import { findProductPrompt } from "./prompts/find-product.js";
import { createProductResource } from "./resources/product.js";
import { createFindPickupPointsTool } from "./tools/find-pickup-points.js";
import { createGetProductTool } from "./tools/get-product.js";
import { createCompareProductsTool } from "./tools/compare-products.js";
import { createGetProductReviewsTool } from "./tools/get-product-reviews.js";
import { createAutocompleteTool } from "./tools/autocomplete.js";
import { Autocomplete } from "./domain/autocomplete.js";
import { createRecommendAlternativesTool } from "./tools/recommend-alternatives.js";
import { createListCategoriesTool } from "./tools/list-categories.js";
import { createGetDealsTool } from "./tools/get-deals.js";
import { createListCategoryFiltersTool } from "./tools/list-category-filters.js";
import { createSearchProductsTool } from "./tools/search-products.js";
import { createAccountTools } from "./tools/account.js";
import { createAdvancedTools } from "./tools/advanced.js";
import { createPcBuildCheckTool, createPcBuildSuggestTool } from "./tools/pc-builder.js";
import { createWatchdogTools } from "./tools/watchdog.js";
import { parseToolsetsEnv, registerToolsets, type LockedToolsets } from "./tools/toolsets.js";
import { registerReportIssueTool } from "./tools/report-issue.js";
import { RecentErrors } from "./infra/issue-report.js";
import { MobileApi } from "./infra/mobile-api.js";
import { ImpersonateTransport, cfFetch } from "./infra/impersonate-transport.js";
import type { ToolResult } from "./tools/types.js";

export const VERSION = "0.6.0";

export interface BuildOptions {
  baseUrl?: string;
  cdpUrl?: string;
  /** Reuse an existing browser instead of creating one (HTTP catalog-only mode
   * shares one across sessions). A shared browser is NOT closed by `close()`. */
  browser?: AlzaBrowser;
  /** Reuse an existing Chrome-fingerprint sidecar (same ownership rule as `browser`). */
  cfTransport?: ImpersonateTransport;
  /** Toolsets this deployment refuses to enable, with the reason (see toolsets.ts). */
  lockedToolsets?: LockedToolsets;
  /** Toolsets enabled at startup on top of the defaults. Default: `ALZA_TOOLSETS` (see parseToolsetsEnv). */
  enabledToolsets?: readonly string[];
  /** Auto-load ALZA_TOKEN_FILE (default true; see MobileApiOptions.loadTokenFile). */
  loadTokenFile?: boolean;
  /** Extra sentence appended to the server instructions (e.g. the HTTP-mode note). */
  instructionsNote?: string;
  /** Reported in `report_issue` drafts (default "stdio"). */
  transport?: "stdio" | "http";
}

export interface BuildResult {
  server: McpServer;
  /** Call on shutdown to release the browser. */
  close: () => Promise<void>;
}

export function buildServer(opts: BuildOptions = {}): BuildResult {
  const browser = opts.browser ?? new AlzaBrowser({ baseUrl: opts.baseUrl, cdpUrl: opts.cdpUrl });
  const catalog = new Catalog(browser);
  // Chrome-fingerprint sidecar (curl_cffi) — tried FIRST for the account stack:
  // it bypasses the Cloudflare bot wall without a browser (verified 2026-09-15).
  // Optional by design: no interpreter with curl_cffi → the transport is dead
  // and the existing chain (plain fetch → browser fallback) applies unchanged.
  const cfTransport = opts.cfTransport ?? new ImpersonateTransport();
  // The browser transport backs the catalog AND the account stack's bot-challenge fallback
  // (same-origin /services/restservice.svc routes are JS-challenge-gated for plain fetch).
  const mobileApi = new MobileApi({
    baseUrl: opts.baseUrl,
    // The catalog storefront decides the `country` the shared webapi hosts answer for.
    locale: browser.locale,
    browser,
    httpFetch: cfTransport.available ? cfFetch(cfTransport) : undefined,
    fetchImpl: cfTransport.available ? cfFetch(cfTransport) : undefined,
    loadTokenFile: opts.loadTokenFile,
  });
  const mobileAccount = new MobileAccount(mobileApi);
  // AlzaBox lockers come from the public salesNetwork API, which sits behind the
  // Cloudflare bot wall: reuse MobileApi's sidecar → fetch → browser chain.
  const pickup = new Pickup(browser.locale, { getJson: (url) => mobileApi.request(url) });
  const autocomplete = new Autocomplete(mobileApi);
  const reviews = new Reviews(browser, catalog, mobileApi);
  const alternatives = new Alternatives(catalog, mobileApi);
  const deps = { catalog, reviews, pickup, mobileAccount, alternatives, autocomplete };

  const server = new McpServer(
    { name: "alza-mcp-community", title: "Alza (unofficial, community)", version: VERSION },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
      instructions:
        "Alza.cz catalog and shopping assistant. Unofficial — not affiliated with or endorsed by Alza.cz a.s. " +
        "Tools are grouped into toolsets and only `catalog` + `auth` are enabled by default to keep the visible tool list small — call `list_toolsets` to see every group, then `set_toolset({id, enabled: true})` to turn on the one a task needs (e.g. `basket_and_checkout` before placing an order) before calling its tools. " +
        "Catalog (always on): `autocomplete` (search-box suggestions to refine a query) → `search_products` (keyword + filters) → `get_product` (detail) → `get_product_reviews` (reviews); `compare_products` (2–6 codes side by side); `recommend_alternatives` for cheaper / better-rated / same-brand alternatives to a product; `get_deals` for discounted products; `list_categories` for category ids; `find_pickup_points` for AlzaBox lockers and AlzaShop showrooms near a postal code. " +
        "LINKS: every product in an answer must carry its Alza link (the `url` of the search / deals / comparison result, clickable as [name](url)) so the user can jump straight to the product page — never answer with names and prices alone. " +
        "PRICES: the shelf price is not always the lowest price a buyer can pay. Alza shows promo-code prices (\"Kúpiť s kódom ALZADNI15\") and AlzaPlus+ member prices on listing cards: `search_products`, `get_deals`, `get_product` and `compare_products` all return the promo-code price as `priceNow` + `promoCode` (`price` stays the shelf price); AlzaPlus+ member prices (`alzaPlusPrice`) come from listing cards only. EXCEPTION: previously sold goods (`condition` \"opened\" = Rozbalené, or \"used\"; `newPrice` is what the same product costs new) are a compromise on condition — never rank or compare their price with new goods and never present their gap to `newPrice` as a discount, but DO mention them to the user as a possible bargain. For any price, value, budget or \"best deal\" question, rank by `priceNow` (else `price`), always tell the user the code to enter and the shelf price it is measured against, mention `alzaPlusPrice` separately (membership required), and use `get_deals` to find current discounts in a category without being asked. " +
        "Account & checkout (enable `basket_and_checkout`; OAuth token auto-loads from ~/.alza-mcp/tokens.json; check `account_status`): `cart`, `add_to_cart`, `delivery_options`, `select_pickup_point`, `checkout_preview` → `place_order` (mobile API), or the legacy web WCF path `web_add_to_cart` → `web_cart` → `web_pickup_places` → `web_place_order`. " +
        "Order submission currently works via the legacy web WCF path (`web_place_order`); the mobile `place_order` (sendOrder3) returns HTTP 500 (https://github.com/lukabudik/alza-mcp-community/blob/main/docs/gap-analysis.md G1/G5). Cancel with `cancel_order`. " +
        "Credentials are never collected by the MCP. High-impact mutations (payment, registration, address, review, subscription, attachment, order) require a one-time token from `prepare_mutation` (in the always-on `auth` toolset) — confirm with the user before calling them. " +
        "PC building (enable `pc_builder`): `pc_build_suggest` proposes a compatibility-checked parts list within a CZK budget; `pc_build_check` checks any parts list (socket, RAM, PSU wattage, GPU/cooler clearance, form factor). " +
        "`mobile_read` (toolset `advanced_raw`) is the raw read-only escape hatch for mobile API operations without a dedicated tool. " +
        "If a tool fails unexpectedly or returns clearly wrong data (not a user mistake such as invalid arguments or an unknown product), call `report_issue` (always available) to draft a GitHub issue for the alza-mcp-community maintainers, show the draft to the user, and file it with the returned `gh` command or link only if they agree." +
        (opts.instructionsNote ? ` ${opts.instructionsNote}` : ""),
    }
  );

  const recentErrors = new RecentErrors();
  const errorWrap = async (name: string, fn: () => Promise<ToolResult>): Promise<ToolResult> => {
    try {
      return await fn();
    } catch (err) {
      const message = friendlyError(err);
      log.warn(`tool ${name} error`, { error: message });
      if (!isUserError(err) && name !== "report_issue") {
        recentErrors.record(name, err instanceof Error ? err.message : String(err));
        return { content: [{ type: "text", text: `${message}\n\n${REPORT_HINT}` }], isError: true };
      }
      return { content: [{ type: "text", text: message }], isError: true };
    }
  };

  registerToolsets(server, errorWrap, [
    createSearchProductsTool(deps),
    createGetProductTool(deps),
    createCompareProductsTool(deps),
    createGetProductReviewsTool(deps),
    createRecommendAlternativesTool(deps),
    createFindPickupPointsTool(deps),
    createListCategoryFiltersTool(deps),
    createListCategoriesTool(deps),
    createGetDealsTool(deps),
    createAutocompleteTool(deps),
    ...createAccountTools(deps),
    ...createAdvancedTools(deps),
    ...createWatchdogTools(deps),
    createPcBuildCheckTool(deps),
    createPcBuildSuggestTool(deps),
  ], opts.lockedToolsets, opts.enabledToolsets ?? parseToolsetsEnv(process.env.ALZA_TOOLSETS));

  registerReportIssueTool(server, errorWrap, {
    recentErrors,
    diagnostics: () => ({
      version: VERSION,
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      storefront: browser.locale.baseUrl,
      transport: opts.transport ?? "stdio",
      fingerprintSidecar: cfTransport.available ? "enabled" : "unavailable",
      proxy: process.env.ALZA_PROXY_URL?.trim() ? "set" : "not set",
    }),
  });

  hardenToolCalls(server);

  const productResource = createProductResource(catalog);
  server.registerResource(
    productResource.name,
    new ResourceTemplate(productResource.template, { list: undefined }),
    {
      title: productResource.title,
      description: productResource.description,
      mimeType: "application/json",
    },
    productResource.handler
  );

  server.registerPrompt(
    findProductPrompt.name,
    findProductPrompt.config,
    findProductPrompt.handler
  );

  return {
    server,
    close: async () => {
      if (!opts.cfTransport) cfTransport.close();
      if (!opts.browser) await browser.close();
    },
  };
}

const REPORT_HINT =
  "If this looks like a bug in alza-mcp-community or a change on Alza's side rather than a problem with the request, you can call `report_issue` to draft a GitHub issue — ask the user before filing it.";

/** Errors caused by the request itself: no point asking the maintainers about them. */
function isUserError(err: unknown): boolean {
  return (
    err instanceof ZodError ||
    err instanceof NotFoundError ||
    err instanceof ConfigurationError ||
    err instanceof UserError ||
    err instanceof AuthenticationError ||
    err instanceof AlzaRejectedError
  );
}

/** `path: message` per issue, bounded: enums and long messages are summarised. */
export function formatZodIssues(issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string; code?: string; options?: unknown; received?: unknown }>): string {
  const shown = issues.slice(0, 5).map((i) => {
    const where = i.path.length ? `${i.path.join(".")}: ` : "";
    if (i.code === "invalid_enum_value" && Array.isArray(i.options)) {
      const opts = i.options.length > 8 ? `one of ${i.options.length} allowed values (e.g. ${i.options.slice(0, 4).join(", ")})` : `one of ${i.options.join(", ")}`;
      return `${where}invalid value ${truncateInput(JSON.stringify(i.received), 40)}; expected ${opts}`;
    }
    return `${where}${truncateInput(i.message, 160)}`;
  });
  return shown.join("; ") + (issues.length > 5 ? `; … ${issues.length - 5} more` : "");
}

const SDK_VALIDATION = /^(?:MCP error -32602: )?Input validation error: Invalid arguments for tool ([\w.-]+): ([\s\S]*)$/;

/** Rewrite the SDK's raw-JSON input-validation text into `path: message` lines. */
export function shortenValidationText(text: string): string {
  const m = SDK_VALIDATION.exec(text);
  if (!m) return text;
  try {
    const issues = JSON.parse(m[2]!);
    if (Array.isArray(issues) && issues.every((i) => i && typeof i === "object" && typeof i.message === "string")) {
      return `Invalid arguments for ${m[1]} — ${formatZodIssues(issues.map((i) => ({ ...i, path: Array.isArray(i.path) ? i.path : [] })))}`;
    }
  } catch { /* not JSON: keep the SDK text */ }
  return truncateInput(text, 400);
}

/** Wrap the SDK's tools/call handler: a missing `arguments` is `{}` (it is optional in
 * the spec), and the SDK's raw-JSON validation errors become short `path: message` text. */
function hardenToolCalls(server: McpServer): void {
  const inner = server.server as unknown as { _requestHandlers?: Map<string, (req: unknown, extra: unknown) => Promise<unknown>> };
  const original = inner._requestHandlers?.get("tools/call");
  if (!original) return;
  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const params = request.params.arguments === undefined ? { ...request.params, arguments: {} } : request.params;
    const result = (await original({ ...request, params }, extra)) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
    if (result?.isError && Array.isArray(result.content)) {
      for (const c of result.content) if (c.type === "text" && typeof c.text === "string") c.text = shortenValidationText(c.text);
    }
    return result as never;
  });
}

export function friendlyError(err: unknown): string {
  if (err instanceof NotFoundError || err instanceof UserError) return err.message;
  if (err instanceof UpstreamError) {
    return `Alza upstream error (HTTP ${err.status}). ${err.message}`;
  }
  if (err instanceof ZodError) {
    return `Invalid arguments — ${formatZodIssues(err.issues as never)}`;
  }
  // Never suggest a blind retry: the request may already have changed something.
  if (err instanceof OutcomeUnknownError) return `Outcome unknown — ${err.message}`;
  if (err instanceof ConfigurationError) return `Configuration error: ${err.message}`;
  if (err instanceof Error) {
    if (err.message.includes("Timeout") || err.message.includes("timeout")) {
      return "Alza took too long to respond. The site may be slow right now. Retry a read; if the call changes something (order, payment, cart, account), check its current state before retrying — it may already have been applied.";
    }
    if (err.message.includes("net::") || err.message.includes("ERR_")) {
      return `Network error talking to Alza: ${err.message}`;
    }
    return `Error: ${err.message}`;
  }
  return "Unknown error";
}
