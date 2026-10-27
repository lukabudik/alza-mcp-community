import { Catalog } from "../src/domain/catalog.js";
import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.js";
import { ENVELOPE, OUTPUT_SCHEMAS } from "../src/tools/output-schemas.js";

// Keep the test deterministic: never read the developer's real token file.
process.env.ALZA_TOKEN_FILE = "none";

/**
 * Per-tool outputSchema contract (audit N-1, implemented 2026-09-13).
 * Verifies the schemas as actually published on tools/list and validated by
 * the SDK on real calls — in-memory transport, no network.
 */

async function clientAndServer() {
  const built = buildServer();
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "output-schema-test", version: "0" });
  // Server first (see tool-annotations.test.ts note).
  await built.server.connect(serverTransport);
  await client.connect(clientTransport);
  // Progressive disclosure (toolsets.ts): most tools start disabled to keep
  // the default tools/list small. Enable everything for these full-inventory checks.
  await client.callTool({ name: "set_toolset", arguments: { id: "all", enabled: true } });
  return { client, built };
}

describe("per-tool outputSchema (N-1)", () => {
  it("covers all 63 tools in the shared map", () => {
    const names = Object.keys(OUTPUT_SCHEMAS);
    expect(names).toHaveLength(63);
    for (const n of names) expect(OUTPUT_SCHEMAS[n]).toBeTruthy();
  });

  it("publishes an object outputSchema on every tool over the wire", async () => {
    const { client, built } = await clientAndServer();
    try {
      const res = await client.listTools();
      expect(res.tools).toHaveLength(66); // 63 domain tools + list_toolsets + set_toolset + report_issue
      for (const t of res.tools) {
        const os = t.outputSchema as Record<string, unknown> | undefined;
        expect(os, `missing outputSchema on ${t.name}`).toBeTruthy();
        expect(os!.type).toBe("object");
        expect(os!.properties ?? os!.anyOf).toBeTruthy();
      }
    } finally {
      await client.close();
      await built.close();
    }
  });

  it("describes the stable envelope keys on raw tools", async () => {
    const { client, built } = await clientAndServer();
    try {
      const res = await client.listTools();
      const os = res.tools.find((t) => t.name === "mobile_read")!.outputSchema as Record<string, unknown>;
      const props = os.properties as Record<string, unknown>;
      expect(Object.keys(props)).toEqual(expect.arrayContaining(["err", "msg", "data"]));
      // Zod 3 emits `true`, Zod 4 `{}`: both allow any extra key.
      expect([true, {}]).toContainEqual(os.additionalProperties);
      expect(String(os.description)).toContain("err 0/1/113");
    } finally {
      await client.close();
      await built.close();
    }
  });

  it("passes a real call through SDK output validation (account_status)", async () => {
    const { client, built } = await clientAndServer();
    try {
      const call = await client.callTool({ name: "account_status", arguments: {} });
      expect(call.isError).toBeFalsy();
      const sc = call.structuredContent as Record<string, unknown>;
      expect(sc.authenticated).toBe(false);
      expect(typeof sc.apiBaseUrl).toBe("string");
      expect((call.content as { type: string; text: string }[])[0].type).toBe("text");
    } finally {
      await client.close();
      await built.close();
    }
  });

  it("returns category brands through SDK output validation", async () => {
    const filters = { categoryId: 18842948, brands: [{ valueId: 1396, description: "Dell", count: 109 }], groups: [] };
    const mock = vi.spyOn(Catalog.prototype, "getCategoryFilters").mockResolvedValueOnce(filters);
    const { client, built } = await clientAndServer();
    try {
      const call = await client.callTool({ name: "list_category_filters", arguments: { category_id: filters.categoryId } });
      expect(call.isError).toBeFalsy();
      expect(call.structuredContent).toEqual({ category_id: filters.categoryId, brands: filters.brands, groups: [] });
      expect(mock).toHaveBeenCalledWith(filters.categoryId);
    } finally {
      mock.mockRestore();
      await client.close();
      await built.close();
    }
  });

  it("accepts every observed envelope shape in ENVELOPE", () => {
    // Shapes taken from docs/live-evidence/ captures (2026-09-08…09-12):
    expect(ENVELOPE.safeParse({ err: 0, basket: { items: [] } }).success).toBe(true); // basketInfo-style
    expect(ENVELOPE.safeParse({ err: 1, msg: "Neplatná objednávka", data: null }).success).toBe(true);
    expect(ENVELOPE.safeParse({ err: 113, msg: null }).success).toBe(true); // documented gate retry
    expect(ENVELOPE.safeParse({ err: "<!DOCTYPE html", msg: null }).success).toBe(true); // HTML error page capture
    expect(ENVELOPE.safeParse({ err: 0, msg: null, data: { a: 1 } }).success).toBe(true);
    // A response that is not an object (never observed) would fail validation —
    // the SDK surfaces that as a call-level validation error. Recorded, not forced.
    expect(ENVELOPE.safeParse([1, 2]).success).toBe(false);
    expect(ENVELOPE.safeParse("str").success).toBe(false);
  });

  it("accepts the typed shapes (auth_start, prepare_mutation, checkout_preview, web_pickup_places, catalog)", () => {
    const S = OUTPUT_SCHEMAS;
    expect(S.auth_start.safeParse({ authorizationUrl: "https://login.alza.cz/…", state: "abc" }).success).toBe(true);
    expect(S.prepare_mutation.safeParse({ action: "address_delete", confirmationToken: "hex24", expiresAt: "2026-10-07T12:05:00.000Z", payloadBound: true }).success).toBe(true);
    expect(S.checkout_preview.safeParse({ cart: { err: 0 }, deliveryPaymentGroups: {}, checkoutState: {}, confirmationToken: "hex24" }).success).toBe(true);
    expect(S.web_pickup_places.safeParse({ form: {}, places: [] }).success).toBe(true);
    expect(
      S.search_products.safeParse({ query: "notebook", total: 2, page: 1, pageSize: 10, products: [{ code: "WEXOA002B0", id: 1, name: "n", url: "u", currency: "CZK" }] }).success,
    ).toBe(true);
    expect(S.get_product.safeParse({ product: { code: "c", id: 1, name: "n", url: "u", currency: "CZK" } }).success).toBe(true);
    expect(S.get_product_reviews.safeParse({ code: "c", ratingAverage: 4.5, reviewCount: 3, reviews: [{ rating: 5 }] }).success).toBe(true);
    expect(S.list_categories.safeParse({ categories: [{ id: 1, name: "n" }] }).success).toBe(true);
    expect(S.find_pickup_points.safeParse({ points: [{ type: "branch", id: "1", name: "n", address: "a", city: "c" }] }).success).toBe(true);
  });
});
