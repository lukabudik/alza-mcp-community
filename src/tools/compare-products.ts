import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClientCapabilities, CreateMessageRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Product } from "../domain/types.js";
import { OUTPUT_SCHEMAS } from "./output-schemas.js";
import type { RegisterableTool, ToolDeps } from "./types.js";
import { tagLinks } from "./tracking.js";
import { raceDeadline, TOOL_BUDGET_MS } from "../infra/deadline.js";
import { conditionTag, formatPrice as formatMoney } from "./format.js";

/** Product-page loads run at most this many at a time (issue #11: 2–3, polite to Cloudflare). */
export const COMPARE_CONCURRENCY = 3;
export const COMPARE_MIN_CODES = 2;
export const COMPARE_MAX_CODES = 6;
/** Upper bound on the sampled verdict (issue #18: bounded `maxTokens`). */
export const SUMMARY_MAX_TOKENS = 400;

export interface CompareEntry {
  /** The code exactly as requested (trimmed). */
  code: string;
  product?: Product;
  error?: string;
}

export interface ComparisonColumn {
  code: string;
  ok: boolean;
  name?: string;
  url?: string;
  error?: string;
}

export interface ComparisonRow {
  name: string;
  /** One cell per column, in column order; null = this product has no value for the row. */
  values: Array<string | null>;
}

export interface ComparisonTable {
  products: ComparisonColumn[];
  rows: ComparisonRow[];
}

export const FIXED_ROWS = ["Price", "Availability", "Rating", "Brand"] as const;

function formatPrice(p: Product): string | null {
  if (p.price === undefined) return null;
  const base = formatMoney(p.price, p.currency);
  if (p.condition) return `${base} ⚠ ${conditionTag(p)}${p.priceNow !== undefined && p.promoCode ? `; ${formatMoney(p.priceNow, p.currency)} with code ${p.promoCode}` : ""}`;
  if (p.priceNow !== undefined && p.promoCode) return `**${formatMoney(p.priceNow, p.currency)}** with code ${p.promoCode} (shelf ${base})`;
  return p.originalPrice !== undefined && p.originalPrice > p.price ? `${base} (was ${formatMoney(p.originalPrice, p.currency)})` : base;
}

function fixedValue(row: (typeof FIXED_ROWS)[number], p: Product): string | null {
  switch (row) {
    case "Price":
      return formatPrice(p);
    case "Availability":
      return p.availability ? `${p.availability}${p.availabilityText ? ` (${p.availabilityText})` : ""}${p.jsonLdAvailability ? ` [structured data says: ${p.jsonLdAvailability}]` : ""}` : null;
    case "Rating":
      return p.rating !== undefined ? `${Math.round(p.rating * 10) / 10}/5` : null;
    case "Brand":
      return p.brand ?? null;
  }
}

/**
 * Pure alignment step: one column per requested code, one row per spec name
 * present in ANY successfully fetched product. Price, availability and rating
 * come first; spec rows follow in first-seen order (column order, then each
 * product's own param order). Names are matched exactly (no fuzzy matching —
 * issue #11 v1). A failed product contributes a column with `ok: false` and
 * null cells, never a whole-call error.
 */
export function buildComparisonTable(entries: CompareEntry[]): ComparisonTable {
  const products: ComparisonColumn[] = entries.map((e) =>
    e.product
      ? { code: e.code, ok: true, name: e.product.name, url: e.product.url }
      : { code: e.code, ok: false, error: e.error ?? "unknown error" }
  );

  const rows: ComparisonRow[] = FIXED_ROWS.map((row) => ({
    name: row,
    values: entries.map((e) => (e.product ? fixedValue(row, e.product) : null)),
  }));

  const order: string[] = [];
  const byColumn: Array<Map<string, string>> = entries.map((e) => {
    const m = new Map<string, string>();
    for (const param of e.product?.params ?? []) {
      const name = param.name.trim();
      if (!name || m.has(name)) continue;
      m.set(name, param.value);
      if (!order.includes(name)) order.push(name);
    }
    return m;
  });
  for (const name of order) {
    rows.push({ name, values: byColumn.map((m) => m.get(name) ?? null) });
  }
  return { products, rows };
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
}

