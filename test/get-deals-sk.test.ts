import { readFileSync } from "node:fs";
import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import { CARD_EXTRACTOR_FN, Catalog } from "../src/domain/catalog.js";
import { conditionOf, parseDealCard, parseMemberText, parseMoney, payablePrices, promoPercentOf, type Deal, type RawDealCard } from "../src/domain/deals.js";
import { formatDeals } from "../src/tools/get-deals.js";
import { formatProductLine } from "../src/tools/format.js";
import { resolveLocale } from "../src/infra/locale.js";
import type { AlzaBrowser } from "../src/infra/browser.js";

// alza.sk listing boxes captured 2026-10-13 (see the fixture's header comment).
const FIXTURE = readFileSync(new URL("./fixtures/deals-sk-boxes.html", import.meta.url), "utf8");

type Card = RawDealCard & { code: string; ratingText: string | null; reviewCountText: string | null; availabilityText: string | null };

/** Run the in-page card extractor against static HTML through a minimal cheerio-backed DOM. */
function extractCards(html: string): Card[] {
  const $ = cheerio.load(html);
  type El = Parameters<typeof $>[0];
  const wrap = (el: El): unknown => ({
    querySelector: (sel: string) => {
      const found = $(el).find(sel).first();
      return found.length ? wrap(found[0] as El) : null;
    },
    querySelectorAll: (sel: string) => $(el).find(sel).toArray().map((e) => wrap(e as El)),
    getAttribute: (name: string) => $(el).attr(name) ?? null,
    get textContent() {
      return $(el).text();
    },
  });
  const root = { querySelectorAll: (sel: string) => $(sel).toArray().map((e) => wrap(e as El)) };
  const fn = new Function(`return (${CARD_EXTRACTOR_FN})`)() as (r: unknown) => Card[];
  return fn(root);
}

const cards = extractCards(FIXTURE);
const card = (code: string): Card => {
  const c = cards.find((x) => x.code === code);
  if (!c) throw new Error(`fixture has no box ${code}`);
  return c;
};
const deal = (code: string) => parseDealCard(card(code), "EUR");

describe("parseMoney", () => {
  it("reads SK euro amounts with space, no-break and narrow no-break thousands separators", () => {
    expect(parseMoney("1 234,50 €")).toBe(1234.5);
    expect(parseMoney("1 234,50 €")).toBe(1234.5);
    expect(parseMoney("1 031,20 €")).toBe(1031.2);
    expect(parseMoney("88,32 €")).toBe(88.32);
    expect(parseMoney("112 €")).toBe(112);
    expect(parseMoney("Ušetríte 7,90 €")).toBe(7.9);
    expect(parseMoney("Od 2,79 € mesačne")).toBe(2.79);
  });

  it("still reads CZ amounts and ignores text without a currency", () => {
    expect(parseMoney("12 490,-")).toBe(12490);
    expect(parseMoney("Ušetříte 3 500,-")).toBe(3500);
    expect(parseMoney("1 656 Kč")).toBe(1656);
    expect(parseMoney("Zľavnené -6 %")).toBeUndefined();
    expect(parseMoney("Super cena")).toBeUndefined();
  });
});

describe("promo code and AlzaPlus+ text", () => {
  it("takes the promo percent from the code's trailing number", () => {
    expect(promoPercentOf("ALZADNI15")).toBe(15);
    expect(promoPercentOf("ALZADNI5")).toBe(5);
    expect(promoPercentOf("VYPREDAJ")).toBeNull();
  });

  it("parses the product-page AlzaPlus+ box wording", () => {
    // Wording reported from alza.sk category/product pages; not seen on a listing card (those use .coupon-block--applus).
    expect(parseMemberText("-10 % s AlzaPlus+ 134,91 € Bez členstva: 149,90 €")).toEqual({ alzaPlusPrice: 134.91, nonMemberPrice: 149.9 });
    expect(parseMemberText("Pridať do košíka")).toBeUndefined();
  });
});

