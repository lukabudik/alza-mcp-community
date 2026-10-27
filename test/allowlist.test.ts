import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MobileAccount } from "../src/domain/mobile-account.js";
import { MobileApi } from "../src/infra/mobile-api.js";
import { buildServer, type BuildOptions } from "../src/server.js";
import { parseMutationActionsAllowEnv, parseToolsAllowEnv } from "../src/tools/allowlist.js";

process.env.ALZA_TOKEN_FILE = "none";

async function connected(opts: BuildOptions) {
  const built = buildServer(opts);
  const [s, c] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "allowlist", version: "0" });
  await built.server.connect(s);
  await client.connect(c);
  return { client, built };
}
const text = (res: unknown) => ((res as { content: { text: string }[] }).content[0]?.text) ?? "";

describe("ALZA_TOOLS_ALLOW / ALZA_MUTATION_ACTIONS_ALLOW parsing", () => {
  it("unset or blank means no restriction", () => {
    expect(parseToolsAllowEnv(undefined)).toBeUndefined();
    expect(parseToolsAllowEnv("  ")).toBeUndefined();
    expect(parseMutationActionsAllowEnv("")).toBeUndefined();
  });

  it("splits on commas and whitespace", () => {
    expect([...parseToolsAllowEnv("cart, get_product\nwatchdog_set")!]).toEqual(["cart", "get_product", "watchdog_set"]);
    expect(parseMutationActionsAllowEnv("coupon_add watchdog_set")).toEqual(["coupon_add", "watchdog_set"]);
  });

  it("an unknown mutation action is a startup error", () => {
    expect(() => parseMutationActionsAllowEnv("coupon_add,publish_everything")).toThrow(/unknown action "publish_everything"/);
  });

  it("an unknown tool name is a startup error", () => {
    expect(() => buildServer({ allowedTools: new Set(["get_product", "get_produkt"]) })).toThrow(/unknown tool "get_produkt"/);
  });
});

describe("tool allowlist", () => {
  it("exposes exactly the allowed tools, enabled, and nothing can bring the rest back", async () => {
    const { client, built } = await connected({ allowedTools: new Set(["get_product", "cart", "watchdog_list"]) });
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(["cart", "get_product", "watchdog_list"]);
      const res = await client.callTool({ name: "place_order", arguments: {} });
      expect(res.isError).toBe(true);
      const toggle = await client.callTool({ name: "set_toolset", arguments: { id: "all", enabled: true } });
      expect(toggle.isError).toBe(true);
      expect((await client.listTools()).tools).toHaveLength(3);
    } finally {
      await client.close();
      await built.close();
    }
  });

  it("list_toolsets, when allowed, reports only what is left", async () => {
    const { client, built } = await connected({ allowedTools: new Set(["list_toolsets", "get_product", "cart"]) });
    try {
      const res = await client.callTool({ name: "list_toolsets", arguments: {} });
      const toolsets = (res.structuredContent as { toolsets: { id: string; tools: string[]; enabled: boolean }[] }).toolsets;
      expect(toolsets).toEqual([
        expect.objectContaining({ id: "catalog", tools: ["get_product"], enabled: true }),
        expect.objectContaining({ id: "basket_and_checkout", tools: ["cart"], enabled: true }),
      ]);
    } finally {
      await client.close();
      await built.close();
    }
  });
});

describe("mutation action allowlist", () => {
  const opts: BuildOptions = {
    allowedTools: new Set(["prepare_mutation", "mutate_list"]),
    allowedMutationActions: ["coupon_add", "watchdog_set"],
  };

  it("narrows both action enums", async () => {
    const { client, built } = await connected(opts);
    try {
      const { tools } = await client.listTools();
      const actions = (name: string) => (tools.find((t) => t.name === name)!.inputSchema.properties as Record<string, { enum?: string[] }>).action!.enum;
      expect(actions("prepare_mutation")).toEqual(["coupon_add", "watchdog_set"]);
      expect(actions("mutate_list")).toEqual(["coupon_add"]);
    } finally {
      await client.close();
      await built.close();
    }
  });

  it("refuses a token for an action outside the list", async () => {
    const { client, built } = await connected(opts);
    try {
      const res = await client.callTool({ name: "prepare_mutation", arguments: { action: "submit_discussion", payload: {} } });
      expect(res.isError).toBe(true);
      const ok = await client.callTool({ name: "prepare_mutation", arguments: { action: "coupon_add", payload: { coupon: "X" } } });
      expect(ok.isError).toBeFalsy();
    } finally {
      await client.close();
      await built.close();
    }
  });

  it("the domain layer refuses it too, before any request", async () => {
    const account = new MobileAccount(new MobileApi({ visitorId: "visitor-test", baseUrl: "https://test.alza.invalid" }), ["coupon_add"]);
    expect(account.mutationActions).toEqual(["coupon_add"]);
    expect(() => account.prepareMutation("delete_account", {})).toThrow(/disabled on this deployment/);
    await expect(account.mutateList("submit_discussion", "a".repeat(48), {})).rejects.toThrow(/disabled on this deployment/);
  });
});