/** Markdown rendering of the aligned table (`content[].text`). */
export function formatComparisonMarkdown(table: ComparisonTable): string {
  const ok = table.products.filter((p) => p.ok);
  const lines: string[] = [];
  if (ok.length > 0) {
    const header = ["Spec", ...table.products.map((p) => cell(p.ok ? (p.url ? `[${p.name ?? p.code}](${p.url}) (${p.code})` : `${p.name ?? p.code} (${p.code})`) : `${p.code} (error)`))];
    lines.push(`| ${header.join(" | ")} |`);
    lines.push(`|${header.map(() => "---").join("|")}|`);
    for (const row of table.rows) {
      if (row.values.every((v) => v === null)) continue;
      lines.push(`| ${[cell(row.name), ...row.values.map((v) => (v === null ? "—" : cell(v)))].join(" | ")} |`);
    }
  } else {
    lines.push("No product could be fetched.");
  }
  const failed = table.products.filter((p) => !p.ok);
  if (failed.length > 0) {
    lines.push("", "Errors:");
    for (const f of failed) lines.push(`- ${f.code}: ${f.error}`);
  }
  const links = ok.filter((p) => p.url);
  if (links.length > 0) {
    lines.push("", "Links:");
    for (const p of links) lines.push(`- ${p.code}: ${p.url}`);
  }
  return lines.join("\n");
}

/** Runs `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export interface ComparisonSummary {
  status: "generated" | "unavailable" | "failed";
  text?: string;
  model?: string;
  reason?: string;
}

/** The subset of the low-level SDK `Server` the summary step needs (mockable). */
export interface SamplingHost {
  getClientCapabilities(): ClientCapabilities | undefined;
  createMessage(params: CreateMessageRequest["params"], options?: { signal?: AbortSignal }): Promise<{ model: string; content: unknown }>;
}

export const SUMMARY_SYSTEM_PROMPT =
  "You compare products for a shopper. Use ONLY the data in the comparison table the user provides. " +
  "Do not use outside knowledge, do not guess missing values, and do not invent specs, prices or reviews. " +
  "A cell shown as — means the value is unknown. Answer in 2–4 short sentences: which product wins on which concrete rows, " +
  "with numbers from the table. Answer in the language of the table's spec names.";