describe("alza.sk listing boxes (fixture)", () => {
  it("extracts the raw deal fields from the card markup", () => {
    expect(card("RPTLCD003")).toMatchObject({
      priceText: "103,90 €",
      couponCode: "ALZADNI15",
      couponPriceText: "88,32 €",
      badgeText: "Super cena",
      availabilityText: "Na sklade > 5 ks",
      ratingText: "4,4",
      reviewCountText: "38",
    });
  });

  it.each([
    // code, promo, priceNow, priceList, priceOriginal, badge
    ["RPTLCD003", "ALZADNI15", 88.32, 103.9, null, "SUPER CENA"],
    ["WM232l55v1", "ALZADNI10", 107.1, 119, null, null],
    ["WK243x58", "ALZADNI10", 61.2, 68, null, "CENOVÁ BOMBA"],
    ["WC119", "ALZADNI5", 68.97, 72.6, 78, "ZĽAVNENÉ -6 %"],
    ["WC120b4", "ALZADNI10", 72, 80, 91, "ZĽAVNENÉ -12 %"],
    // Was 106,40 / 152 on 2026-10-12; on 2026-10-13 it gained a shelf discount and the code applies to that.
    ["WC118c2e11", "ALZADNI30", 98.36, 140.52, 152, "ZĽAVNENÉ -7 %"],
    ["WO097h8c41", "ALZADNI10", 75.51, 83.9, null, "NOVINKA"],
  ] as const)("%s: code %s, now %s, list %s, original %s, badge %s", (code, promo, now, list, original, badge) => {
    const d = deal(code);
    expect(d).toMatchObject({ promoCode: promo, priceNow: now, priceList: list, price: list, priceOriginal: original, badge });
    expect(d?.promoPercent).toBe(promoPercentOf(promo));
    // Sanity rule: the code applies to the list price (for ZĽAVNENÉ, the intermediate price, not the original).
    expect(d?.priceCheck?.ok).toBe(true);
    expect(d?.priceCheck?.expected).toBeCloseTo(now, 2);
  });

  it("reads 'Ušetríte' as shelf savings", () => {
    expect(deal("WK243x58")).toMatchObject({ savings: 7.9, originalPrice: 75.9 });
  });

  it("does not take a gift's value for a price, and reads the monthly instalment", () => {
    expect(deal("WM232l55u9")).toMatchObject({ priceList: 134.9, priceNow: 121.41, monthlyFrom: 2.79 });
    expect(deal("WM232l55v1")?.monthlyFrom).toBeNull();
  });

  it("reports AlzaPlus+ member and non-member prices from the --applus coupon block", () => {
    expect(deal("DELAK911")).toMatchObject({ alzaPlusPrice: 269, nonMemberPrice: 283.16, promoCode: null, priceNow: 283.16, monthlyFrom: 6.19, priceCheck: null });
    expect(deal("RPTGM003d")).toMatchObject({ alzaPlusPrice: 26.01, nonMemberPrice: 28.9, badge: "SUPER CENA" });
    expect(deal("RPTLCD003")).toMatchObject({ alzaPlusPrice: null, nonMemberPrice: null });
  });

  it("handles cards without a promo code", () => {
    expect(deal("ADL27u70d1")).toMatchObject({ promoCode: null, promoPercent: null, priceNow: 619.9, priceList: 619.9, priceOriginal: 653.9, badge: "ZĽAVNENÉ -5 %", priceCheck: null });
    // A badge alone is not a discount: no older price, savings, code or member price.
    expect(deal("WC1191")).toBeUndefined();
    expect(deal("WH605G5b")).toBeUndefined();
  });

  it("flags a promo price that does not match list × (1 − percent)", () => {
    const d = parseDealCard({ ...card("RPTLCD003"), couponPriceText: "80,00 €" }, "EUR");
    expect(d?.priceCheck).toEqual({ expected: 88.32, ok: false });
    const text = formatDeals([{ code: "RPTLCD003", id: 13098392, name: "Rapture", url: "https://www.alza.sk/x.htm", currency: "EUR", ...d! } as Deal], 1);
    expect(text).toContain("price check failed");
  });
});

/** Fake browser serving listing pages by URL: cards (raw extractor output) plus pagination links. */
function listingBrowser(base: string, pages: Record<string, { cards: unknown[]; links?: Record<string, string> }>) {
  const visited: string[] = [];
  const browser = {
    locale: resolveLocale(base),
    visited,
    async withPage<T>(fn: (p: unknown) => Promise<T>): Promise<T> {
      let current = "";
      const page = {
        goto: async (url: string) => {
          visited.push(url);
          current = url;
          return { status: () => (pages[url] ? 200 : 404) };
        },
        url: () => current,
        waitForLoadState: async () => {},
        waitForSelector: async () => null,
        waitForTimeout: async () => {},
        evaluate: async (script: string) => {
          if (script.includes("nena")) return false;
          if (script.includes("querySelectorAll('.browsingitem')")) return pages[current]?.cards ?? [];
          return pages[current]?.links ?? {};
        },
      };
      return fn(page);
    },
  };
  return browser as unknown as AlzaBrowser & { visited: string[] };
}

