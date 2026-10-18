import { describe, expect, it } from "vitest";
import { Catalog } from "../src/domain/catalog.js";
import { raceDeadline } from "../src/infra/deadline.js";
import { resolveLocale } from "../src/infra/locale.js";
import type { AlzaBrowser } from "../src/infra/browser.js";
import { formatDeals } from "../src/tools/get-deals.js";

describe("raceDeadline", () => {
  it("returns the value when the work finishes in time", async () => {
    expect(await raceDeadline(Promise.resolve(7), Date.now() + 1000)).toEqual({ value: 7 });
  });

  it("reports a time-out without waiting for slow work, and swallows its later rejection", async () => {
    const slow = new Promise<number>((_, reject) => setTimeout(() => reject(new Error("late")), 80));
    const t = Date.now();
    expect(await raceDeadline(slow, Date.now() + 20)).toEqual({ timedOut: true });
    expect(Date.now() - t).toBeLessThan(70);
    await new Promise((r) => setTimeout(r, 120)); // no unhandled rejection
  });

  it("times out immediately when the deadline has passed", async () => {
    expect(await raceDeadline(new Promise(() => undefined), Date.now() - 1)).toEqual({ timedOut: true });
  });
});

const CARD = (code: string) => ({
  code, id: "1", sponsored: false, name: code, url: `/${code}.htm`, image: null, priceText: "100 €", originalPriceText: "Ušetríte 10 €", originalIsStrike: false,
  ratingText: null, reviewCountText: null, inStock: true, couponCode: null, couponPriceText: null, alzaPlusPriceText: null, memberText: null, badgeText: null, monthlyText: null, availabilityText: "Na sklade",
});

describe("get_deals time budget", () => {
  it("returns a partial result when a later page is slow, then finishes from the page cache on retry", async () => {
    const base = "https://www.alza.sk";
    const P1 = `${base}/1.htm`;
    const P2 = `${base}/1-p2.htm`;
    let slowPageReleased = false;
    const visits: string[] = [];
    const browser = {
      locale: resolveLocale(base),
      async withPage<T>(fn: (p: unknown) => Promise<T>): Promise<T> {
        let current = "";
        return fn({
          goto: async (u: string) => {
            current = u;
            visits.push(u);
            if (u === P2 && !slowPageReleased) await new Promise((r) => setTimeout(r, 400));
            return { status: () => 200 };
          },
          url: () => current,
          waitForLoadState: async () => {},
          waitForSelector: async () => null,
          waitForTimeout: async () => {},
          evaluate: async (script: string) => {
            if (script.includes("nena")) return false;
            if (script.includes("querySelectorAll('.browsingitem')")) return current === P1 ? [CARD("A")] : [CARD("B")];
            return current === P1 ? { "1": P1, "2": P2 } : {};
          },
        });
      },
    } as unknown as AlzaBrowser;
    const catalog = new Catalog(browser);
    // Shrink the budget by monkey-patching the clock-based deadline through a short real wait.
    const realNow = Date.now;
    let calls = 0;
    Date.now = () => (calls++ < 3 ? realNow() : realNow() + 60_000);
    let first;
    try {
      first = await catalog.getDeals({ categoryId: 1 });
    } finally {
      Date.now = realNow;
    }
    expect(first.partial).toBe(true);
    expect(first.deals.map((d) => d.code)).toEqual(["A"]);
    expect(formatDeals(first.deals, first.candidatesScanned, [], true)).toContain("results are partial");

    slowPageReleased = true;
    await new Promise((r) => setTimeout(r, 450)); // the abandoned load finishes and fills the page cache
    const before = visits.length;
    const second = await catalog.getDeals({ categoryId: 1 });
    expect(second.partial).toBeUndefined();
    expect(second.deals.map((d) => d.code).sort()).toEqual(["A", "B"]);
    expect(visits.length).toBe(before); // nothing re-fetched
  });
});
