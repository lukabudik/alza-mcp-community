import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisterableTool, ToolResult } from "./types.js";

/**
 * Progressive tool disclosure (MCP client-best-practices S3; Anthropic's
 * "few thoughtful tools" guidance, S4/S5 in docs/mcp-best-practices-audit.md):
 * with 63 domain tools, listing everything on every `tools/list` call
 * front-loads an agent's context with dozens of tools it may never touch in
 * a given conversation. Instead, only `catalog` (product discovery) and
 * `auth` (the bootstrap/handshake tools every other flow needs first) are
 * enabled by default; everything else is registered but starts disabled —
 * discoverable via `list_toolsets` and turned on with `set_toolset` once the
 * conversation actually needs it. The SDK's `RegisteredTool.enable()`/
 * `.disable()` fire the standard `notifications/tools/list_changed`
 * notification, so clients that support it see the change live.
 *
 * Every one of the 63 domain tool names must appear in exactly one group below —
 * `registerToolsets` asserts this at startup so a newly added tool can never
 * be silently unreachable (AGENTS.md: never silently omit an operation).
 */
export interface ToolsetDef {
  id: string;
  title: string;
  description: string;
  defaultEnabled: boolean;
  tools: string[];
}

export const TOOLSET_DEFS: ToolsetDef[] = [
  {
    id: "catalog",
    title: "Catalog & discovery",
    description: "Search suggestions, search, product detail, side-by-side comparison, alternatives, deals, reviews, categories, and AlzaShop pickup-point lookup. Read-only, no account needed.",
    defaultEnabled: true,
    tools: ["search_products", "get_product", "compare_products", "get_product_reviews", "recommend_alternatives", "find_pickup_points", "list_categories", "list_category_filters", "get_deals", "autocomplete"],
  },
  {
    id: "auth",
    title: "Auth & bootstrap",
    description: "OAuth handshake, account status, and the one-time mutation-token issuer every other toolset's writes require. Enable this first if you need anything beyond catalog browsing.",
    defaultEnabled: true,
    tools: ["auth_discovery", "auth_start", "auth_exchange", "account_status", "prepare_mutation"],
  },
  {
    id: "basket_and_checkout",
    title: "Basket, delivery & checkout",
    description: "Add to cart, delivery/pickup-point selection, checkout preview, order placement (mobile and web-WCF paths), and order cancellation. Enable when the user wants to actually buy or cancel something.",
    defaultEnabled: false,
    tools: [
      "cart", "add_to_cart", "delivery_options", "select_pickup_point", "checkout_preview", "place_order",
      "web_add_to_cart", "web_cart", "web_pickup_places", "web_place_order", "cancel_order", "mutate_list",
    ],
  },
  {
    id: "account_management",
    title: "Account & profile management",
    description: "Profile, contacts, addresses, registration, and credential/identity changes (password, 2FA, phone, email, account deletion). Enable for account-settings tasks.",
    defaultEnabled: false,
    tools: [
      "profile", "contacts", "register", "address_upsert", "address_delete", "address_search",
      "change_password", "two_factor_set", "phone_change", "email_change", "delete_account", "gdpr_info",
    ],
  },
  {
    id: "orders_and_payments",
    title: "Orders & payments",
    description: "Reading past orders, payment methods, after-order payment execution, warranty claims, and invoice documents. Enable for post-purchase / order-history tasks.",
    defaultEnabled: false,
    tools: [
      "payment_methods", "after_order_payments", "pay_after_order", "web_pay_after_order",
      "order", "order_search", "order_archive", "order_document", "claim_detail",
    ],
  },
  {
    id: "reviews_and_subscriptions",
    title: "Reviews, complaints, subscriptions & attachments",
    description: "Submitting reviews, listing complaints, AlzaSubscription management, attachment uploads, and EAN product lookup.",
    defaultEnabled: false,
    tools: [
      "review_submit", "complaint_claims", "subscription_overview", "subscription_activate",
      "subscription_update_installment", "upload_attachment", "product_by_ean",
    ],
  },
  {
    id: "watchdogs",
    title: "Price & stock watchdogs",
    description: "Alza's native watchdog (\"Hlídací pes\"): list, set, and delete price-drop / back-in-stock alerts that Alza emails to the account. Enable for \"tell me when this gets cheaper / is back in stock\" requests.",
    defaultEnabled: false,
    tools: ["watchdog_list", "watchdog_set", "watchdog_delete"],
  },
  {
    id: "chat",
    title: "Alza chat assistant",
    description: "Alza's own in-app chatbot navigation and message sending. Narrow, rarely needed outside a chat-support task.",
    defaultEnabled: false,
    tools: ["chat_navigation", "chat_send"],
  },
  {
    id: "pc_builder",
    title: "PC builder",
    description: "Compatibility-checked PC parts lists from live Alza stock: `pc_build_check` (check a parts list) and `pc_build_suggest` (propose a build within a budget). Slow composite workflows (many product-page loads) — enable when the user wants to build or check a PC.",
    defaultEnabled: false,
    tools: ["pc_build_check", "pc_build_suggest"],
  },
  {
    id: "advanced_raw",
    title: "Raw mobile-API escape hatch",
    description: "`mobile_read`: untyped read access to any mobile-API operation without a dedicated tool. Enable only when a typed tool genuinely doesn't cover what's needed.",
    defaultEnabled: false,
    tools: ["mobile_read"],
  },
];