describe("Catalog.getDeals on alza.sk", () => {
  const DNI = "https://www.alza.sk/monitory-23-a-24/alza-dni/18848792-e39.htm";
  const DNI_P2 = "https://www.alza.sk/monitory-23-a-24/alza-dni/18848792-e39-p2.htm";
  const withUrl = (c: Card) => ({ ...c, name: c.code, url: `/${c.code}.htm`, id: "1", sponsored: false, image: null, inStock: true });
  const page1 = ["RPTLCD003", "WC119", "WK243x58"].map((c) => withUrl(card(c)));
  const page2 = ["WC120b4", "WM232l55v1", "WH605G5b"].map((c) => withUrl(card(c)));

  it("reads a listing URL and its further pages, best discount first", async () => {
    const browser = listingBrowser("https://www.alza.sk", {
      [DNI]: { cards: page1, links: { "1": DNI, "2": DNI_P2 } },
      [DNI_P2]: { cards: page2, links: { "1": DNI, "2": DNI_P2 } },
    });
    const res = await new Catalog(browser).getDeals({ url: `${DNI}#f&cud=1&pg=1-2` });
    expect(res.url).toBe(DNI);
    expect(res.categoryIds).toEqual([18848792]);
    expect(res.candidatesScanned).toBe(6);
    expect(res.pagesScanned).toBe(2);
    expect(res.partial).toBeUndefined();
    expect(browser.visited).toEqual([DNI, DNI_P2]);
    expect(res.deals.map((d) => d.code)).toEqual(["WC120b4", "WK243x58", "RPTLCD003", "WC119", "WM232l55v1"]);
    expect(res.deals[0]).toMatchObject({ currency: "EUR", reviewCount: 9, availabilityText: "Na sklade > 5 ks", rating: 4.5 });
  });

  it("accepts a category id as before", async () => {
    const browser = listingBrowser("https://www.alza.sk", { "https://www.alza.sk/18848792.htm": { cards: page1 } });
    const res = await new Catalog(browser).getDeals({ categoryId: 18848792, minDiscountPercent: 15 });
    expect(res.deals.map((d) => d.code)).toEqual(["WK243x58", "RPTLCD003"]);
  });

  it("rejects URLs off the configured storefront, non-listing URLs and ambiguous input", async () => {
    const catalog = new Catalog(listingBrowser("https://www.alza.sk", {}));
    await expect(catalog.getDeals({ url: "https://www.alza.cz/18842948.htm" })).rejects.toThrow(/configured storefront/);
    await expect(catalog.getDeals({ url: "http://www.alza.sk/18842948.htm" })).rejects.toThrow(/configured storefront/);
    await expect(catalog.getDeals({ url: "https://www.alza.sk/" })).rejects.toThrow(/ending in \.htm/);
    await expect(catalog.getDeals({ url: DNI, categoryId: 1 })).rejects.toThrow(/either category_id or url/);
  });

  it("reads page 1 when given a -pN URL", async () => {
    const browser = listingBrowser("https://www.alza.sk", { [DNI]: { cards: page1 } });
    await new Catalog(browser).getDeals({ url: DNI_P2 });
    expect(browser.visited[0]).toBe(DNI);
  });

  it("still refuses storefronts whose price boxes it cannot read", async () => {
    const catalog = new Catalog(listingBrowser("https://www.alza.hu", {}));
    await expect(catalog.getDeals({ categoryId: 1 })).rejects.toThrow(/alza\.cz and alza\.sk/);
  });
});

describe("payable prices on plain listing cards (search_products)", () => {
  it("exposes the promo-code price next to the shelf price", () => {
    expect(payablePrices(card("RPTLCD003"))).toEqual({ priceNow: 88.32, promoCode: "ALZADNI15", promoPercent: 15 });
    expect(payablePrices(card("WC119"))).toEqual({ priceNow: 68.97, promoCode: "ALZADNI5", promoPercent: 5 });
  });

  it("exposes AlzaPlus+ separately and sets nothing for plain cards", () => {
    expect(payablePrices(card("DELAK911"))).toEqual({ alzaPlusPrice: 269 });
    expect(payablePrices(card("WH605G5b"))).toEqual({});
  });

  it("ignores a code price that is not lower than the shelf price", () => {
    expect(payablePrices({ ...card("RPTLCD003"), couponPriceText: "120,00 €" })).toEqual({});
  });

  it("shows the code price first in the search line", () => {
    const line = formatProductLine({ code: "RPTLCD003", id: 1, name: "Rapture", url: "https://www.alza.sk/x.htm", currency: "EUR", price: 103.9, ...payablePrices(card("RPTLCD003")) });
    expect(line).toContain("**88,32 EUR** with code ALZADNI15 (shelf 103,9 EUR)");
    expect(formatProductLine({ code: "A", id: 1, name: "A", url: "u", currency: "EUR", price: 5 })).toContain("5 EUR");
  });
});

