import { readFileSync } from "node:fs";
import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import { CARD_EXTRACTOR_FN, Catalog, PRODUCT_PAGE_EXTRACTOR } from "../src/domain/catalog.js";
import { monthlyAmount, parseDealCard, parsePriceExplanation, shelfPrices, type RawDealCard } from "../src/domain/deals.js";
import type { AlzaBrowser } from "../src/infra/browser.js";

// Signed-in price boxes (structure as served 2026-11-19, made-up product and amounts):
// the account pays 800,-, the public price 1 000,- is crossed out, JSON-LD says 1 000.
const FIXTURE = readFileSync(new URL("./fixtures/price-box-signed-in.html", import.meta.url), "utf8");
const PAGE_URL = "https://www.alza.cz/example-wireless-headset-d10000001.htm";

/** Minimal DOM over cheerio: just what the extractors call. */
function dom(html: string) {
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
  return {
    title: $("title").text(),
    querySelector: (sel: string) => {
      const found = $(sel).first();
      return found.length ? wrap(found[0] as El) : null;
    },
    querySelectorAll: (sel: string) => $(sel).toArray().map((e) => wrap(e as El)),
  };
}

const runProductExtractor = (html: string) => new Function("document", "location", `return ${PRODUCT_PAGE_EXTRACTOR}`)(dom(html), { href: PAGE_URL });
const runCardExtractor = (html: string) => (new Function(`return (${CARD_EXTRACTOR_FN})`)() as (r: unknown) => Array<RawDealCard & { code: string }>)(dom(html));

/** Alza's price-explanation dialog, trimmed to the fields read, with made-up amounts. */
const EXPLANATION = {
  alzaPriceInfo: { headText: "Vaše extra cena", priceInfoV3: { mainPriceTag: { primaryPrice: "800,-", primaryPriceNoCurrency: 800.0 } } },
  eshopPriceInfo: { headText: "Cena Alza.cz", priceInfoV3: { mainPriceTag: { primaryPrice: "1 000,-", primaryPriceNoCurrency: 1000.0 } } },
};

function productBrowser(html: string, opts: { signedIn: boolean; explanation?: unknown }) {
  const fetched: string[] = [];
  const page = {
    goto: async () => null,
    waitForLoadState: async () => {},
    waitForSelector: async () => null,
    url: () => PAGE_URL,
    evaluate: async (script: string) => {
      if (script.includes("data-code")) return PAGE_URL; // resolveProductUrl's card lookup
      if (script.includes('credentials: "include"')) {
        fetched.push(script);
        return opts.explanation ?? null;
      }
      return runProductExtractor(html);
    },
  };
  const browser = {
    locale: { baseUrl: "https://www.alza.cz", currency: "CZK" },
    webSessionLoaded: opts.signedIn,
    withPage: async <T>(fn: (p: typeof page) => Promise<T>) => fn(page),
  } as unknown as AlzaBrowser;
  return { browser, fetched };
}

describe("one price-box reader for listing cards and the product page", () => {
  it("reads the account's price and the crossed-out public price from a card", () => {
    const [card] = runCardExtractor(FIXTURE);
    expect(card).toMatchObject({ code: "TEST0001", priceText: "800,-", originalIsStrike: true });
    expect(shelfPrices(card!)).toEqual({ price: 800, originalPrice: 1000 });
  });

  it("reads the same fields from the product page's main price box, not the JSON-LD", () => {
    const data = runProductExtractor(FIXTURE) as { priceBox: RawDealCard; priceExplanationUrl: string | null };
    expect(data.priceBox).toMatchObject({ priceText: "800,-", originalIsStrike: true });
    expect(shelfPrices(data.priceBox)).toEqual({ price: 800, originalPrice: 1000 });
    expect(data.priceExplanationUrl).toMatch(/\/explanationPrice\/dialog\?/);
  });

  it("never reads the 'bez DPH' footer as a monthly instalment", () => {
    expect(monthlyAmount("bez DPH 661,-")).toBeNull();
    expect(monthlyAmount("Od 2,79 € mesačne")).toBe(2.79);
    const [card] = runCardExtractor(FIXTURE);
    expect(parseDealCard(card!, "CZK")?.monthlyFrom).toBeNull();
  });

  it("keeps a savings box and opened-box goods as before", () => {
    expect(shelfPrices({ priceText: "900,-", originalPriceText: "Ušetříte 100,-", originalIsStrike: false })).toEqual({ price: 900, originalPrice: 1000 });
    expect(shelfPrices({ priceText: "900,-", originalPriceText: "Nový 1 000,-", originalIsStrike: false, availabilityText: "Rozbaleno - skladem 1 ks" })).toEqual({ price: 900 });
    expect(shelfPrices({ priceText: null, originalPriceText: null, originalIsStrike: false })).toEqual({});
  });
});

describe("get_product prices for a signed-in account", () => {
  it("returns the price the account pays, the crossed-out price and the public price", async () => {
    const { browser, fetched } = productBrowser(FIXTURE, { signedIn: true, explanation: EXPLANATION });
    const p = await new Catalog(browser).getProduct("TEST0001");
    expect(p).toMatchObject({ code: "TEST0001", price: 800, originalPrice: 1000, publicPrice: 1000, currency: "CZK" });
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toContain("/explanationPrice/dialog?country=CZ");
  });

  it("still returns the account's price when the explanation dialog fails", async () => {
    const { browser } = productBrowser(FIXTURE, { signedIn: true, explanation: { unexpected: true } });
    const p = await new Catalog(browser).getProduct("TEST0001");
    expect(p).toMatchObject({ price: 800, originalPrice: 1000 });
    expect(p.publicPrice).toBeUndefined();
  });

  it("does not call the dialog for an anonymous catalog", async () => {
    const { browser, fetched } = productBrowser(FIXTURE, { signedIn: false, explanation: EXPLANATION });
    const p = await new Catalog(browser).getProduct("TEST0001");
    expect(p.price).toBe(800);
    expect(p.publicPrice).toBeUndefined();
    expect(fetched).toHaveLength(0);
  });

  it("falls back to the JSON-LD price when the page has no price box", async () => {
    const withoutBox = FIXTURE.replace(/<div class="price-detail__row">[\s\S]*?<!-- Listing card/, "<!-- Listing card").replace(/<div class="box browsingitem[\s\S]*<\/div>\s*<\/body>/, "</body>");
    const { browser } = productBrowser(withoutBox, { signedIn: false });
    const p = await new Catalog(browser).getProduct("TEST0001");
    expect(p.price).toBe(1000);
    expect(p.originalPrice).toBeUndefined();
  });
});

describe("parsePriceExplanation", () => {
  it("reads the public price from eshopPriceInfo", () => {
    expect(parsePriceExplanation(EXPLANATION)).toEqual({ publicPrice: 1000 });
  });

  it("falls back to the formatted price and rejects bodies without one", () => {
    expect(parsePriceExplanation({ eshopPriceInfo: { priceInfoV3: { mainPriceTag: { primaryPrice: "1 234,-" } } } })).toEqual({ publicPrice: 1234 });
    expect(parsePriceExplanation({ eshopPriceInfo: { priceInfoV3: { mainPriceTag: { primaryPrice: "" } } } })).toBeUndefined();
    expect(parsePriceExplanation(null)).toBeUndefined();
    expect(parsePriceExplanation("<html>")).toBeUndefined();
  });
});
