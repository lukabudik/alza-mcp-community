import { describe, expect, it } from "vitest";
import { Catalog, MAX_SEARCH_PAGE, filterByPrice, parsePrice } from "../src/domain/catalog.js";
import { matchesBrand } from "../src/domain/alternatives.js";
import { createSearchProductsTool } from "../src/tools/search-products.js";
import { NotFoundError } from "../src/infra/errors.js";
import { resolveLocale } from "../src/infra/locale.js";
import type { AlzaBrowser } from "../src/infra/browser.js";
import type { Product } from "../src/domain/types.js";
import type { ToolDeps } from "../src/tools/types.js";

const prod = (over: Partial<Product>): Product => ({
  code: "X",
  id: 1,
  name: "p",
  url: "https://www.alza.sk/x.htm",
  currency: "EUR",
  ...over,
});

describe("parsePrice (#70)", () => {
  it("keeps the CZ card formats", () => {
    expect(parsePrice("5 290,-")).toBe(5290);
    expect(parsePrice("Super cena 4 399,- Ušetříte 91,-")).toBe(4399);
    expect(parsePrice("Super cena")).toBeUndefined();
  });

  // Strings captured live from alza.sk/search.htm?exps=monitor on 2026-10-07.
  it("parses alza.sk euro prices", () => {
    expect(parsePrice("395,90 €")).toBe(395.9);
    expect(parsePrice("297 €")).toBe(297);
    expect(parsePrice("Super cena 395,90 € Ušetríte 31,10 €")).toBe(395.9);
    expect(parsePrice("1 299,90 €")).toBe(1299.9);
    expect(parsePrice("1 299 €")).toBe(1299);
    expect(parsePrice("")).toBeUndefined();
  });

  // Price text captured live from alza.hu/search.htm?exps=iPhone+16 on 2026-11-26 (whitespace runs collapsed).
  it("parses alza.hu forint prices", () => {
    expect(parsePrice("349\u00a0990\u00a0Ft")).toBe(349990);
    expect(parsePrice("Szuper ár 359\u00a0990\u00a0Ft")).toBe(359990);
    expect(parsePrice("-10\u00a0% az új árából 314\u00a0990\u00a0Ft")).toBe(314990);
  });
});

describe("filterByPrice (#70)", () => {
  it("excludes products with an unknown price whenever a bound is set", () => {
    const unknown = prod({});
    expect(filterByPrice(unknown, { maxPrice: 200 })).toBe(false);
    expect(filterByPrice(unknown, { minPrice: 10 })).toBe(false);
    expect(filterByPrice(unknown, {})).toBe(true);
  });

  it("applies both bounds inclusively", () => {
    expect(filterByPrice(prod({ price: 200 }), { minPrice: 200, maxPrice: 200 })).toBe(true);
    expect(filterByPrice(prod({ price: 200.5 }), { maxPrice: 200 })).toBe(false);
    expect(filterByPrice(prod({ price: 9 }), { minPrice: 10 })).toBe(false);
  });
});

describe("matchesBrand with sized names (#71)", () => {
  it("does not treat the leading inch size as the brand", () => {
    const iiyama = prod({ name: '34" iiyama ProLite GCB3484WQSU-B1' });
    expect(matchesBrand(iiyama, "AOC", '34" AOC CU34G2XP')).toBe(false);
  });

  it("still matches same-brand sized names, with or without the brand field", () => {
    expect(matchesBrand(prod({ name: '27" AOC Q27G4XF' }), "AOC", '34" AOC CU34G2XP')).toBe(true);
    expect(matchesBrand(prod({ name: "34 AOC AG344UXM" }), "AOC", '34" AOC CU34G2XP')).toBe(true);
    // Names that omit the brand lead with the product line: same line still matches.
    expect(matchesBrand(prod({ name: "iPhone 16" }), "Apple", "iPhone 17 Pro")).toBe(true);
    expect(matchesBrand(prod({ name: "Galaxy S25" }), "Apple", "iPhone 17 Pro")).toBe(false);
  });
});

describe("search_products input schema (#58, #75)", () => {
  function captureSchema(): Record<string, { safeParse: (v: unknown) => { success: boolean } }> {
    let schema: Record<string, { safeParse: (v: unknown) => { success: boolean } }> = {};
    const server = {
      registerTool: (_n: string, cfg: { inputSchema: typeof schema }) => {
        schema = cfg.inputSchema;
        return {};
      },
    };
    createSearchProductsTool({} as ToolDeps).register(server as never, (async () => ({})) as never);
    return schema;
  }

  it("bounds page and query length", () => {
    const s = captureSchema();
    expect(s.page!.safeParse(1).success).toBe(true);
    expect(s.page!.safeParse(MAX_SEARCH_PAGE).success).toBe(true);
    expect(s.page!.safeParse(99999999999).success).toBe(false);
    expect(s.query!.safeParse("x".repeat(100_000)).success).toBe(false);
  });

  it("accepts at most one producer id", () => {
    const s = captureSchema();
    expect(s.producer_ids!.safeParse([1357]).success).toBe(true);
    expect(s.producer_ids!.safeParse([1357, 1611]).success).toBe(false);
  });
});