describe("lowest price in product detail and comparison", () => {
  const p = { code: "RPTLCD003", id: 1, name: "Rapture", url: "https://www.alza.sk/x.htm", currency: "EUR", price: 103.9, priceNow: 88.32, promoCode: "ALZADNI15", promoPercent: 15 };

  it("formatProduct leads with the price you can actually pay", async () => {
    const { formatProduct } = await import("../src/tools/format.js");
    const text = formatProduct(p);
    expect(text).toContain("Price: **103,9 EUR**");
    expect(text).toContain("Lowest price you can pay: **88,32 EUR** with code ALZADNI15 (-15 %)");
    expect(formatProduct({ ...p, priceNow: undefined, promoCode: undefined })).not.toContain("Lowest price");
  });

  it("reads the product page's promo block through the page extractor", () => {
    const html = `<span class="promo-action-prices__discount-code">ALZADNI15</span><span class="promo-action-prices__price">88,32 €</span><span class="js-price-box__primary-price__value">103,90 €</span>`;
    const $ = cheerio.load(html);
    expect($(".promo-action-prices__discount-code").text()).toBe("ALZADNI15");
    expect(payablePrices({ priceText: $(".js-price-box__primary-price__value").text(), originalPriceText: null, originalIsStrike: false, couponCode: "ALZADNI15", couponPriceText: $(".promo-action-prices__price").text() })).toEqual({ priceNow: 88.32, promoCode: "ALZADNI15", promoPercent: 15 });
  });
});

describe("opened-box (Rozbalené) goods", () => {
  it("recognises them from the stock line and the 'Nový N €' reference, not from the price", () => {
    expect(conditionOf({ availabilityText: "Rozbalené - na sklade 2 ks", originalPriceText: null })).toBe("opened");
    expect(conditionOf({ availabilityText: "Zánovné - na sklade 1 ks", originalPriceText: null })).toBe("used");
    expect(conditionOf({ availabilityText: "Na sklade > 5 ks", originalPriceText: "Nový 165 €" })).toBe("used");
    expect(conditionOf({ availabilityText: "Na sklade > 5 ks", originalPriceText: "Ušetríte 7,90 €" })).toBeUndefined();
    expect(conditionOf({ availabilityText: null, originalPriceText: "78 €" })).toBeUndefined();
  });

  it("reads the new price as a reference, never as a crossed-out price or savings", () => {
    const c = card("WK227y9b");
    expect(c.priceText).toBe("156,90 €");
    expect(c.originalPriceText).toBe("Nový 165 €");
    const d = parseDealCard(c, "EUR");
    expect(d).toMatchObject({ condition: "opened", newPrice: 165, priceList: 156.9, priceNow: 141.21, promoCode: "ALZADNI10", priceOriginal: null });
    expect(d?.originalPrice).toBeUndefined();
    expect(d?.savings).toBeUndefined();
    expect(payablePrices(c)).toMatchObject({ condition: "opened", newPrice: 165, priceNow: 141.21 });
  });

  it("is flagged in search lines, product text and comparison cells, never as a discount", async () => {
    const { formatProduct } = await import("../src/tools/format.js");
    const p = { code: "WK227y9b", id: 1, name: "AOC Q27G4XF", url: "u", currency: "EUR", price: 156.9, ...payablePrices(card("WK227y9b")) };
    expect(formatProductLine(p)).toContain("OPENED BOX (previously sold, not new), new: 165 EUR");
    expect(formatProduct(p)).toContain("Condition: ⚠ OPENED BOX");
  });

  it("getDeals keeps them out of the ranking and lists them separately", async () => {
    const base = "https://www.alza.sk";
    const withUrl = (c: Card) => ({ ...c, name: c.code, url: `/${c.code}.htm`, id: "1", sponsored: false, image: null, inStock: true });
    const cardsOn = ["WK227y9b", "RPTLCD003", "WC119"].map((c) => withUrl(card(c)));
    const browser = listingBrowser(base, { [`${base}/18842948.htm`]: { cards: cardsOn } });
    const res = await new Catalog(browser).getDeals({ categoryId: 18842948 });
    expect(res.deals.map((d) => d.code).sort()).toEqual(["RPTLCD003", "WC119"]);
    expect(res.usedOffers.map((d) => d.code)).toEqual(["WK227y9b"]);
    const text = formatDeals(res.deals, res.candidatesScanned, res.usedOffers);
    expect(text).toContain("NOT ranked or compared");
    expect(text).toContain("OPENED BOX: **141,21 EUR**");
    expect(text).toContain("new: 165 EUR");
  });

  it("keeps a new item and an opened-box item that share a code apart", async () => {
    const base = "https://www.alza.sk";
    const w = (c: Card) => ({ ...c, name: c.code, url: `/${c.code}.htm`, id: "1", sponsored: false, image: null, inStock: true });
    const newCard = { ...card("RPTLCD003"), code: "WK227y9b" };
    const browser = listingBrowser(base, { [`${base}/1.htm`]: { cards: [w(newCard), w(card("WK227y9b"))] } });
    const res = await new Catalog(browser).getDeals({ categoryId: 1 });
    expect(res.deals.map((d) => d.code)).toEqual(["WK227y9b"]);
    expect(res.usedOffers).toHaveLength(1);
  });
});
