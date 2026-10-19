import { describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CreateMessageRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Product } from "../src/domain/types.js";
import {
  SUMMARY_MAX_TOKENS,
  buildComparisonTable,
  createCompareProductsTool,
  formatComparisonMarkdown,
  mapWithConcurrency,
  summarizeComparison,
} from "../src/tools/compare-products.js";
import { COMPARE_PRODUCTS_OUTPUT } from "../src/tools/output-schemas.js";
import type { ToolDeps, ToolResult } from "../src/tools/types.js";

function product(code: string, extra: Partial<Product> = {}): Product {
  return { code, id: 0, name: `Product ${code}`, url: `https://www.alza.cz/${code}`, currency: "CZK", ...extra };
}

const A = product("AAA1", {
  price: 9990,
  originalPrice: 10990,
  availability: "InStock",
  rating: 4.66,
  params: [
    { name: "Úhlopříčka", value: "27\"" },
    { name: "Obnovovací frekvence", value: "165 Hz" },
  ],
});
const B = product("BBB2", {
  price: 8990,
  availability: "OutOfStock",
  params: [
    { name: "Úhlopříčka", value: "27\"" },
    { name: "Typ panelu", value: "IPS | matný" },
  ],
});

describe("buildComparisonTable (pure alignment)", () => {
  it("puts price/availability/rating first, then the union of spec names in first-seen order", () => {
    const t = buildComparisonTable([
      { code: "AAA1", product: A },
      { code: "BBB2", product: B },
    ]);
    expect(t.rows.map((r) => r.name)).toEqual(["Price", "Availability", "Rating", "Brand", "Úhlopříčka", "Obnovovací frekvence", "Typ panelu"]);
    expect(t.rows[0]!.values).toEqual(["9\u00a0990 CZK (was 10\u00a0990 CZK)", "8\u00a0990 CZK"]);
    expect(t.rows[2]!.values).toEqual(["4.7/5", null]);
    expect(t.rows.find((r) => r.name === "Obnovovací frekvence")!.values).toEqual(["165 Hz", null]);
    expect(t.rows.find((r) => r.name === "Typ panelu")!.values).toEqual([null, "IPS | matný"]);
    expect(t.products).toEqual([
      { code: "AAA1", ok: true, name: "Product AAA1", url: "https://www.alza.cz/AAA1" },
      { code: "BBB2", ok: true, name: "Product BBB2", url: "https://www.alza.cz/BBB2" },
    ]);
  });

  it("keeps a failed product as its own column with null cells", () => {
    const t = buildComparisonTable([
      { code: "AAA1", product: A },
      { code: "BAD", error: "product BAD not found" },
      { code: "BBB2", product: B },
    ]);
    expect(t.products[1]).toEqual({ code: "BAD", ok: false, error: "product BAD not found" });
    for (const row of t.rows) {
      expect(row.values).toHaveLength(3);
      expect(row.values[1]).toBeNull();
    }
  });

  it("matches spec names exactly (no fuzzy merging) and ignores duplicate names within one product", () => {
    const t = buildComparisonTable([
      { code: "X", product: product("X", { params: [{ name: "Hmotnost", value: "1 kg" }, { name: "Hmotnost", value: "2 kg" }] }) },
      { code: "Y", product: product("Y", { params: [{ name: "Hmotnost (kg)", value: "1.5" }] }) },
    ]);
    expect(t.rows.slice(4)).toEqual([
      { name: "Hmotnost", values: ["1 kg", null] },
      { name: "Hmotnost (kg)", values: [null, "1.5"] },
    ]);
  });

  it("validates against the published output schema", () => {
    const t = buildComparisonTable([{ code: "AAA1", product: A }, { code: "BAD", error: "x" }]);
    expect(() => COMPARE_PRODUCTS_OUTPUT.parse(t)).not.toThrow();
  });
});

describe("formatComparisonMarkdown", () => {
  it("renders an aligned table, escapes pipes, lists errors and links", () => {
    const md = formatComparisonMarkdown(
      buildComparisonTable([
        { code: "AAA1", product: A },
        { code: "BAD", error: "product BAD not found" },
        { code: "BBB2", product: B },
      ])
    );
    const tableLines = md.split("\n").filter((l) => l.startsWith("|"));
    const cols = (l: string) => l.replace(/\\\|/g, "").split("|").length;
    for (const l of tableLines) expect(cols(l)).toBe(cols(tableLines[0]!));
    expect(md).toContain("IPS \\| matný");
    expect(md).toContain("| Spec | [Product AAA1](https://www.alza.cz/AAA1) (AAA1) | BAD (error) | [Product BBB2](https://www.alza.cz/BBB2) (BBB2) |");
    expect(md).toContain("- BAD: product BAD not found");
    expect(md).toContain("- AAA1: https://www.alza.cz/AAA1");
  });

  it("says so when nothing could be fetched", () => {
    expect(formatComparisonMarkdown(buildComparisonTable([{ code: "X", error: "boom" }, { code: "Y", error: "boom" }]))).toMatch(
      /^No product could be fetched\./
    );
  });
});

describe("mapWithConcurrency", () => {
  it("never exceeds the limit and preserves order", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5 * (7 - n)));
      inFlight--;
      return n * 10;
    });
    expect(peak).toBe(2);
    expect(out).toEqual([10, 20, 30, 40, 50, 60]);
  });
});