function samplingText(content: unknown): string {
  const blocks = Array.isArray(content) ? content : [content];
  return blocks
    .map((b) => (b && typeof b === "object" && (b as { type?: unknown }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
    .join("\n")
    .trim();
}

/**
 * Optional sampled verdict (issue #18). Pure enhancement: never throws, and
 * a client without the `sampling` capability just gets `status: "unavailable"`.
 * The model sees the Markdown table and nothing else (`includeContext: "none"`).
 */
export async function summarizeComparison(host: SamplingHost, table: ComparisonTable, signal?: AbortSignal): Promise<ComparisonSummary> {
  if (!host.getClientCapabilities()?.sampling) {
    return { status: "unavailable", reason: "client does not advertise the MCP sampling capability" };
  }
  if (table.products.filter((p) => p.ok).length < 2) {
    return { status: "unavailable", reason: "fewer than two products were fetched successfully" };
  }
  try {
    const result = await host.createMessage(
      {
        systemPrompt: SUMMARY_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: { type: "text", text: `Comparison table:\n\n${formatComparisonMarkdown(table)}\n\nSummarise the trade-offs using only this table.` },
          },
        ],
        maxTokens: SUMMARY_MAX_TOKENS,
        includeContext: "none",
        temperature: 0,
      },
      { signal }
    );
    const text = samplingText(result.content);
    if (!text) return { status: "failed", reason: "client returned no text content" };
    return { status: "generated", text, model: result.model };
  } catch (err) {
    return { status: "failed", reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Trim and de-duplicate codes (case-insensitively, keeping the first spelling); returns what was dropped. */
export function dedupeCodes(input: string[]): { codes: string[]; duplicates: string[] } {
  const seen = new Set<string>();
  const codes: string[] = [];
  const duplicates: string[] = [];
  for (const raw of input) {
    const c = raw.trim();
    const key = c.toLowerCase();
    if (seen.has(key)) {
      if (!duplicates.includes(c)) duplicates.push(c);
      continue;
    }
    seen.add(key);
    codes.push(c);
  }
  return { codes, duplicates };
}

const inputSchema = {
  codes: z
    .array(z.string().trim().min(1))
    .min(COMPARE_MIN_CODES)
    .max(COMPARE_MAX_CODES)
    .describe(
      "2–6 Alza product codes to compare side by side, e.g. ['WEXOA002B0', 'JA190b1']. These are the `code` values from `search_products` (not numeric ids). Duplicates (same code, any letter case) are collapsed and reported; at least 2 distinct codes are required."
    ),
  summarize: z
    .boolean()
    .optional()
    .describe(
      "Opt-in: also ask your own client LLM (MCP sampling) for a short verdict grounded only in the table. Ignored with `summary.status: \"unavailable\"` when the client does not support sampling — the table is always returned."
    ),
};

export function createCompareProductsTool(deps: ToolDeps): RegisterableTool {
  const name = "compare_products";
  return {
    name,
    register(server: McpServer, errorWrap) {
      return server.registerTool(
        name,
        {
          title: "Compare products side by side",
          description:
            "Fetch 2–6 products by their Alza codes (the `code` from `search_products`) and return one aligned comparison table: a column per product, " +
            "rows for price, availability, rating and brand, then every spec row present in any of them (exact spec-name matching; a product missing a row shows —). " +
            "Use instead of calling `get_product` repeatedly when the user asks which of several candidates is better. " +
            "A code that fails to load is reported in its own column (`ok: false`, `error`) while the others still compare. " +
            "Pages load at most two at a time, so 6 products take roughly 15–30 s on a cold cache. " +
            "Optional `summarize: true` adds a short verdict generated by your client's LLM via MCP sampling, grounded only in the table (skipped, not an error, when sampling is unsupported). Read-only.",
          inputSchema,
          outputSchema: OUTPUT_SCHEMAS["compare_products"],
          annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
        },
        async (args, extra) =>
          errorWrap(name, async () => {
            const { codes, duplicates } = dedupeCodes(args.codes);
            if (codes.length < COMPARE_MIN_CODES) {
              throw new Error(
                `compare_products needs at least ${COMPARE_MIN_CODES} distinct product codes, but only ${codes.length} remained after removing duplicates (${duplicates.join(", ") || "none"}). Pass different codes.`
              );
            }
            // Hosts give up on a tool call after ~60 s: report products that do not
            // finish in time instead of failing the whole call. They keep loading
            // into the product cache, so a retry with the same codes is fast.
            const deadline = Date.now() + TOOL_BUDGET_MS;
            const entries = await mapWithConcurrency(codes, COMPARE_CONCURRENCY, async (code): Promise<CompareEntry> => {
              try {
                const got = await raceDeadline(deps.catalog.getProduct(code), deadline);
                if ("timedOut" in got) return { code, error: "not loaded within the time budget — call compare_products again with the same codes (loaded pages are cached), or compare fewer products at once" };
                return { code, product: tagLinks(got.value) };
              } catch (err) {
                return { code, error: err instanceof Error ? err.message : String(err) };
              }
            });
            const table = buildComparisonTable(entries);
            let text = formatComparisonMarkdown(table);
            if (duplicates.length > 0) text = `${text}\n\nDuplicate codes ignored: ${duplicates.join(", ")}.`;
            const structured: Record<string, unknown> = {
              products: table.products,
              rows: table.rows,
              ...(duplicates.length > 0 ? { duplicatesIgnored: duplicates } : {}),
            };
            if (args.summarize) {
              const summary = await summarizeComparison(server.server, table, extra.signal);
              structured.summary = summary;
              if (summary.status === "generated") text = `${text}\n\nSummary (generated by ${summary.model} via MCP sampling, from the table above only):\n${summary.text}`;
              else text = `${text}\n\n(Summary not generated: ${summary.reason}.)`;
            }
            return { content: [{ type: "text", text }], structuredContent: structured };
          })
      );
    },
  };
}
