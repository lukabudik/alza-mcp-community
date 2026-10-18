import { readFileSync } from "node:fs";
import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import { CARD_EXTRACTOR_FN } from "../src/domain/catalog.js";
import { conditionOf, parseDealCard, parseMoney, payablePrices, promoPercentOf, type RawDealCard } from "../src/domain/deals.js";
import { formatProductLine } from "../src/tools/format.js";

// alza.cz listing boxes captured 2026-10-18 (see the fixture's header comment). The promo-code,
// AlzaPlus+ and opened-box markup is the same as on alza.sk; only the wording and number format differ.
const FIXTURE = readFileSync(new URL("./fixtures/deals-cz-boxes.html", import.meta.url), "utf8");

type Card = RawDealCard & { code: string };

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
  return (new Function(`return (${CARD_EXTRACTOR_FN})`)() as (r: unknown) => Card[])(root);
}

const cards = extractCards(FIXTURE);
const card = (code: string): Card => {
  const c = cards.find((x) => x.code === code);
  if (!c) throw new Error(`fixture has no box ${code}`);
  return c;
};
const deal = (code: string) => parseDealCard(card(code), "CZK");

describe("alza.cz promo-code, AlzaPlus+ and opened-box cards (fixture)", () => {
  it("reads CZ amounts with nbsp thousands and ',-'", () => {
    expect(parseMoney("3\u00a0192,-")).toBe(3192);
    expect(parseMoney("Nový 3\u00a0994,-")).toBe(3994);
    expect(promoPercentOf("ALZADNY20")).toBe(20);
  });

  it.each([
    ["WM232l55w1", "ALZADNY20", 3192, 3990],
    ["WK243x56", "ALZADNY25", 5390, 7187],
  ] as const)("%s: code %s, now %s, list %s", (code, promo, now, list) => {
    expect(deal(code)).toMatchObject({ promoCode: promo, priceNow: now, priceList: list, condition: null, newPrice: null });
    // CZK prices are whole crowns: the code price is rounded, so the check allows 1 Kč.
    expect(deal(code)?.priceCheck?.ok).toBe(true);
    expect(payablePrices(card(code))).toMatchObject({ priceNow: now, promoCode: promo });
  });

  it("reads the AlzaPlus+ price of a card without a promo code", () => {
    expect(deal("RPTLCD005")).toMatchObject({ alzaPlusPrice: 3591, nonMemberPrice: 3990, promoCode: null, priceNow: 3990, badge: "SUPER CENA" });
  });

  it("recognises 'Rozbaleno' / 'Nový N,-' and never reads it as a discount", () => {
    expect(conditionOf({ availabilityText: "Rozbaleno - skladem 2 ks", originalPriceText: null })).toBe("opened");
    expect(conditionOf({ availabilityText: "Skladem > 5 ks", originalPriceText: "Nový 3 994,-" })).toBe("used");
    const open = card("WK227y9b");
    expect(open.originalPriceText).toMatch(/^Nový/);
    const d = parseDealCard(open, "CZK");
    expect(d).toMatchObject({ condition: "opened", newPrice: 3994, priceList: 3829, promoCode: "ALZADNY10", priceOriginal: null });
    expect(d?.originalPrice).toBeUndefined();
    expect(d?.savings).toBeUndefined();
    const line = formatProductLine({ code: "WK227y9b", id: 1, name: "AOC", url: "u", currency: "CZK", price: 3829, ...payablePrices(open) });
    expect(line).toContain("OPENED BOX (previously sold, not new), new:");
  });
});