describe("summarizeComparison", () => {
  const table = buildComparisonTable([{ code: "AAA1", product: A }, { code: "BBB2", product: B }]);

  it("does not call createMessage when the client lacks sampling", async () => {
    const createMessage = vi.fn();
    const s = await summarizeComparison({ getClientCapabilities: () => ({}), createMessage }, table);
    expect(s.status).toBe("unavailable");
    expect(createMessage).not.toHaveBeenCalled();
  });

  it("reports a sampling failure without throwing", async () => {
    const s = await summarizeComparison(
      { getClientCapabilities: () => ({ sampling: {} }), createMessage: async () => Promise.reject(new Error("user declined")) },
      table
    );
    expect(s).toEqual({ status: "failed", reason: "user declined" });
  });
});

/** Registers only compare_products on a fresh server with a stubbed catalog (no network). */
async function connect(withSampling: boolean, onSample?: (params: unknown) => void) {
  const getProduct = vi.fn(async (code: string) => {
    if (code === "AAA1") return A;
    if (code === "BBB2") return B;
    throw new Error(`product ${code} not found`);
  });
  const deps = { catalog: { getProduct } } as unknown as ToolDeps;
  const server = new McpServer({ name: "t", version: "0" }, { capabilities: { tools: {} } });
  const errorWrap = async (_: string, fn: () => Promise<ToolResult>) => fn();
  createCompareProductsTool(deps).register(server, errorWrap);

  const client = new Client({ name: "t", version: "0" }, { capabilities: withSampling ? { sampling: {} } : {} });
  if (withSampling) {
    client.setRequestHandler(CreateMessageRequestSchema, async (req) => {
      onSample?.(req.params);
      return { model: "mock-llm", role: "assistant", content: { type: "text", text: "BBB2 is 1000 CZK cheaper; AAA1 is in stock." } };
    });
  }
  const [st, ct] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  return { client, getProduct, close: () => client.close() };
}

describe("compare_products tool (in-memory client)", () => {
  it("returns the table and per-product errors; no summary unless asked", async () => {
    const { client, getProduct, close } = await connect(false);
    try {
      const res = await client.callTool({ name: "compare_products", arguments: { codes: ["AAA1", "NOPE", "BBB2", "AAA1"] } });
      expect(res.isError).toBeFalsy();
      const sc = res.structuredContent as { products: Array<{ code: string; ok: boolean }>; summary?: unknown };
      expect(sc.products.map((p) => [p.code, p.ok])).toEqual([["AAA1", true], ["NOPE", false], ["BBB2", true]]);
      expect(sc.summary).toBeUndefined();
      expect(getProduct).toHaveBeenCalledTimes(3);
    } finally {
      await close();
    }
  });

  it("rejects fewer than 2 or more than 6 codes", async () => {
    const { client, close } = await connect(false);
    try {
      const one = await client.callTool({ name: "compare_products", arguments: { codes: ["AAA1"] } });
      expect(one.isError).toBe(true);
      const seven = await client.callTool({ name: "compare_products", arguments: { codes: ["1", "2", "3", "4", "5", "6", "7"] } });
      expect(seven.isError).toBe(true);
    } finally {
      await close();
    }
  });

  it("summarize:true without the sampling capability returns the table, no error", async () => {
    const { client, close } = await connect(false);
    try {
      const res = await client.callTool({ name: "compare_products", arguments: { codes: ["AAA1", "BBB2"], summarize: true } });
      expect(res.isError).toBeFalsy();
      const sc = res.structuredContent as { rows: unknown[]; summary: { status: string } };
      expect(sc.rows.length).toBeGreaterThan(3);
      expect(sc.summary.status).toBe("unavailable");
    } finally {
      await close();
    }
  });

  it("summarize:true with sampling asks the client LLM with only the table and a bounded maxTokens", async () => {
    let seen: { maxTokens: number; systemPrompt?: string; includeContext?: string; messages: Array<{ content: { text: string } }> } | undefined;
    const { client, close } = await connect(true, (p) => (seen = p as typeof seen));
    try {
      const res = await client.callTool({ name: "compare_products", arguments: { codes: ["AAA1", "BBB2"], summarize: true } });
      const sc = res.structuredContent as { summary: { status: string; text: string; model: string } };
      expect(sc.summary).toEqual({ status: "generated", text: "BBB2 is 1000 CZK cheaper; AAA1 is in stock.", model: "mock-llm" });
      expect(seen!.maxTokens).toBe(SUMMARY_MAX_TOKENS);
      expect(seen!.includeContext).toBe("none");
      expect(seen!.systemPrompt).toMatch(/ONLY the data/);
      expect(seen!.messages[0]!.content.text).toMatch(/\| Spec \| \[Product AAA1\]\(https:\/\/www\.alza\.cz\/AAA1[^)]*\) \(AAA1\) \| \[Product BBB2\]\(https:\/\/www\.alza\.cz\/BBB2[^)]*\) \(BBB2\) \|/);
      const text = (res.content as Array<{ text: string }>)[0]!.text;
      expect(text).toContain("BBB2 is 1000 CZK cheaper");
    } finally {
      await close();
    }
  });

  it("does not sample when summarize is omitted, even if the client supports it", async () => {
    const onSample = vi.fn();
    const { client, close } = await connect(true, onSample);
    try {
      await client.callTool({ name: "compare_products", arguments: { codes: ["AAA1", "BBB2"] } });
      expect(onSample).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });
});