/**
 * Toolsets a deployment refuses to expose at all, keyed by toolset id, with the
 * human-readable reason. A locked toolset starts disabled, `set_toolset` refuses
 * to enable it (returning the reason), and `list_toolsets` reports the reason —
 * so the operations stay discoverable/documented (AGENTS.md) without being
 * callable. Used by the Streamable HTTP transport (src/http.ts) to keep the
 * account/checkout stack off a shared instance unless explicitly opted in.
 */
export type LockedToolsets = Readonly<Record<string, string>>;

/**
 * Parse `ALZA_TOOLSETS` (comma/space-separated toolset ids, or `all`): toolsets
 * to enable at startup, on top of the defaults. For MCP clients that never
 * re-fetch the tool list after `notifications/tools/list_changed` (reported
 * 2026-10-11 for Grok Bot: `set_toolset` succeeded but the client kept showing
 * the 13 default tools), the only way to reach the basket/order tools is to
 * have them visible from the first `tools/list`. Unknown ids are a startup
 * error so a typo cannot silently leave a toolset hidden.
 */
export function parseToolsetsEnv(raw: string | undefined): string[] {
  const ids = (raw ?? "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  const known = TOOLSET_DEFS.map((d) => d.id);
  for (const id of ids) {
    if (id !== "all" && !known.includes(id)) {
      throw new Error(`ALZA_TOOLSETS: unknown toolset "${id}" (known: all, ${known.join(", ")})`);
    }
  }
  return ids.includes("all") ? known : [...new Set(ids)];
}

/** Registered by registerToolsets itself rather than passed in `allTools`. */
export const TOOLSET_META_TOOLS = ["list_toolsets", "set_toolset", "report_issue"];

export function registerToolsets(
  server: McpServer,
  errorWrap: (name: string, fn: () => Promise<ToolResult>) => Promise<ToolResult>,
  allTools: RegisterableTool[],
  locked: LockedToolsets = {},
  /** Toolset ids enabled at startup in addition to the defaults (see parseToolsetsEnv). Locked ids are skipped. */
  initiallyEnabled: readonly string[] = [],
  /** ALZA_TOOLS_ALLOW (see allowlist.ts): when set, every other tool is removed and these start enabled. */
  allowedTools?: ReadonlySet<string>
): void {
  for (const id of Object.keys(locked)) {
    if (!TOOLSET_DEFS.some((d) => d.id === id)) throw new Error(`toolset config error: cannot lock unknown toolset "${id}"`);
  }
  for (const id of initiallyEnabled) {
    if (!TOOLSET_DEFS.some((d) => d.id === id)) throw new Error(`toolset config error: cannot enable unknown toolset "${id}"`);
  }
  const startEnabled = new Set(initiallyEnabled.filter((id) => locked[id] === undefined));
  const groupByTool = new Map<string, ToolsetDef>();
  for (const def of TOOLSET_DEFS) {
    for (const name of def.tools) {
      if (groupByTool.has(name)) {
        throw new Error(`toolset config error: "${name}" appears in both "${groupByTool.get(name)!.id}" and "${def.id}"`);
      }
      groupByTool.set(name, def);
    }
  }
  const allNames = new Set(allTools.map((t) => t.name));
  for (const name of allNames) {
    if (!groupByTool.has(name)) throw new Error(`toolset config error: "${name}" is registered but not assigned to any toolset`);
  }
  for (const name of groupByTool.keys()) {
    if (!allNames.has(name)) throw new Error(`toolset config error: "${name}" is assigned to a toolset but never registered`);
  }

  for (const name of allowedTools ?? []) {
    if (!allNames.has(name) && !TOOLSET_META_TOOLS.includes(name)) throw new Error(`ALZA_TOOLS_ALLOW: unknown tool "${name}"`);
  }
  const isAllowed = (name: string) => !allowedTools || allowedTools.has(name);

  const registered = new Map<string, RegisteredTool>();
  for (const tool of allTools) {
    registered.set(tool.name, tool.register(server, errorWrap));
  }
  for (const [name, def] of groupByTool) {
    const t = registered.get(name)!;
    if (!isAllowed(name)) {
      t.remove();
      registered.delete(name);
    } else if (locked[def.id] !== undefined || (!allowedTools && !def.defaultEnabled && !startEnabled.has(def.id))) {
      t.disable();
    }
  }
  // What each toolset still contains after the allowlist; empty toolsets are dropped.
  const defs = TOOLSET_DEFS.map((d) => ({ ...d, tools: d.tools.filter((n) => registered.has(n)) })).filter((d) => d.tools.length > 0);

  const toolsetIds = defs.map((d) => d.id);

  if (isAllowed("list_toolsets")) server.registerTool(
    "list_toolsets",
    {
      title: "List available toolsets",
      description:
        "List every toolset this server groups its tools into: id, title, description, member tool names, and whether it's currently enabled. " +
        "Only `catalog` and `auth` are enabled by default to keep the visible tool list small — use `set_toolset` to turn on the group a task actually needs (e.g. `basket_and_checkout` before placing an order). " +
        "If your client does not refresh its tool list after `set_toolset` (it ignores `notifications/tools/list_changed`), the operator can start the server with `ALZA_TOOLSETS=basket_and_checkout,orders_and_payments` (or `all`) so those tools are visible from the start. " +
        "Call this first if you're unsure which toolset covers what you need. Read-only, no network call.",
      inputSchema: {},
      outputSchema: {
        toolsets: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            description: z.string(),
            enabled: z.boolean(),
            tools: z.array(z.string()),
            locked: z.string().optional().describe("Present when this deployment refuses to enable the toolset; the reason why."),
          })
        ),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () =>
      errorWrap("list_toolsets", async () => {
        const toolsets = defs.map((def) => ({
          id: def.id,
          title: def.title,
          description: def.description,
          enabled: def.tools.every((name) => registered.get(name)!.enabled),
          tools: def.tools,
          ...(locked[def.id] !== undefined ? { locked: locked[def.id] } : {}),
        }));
        const lines = toolsets.map((t) => `- \`${t.id}\` (${t.locked !== undefined ? `locked: ${t.locked}` : t.enabled ? "enabled" : "disabled"}): ${t.title} — ${t.tools.join(", ")}`);
        return {
          content: [{ type: "text", text: `Toolsets:\n${lines.join("\n")}` }],
          structuredContent: { toolsets },
        };
      })
  );

  if (isAllowed("set_toolset") && toolsetIds.length > 0) server.registerTool(
    "set_toolset",
    {
      title: "Enable or disable a toolset",
      description:
        "Enable or disable every tool in one toolset (or `all` for every toolset) at once, so only the tools relevant to the current task are visible. " +
        "Call `list_toolsets` first to see the available ids. Changing this fires the standard MCP tools-list-changed notification; clients that ignore it keep their old tool list — then the operator should set `ALZA_TOOLSETS` (see `list_toolsets`) and restart the server instead. " +
        "No Alza-side effect — this only changes which tools this MCP server currently exposes to you.",
      inputSchema: {
        id: z.enum(["all", ...toolsetIds] as [string, ...string[]]).describe("Toolset id from `list_toolsets`, or \"all\"."),
        enabled: z.boolean().describe("true to enable, false to disable."),
      },
      outputSchema: {
        id: z.string(),
        enabled: z.boolean(),
        tools_affected: z.array(z.string()),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args: { id: string; enabled: boolean }) =>
      errorWrap("set_toolset", async () => {
        const chosen = args.id === "all" ? defs : defs.filter((d) => d.id === args.id);
        if (chosen.length === 0) throw new Error(`Unknown toolset id: ${args.id}`);
        if (args.enabled && args.id !== "all" && locked[args.id] !== undefined) {
          throw new Error(`Toolset "${args.id}" is locked on this deployment: ${locked[args.id]}`);
        }
        const affected: string[] = [];
        const skipped: string[] = [];
        for (const def of chosen) {
          // `all` + enabled skips locked groups instead of failing the whole call.
          if (args.enabled && locked[def.id] !== undefined) { skipped.push(def.id); continue; }
          for (const name of def.tools) {
            const t = registered.get(name)!;
            if (args.enabled) t.enable(); else t.disable();
            affected.push(name);
          }
        }
        return {
          content: [{
            type: "text",
            text: `${args.enabled ? "Enabled" : "Disabled"} ${affected.length} tool(s) in "${args.id}".` +
              (skipped.length ? ` Skipped locked toolset(s): ${skipped.join(", ")} (see list_toolsets).` : ""),
          }],
          structuredContent: { id: args.id, enabled: args.enabled, tools_affected: affected },
        };
      })
  );
}
