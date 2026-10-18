import { describe, expect, it } from "vitest";
import { Catalog } from "../src/domain/catalog.js";
import { computeDeal, parseCzPrice } from "../src/domain/deals.js";
import { formatDeals } from "../src/tools/get-deals.js";
import { resolveLocale } from "../src/infra/locale.js";
import type { AlzaBrowser } from "../src/infra/browser.js";

// Card texts captured live from alza.cz/lcd-monitory/18842948.htm on 2026-10-06.
const card = (code: string, name: string, priceText: string, originalPriceText: string | null, originalIsStrike = false) => ({
  code,
  id: String(code.length),
  sponsored: false,
  name,
  url: `/${code}.htm`,
  image: null,
  priceText,
  originalPriceText,
  originalIsStrike,
  ratingText: null,
  reviewCountText: null,
  inStock: true,
});

const FIXTURE = [
  card("A1", "27\" GIGABYTE MO27Q2A", "12 490,-", "15 390,-", true),
  card("A2", "34\" Dell Alienware AW3425DW", "15 390,-", "18 090,-", true),
  card("A3", "27\" LG UltraGear 27G411B-B", "2 490,-", "Ušetříte 100,-"),
  card("A4", "57\" Samsung Odyssey Neo G9", "42 490,-", "Ušetříte 3 500,-"),
  card("A5", "27\" AOC Q27G4XF Gaming", "3 994,-", null),
];

function fakeBrowser(countryBase: string): AlzaBrowser {
  const visited: string[] = [];
  const browser = {
    locale: resolveLocale(countryBase),
    visited,
    async withPage<T>(fn: (p: unknown) => Promise<T>): Promise<T> {
      let call = 0;
      const page = {
        goto: async (url: string) => {
          visited.push(url);
          return { status: () => 200 };
        },
        waitForLoadState: async () => {},
        waitForSelector: async () => null,
        waitForTimeout: async () => {},
        evaluate: async (script: string) => (script.includes("nena") ? false : call++ === 0 ? FIXTURE : {}),
      };
      return fn(page);
    },
  };
  return browser as unknown as AlzaBrowser;
}

describe("deal price computation", () => {
  it("parses CZ prices with nbsp thousands separators", () => {
    expect(parseCzPrice("12 490,-")).toBe(12490);
    expect(parseCzPrice("Ušetříte 3 500,-")).toBe(3500);
    expect(parseCzPrice("Super cena")).toBeUndefined();
  });

  it("computes % from a crossed-out original price, ignoring the badge", () => {
    const d = computeDeal({ priceText: "12 490,-", originalPriceText: "15 390,-", originalIsStrike: true });
    expect(d).toEqual({ price: 12490, originalPrice: 15390, savings: 2900, discountPercent: 18.8 });
  });

  it("derives the original price from an 'Ušetříte' savings amount", () => {
    const d = computeDeal({ priceText: "2 490,-", originalPriceText: "Ušetříte 100,-", originalIsStrike: false });
    expect(d).toEqual({ price: 2490, originalPrice: 2590, savings: 100, discountPercent: 3.9 });
  });

  it("returns undefined without an original price or when it is not higher", () => {
    expect(computeDeal({ priceText: "3 994,-", originalPriceText: null, originalIsStrike: false })).toBeUndefined();
    expect(computeDeal({ priceText: "100,-", originalPriceText: "100,-", originalIsStrike: true })).toBeUndefined();
  });
});

describe("Catalog.getDeals", () => {
  it("returns only discounted cards, best discount first, honoring min_discount_percent and limit", async () => {
    const catalog = new Catalog(fakeBrowser("https://www.alza.cz"));
    const all = await catalog.getDeals({ categoryId: 18842948 });
    expect(all.candidatesScanned).toBe(5);
    expect(all.deals.map((d) => d.code)).toEqual(["A1", "A2", "A4", "A3"]);
    expect(all.deals[0]?.discountPercent).toBe(18.8);

    const min = await catalog.getDeals({ categoryId: 18842948, minDiscountPercent: 15 });
    expect(min.deals.map((d) => d.code)).toEqual(["A1"]);

    const one = await catalog.getDeals({ categoryId: 18842948, limit: 1 });
    expect(one.deals).toHaveLength(1);
  });

  it("scans the default category set when no category_id is given", async () => {
    const browser = fakeBrowser("https://www.alza.cz");
    const catalog = new Catalog(browser);
    const res = await catalog.getDeals({});
    expect(res.categoryIds.length).toBe(5);
    expect((browser as unknown as { visited: string[] }).visited.length).toBe(5);
  });

  it("is scoped to the storefronts whose price boxes it reads (CZ, SK)", async () => {
    const catalog = new Catalog(fakeBrowser("https://www.alza.de"));
    await expect(catalog.getDeals({ categoryId: 1 })).rejects.toThrow(/alza\.cz and alza\.sk/);
  });

  it("formats deals with the computed discount", () => {
    const text = formatDeals([{ ...FIXTURE_DEAL }], 5);
    expect(text).toContain("-18.8 %");
    expect(formatDeals([], 24)).toContain("No discounted products");
  });
});

const FIXTURE_DEAL = {
  code: "A1",
  id: 1,
  name: "27\" GIGABYTE MO27Q2A",
  url: "https://www.alza.cz/A1.htm",
  currency: "CZK",
  price: 12490,
  originalPrice: 15390,
  savings: 2900,
  discountPercent: 18.8,
  priceNow: 12490,
  priceList: 12490,
  priceOriginal: 15390,
  promoCode: null,
  promoPercent: null,
  badge: null,
  monthlyFrom: null,
  alzaPlusPrice: null,
  nonMemberPrice: null,
  priceCheck: null,
};