interface FakePageOpts {
  status?: number;
  finalUrl?: string;
  heading?: string;
}

function fakeBrowser(opts: FakePageOpts = {}) {
  const gotos: string[] = [];
  const browser = {
    locale: resolveLocale("https://www.alza.cz"),
    async withPage<T>(fn: (p: unknown) => Promise<T>): Promise<T> {
      let current = "";
      const page = {
        goto: async (url: string) => {
          gotos.push(url);
          current = opts.finalUrl ?? url;
          return { status: () => opts.status ?? 200 };
        },
        url: () => current,
        waitForLoadState: async () => {},
        waitForSelector: async () => null,
        waitForTimeout: async () => {},
        evaluate: async (script: string) => {
          if (script.includes("querySelectorAll('.browsingitem')")) {
            return [
              { code: "SAM1", id: "1", sponsored: false, name: "Samsung Galaxy S25", url: "/s25.htm", image: null, priceText: "15 612,-", ratingText: null, reviewCountText: null, inStock: true },
            ];
          }
          if (script.includes("document.title")) return opts.heading ?? "";
          return {};
        },
      };
      return fn(page);
    },
  };
  return { browser: browser as unknown as AlzaBrowser, gotos };
}

describe("Catalog.searchProducts guards", () => {
  it("rejects a huge page immediately instead of spinning (#58)", async () => {
    const { browser, gotos } = fakeBrowser();
    const started = Date.now();
    await expect(new Catalog(browser).searchProducts({ query: "x", page: 99999999999 })).rejects.toThrow(/page must be at most/);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(gotos).toEqual([]);
  });

  it("rejects several producer ids with a clear error instead of an empty result (#75)", async () => {
    const { browser, gotos } = fakeBrowser();
    await expect(
      new Catalog(browser).searchProducts({ query: "x", categoryId: 18842948, producerIds: [1357, 1611] })
    ).rejects.toThrow(/exactly one brand id/);
    expect(gotos).toEqual([]);
  });

  it("reports a 404 filtered page in an existing category as an error, not 0 results (#75)", async () => {
    const { browser } = fakeBrowser({ status: 404 });
    // The category check itself would also see 404; stub it as existing.
    const catalog = new Catalog(browser);
    (catalog as unknown as { assertCategoryExists: () => Promise<void> }).assertCategoryExists = async () => {};
    await expect(catalog.searchProducts({ query: "x", categoryId: 18842948, producerIds: [99] })).rejects.toThrow(/no filtered page/);
  });

  describe("page-1 brand landing redirect (#76)", () => {
    const landing = "https://www.alza.cz/mobily-samsung/18855066.htm";
    const mk = (opts: FakePageOpts) => {
      const { browser } = fakeBrowser(opts);
      const catalog = new Catalog(browser);
      catalog.getCategoryFilters = async (categoryId: number) => ({
        categoryId,
        brands: [{ valueId: 1299, description: "Samsung" }],
        groups: [],
      });
      return catalog;
    };

    it("accepts Alza's brand landing page when it names the requested brand", async () => {
      const res = await mk({ finalUrl: landing, heading: "Mobilní telefony Samsung Galaxy | Alza.cz Mobilní telefony Samsung" }).searchProducts({
        query: "x",
        categoryId: 18843445,
        producerIds: [1299],
      });
      expect(res.products.map((p) => p.code)).toEqual(["SAM1"]);
    });

    it("still rejects a redirect to a page that does not name the brand", async () => {
      await expect(
        mk({ finalUrl: landing, heading: "Mobilní telefony | Alza.cz" }).searchProducts({ query: "x", categoryId: 18843445, producerIds: [1299] })
      ).rejects.toThrow(/does not support URL filtering for producer 1299/);
    });

    it("still rejects a redirect back to the plain requested category", async () => {
      await expect(
        mk({ finalUrl: "https://www.alza.cz/mobily/18843445.htm", heading: "Samsung" }).searchProducts({
          query: "x",
          categoryId: 18843445,
          producerIds: [1299],
        })
      ).rejects.toThrow(/does not support URL filtering/);
    });
  });
});

describe("unknown category ids (#77)", () => {
  it("search_products with a keyword and an unknown category_id is NotFound", async () => {
    const { browser } = fakeBrowser({ status: 404 });
    await expect(new Catalog(browser).searchProducts({ query: "x", categoryId: 999999999 })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("search_products with a known category_id still searches", async () => {
    const { browser } = fakeBrowser();
    const res = await new Catalog(browser).searchProducts({ query: "x", categoryId: 18842948 });
    expect(res.products).toHaveLength(1);
  });

  it("list_category_filters and list_categories report an unknown id as NotFound", async () => {
    const { browser } = fakeBrowser({ status: 404 });
    const catalog = new Catalog(browser);
    await expect(catalog.getCategoryFilters(999999999)).rejects.toThrow("category 999999999 not found");
    await expect(catalog.listCategories(99999999)).rejects.toThrow("category 99999999 not found");
  });
});
