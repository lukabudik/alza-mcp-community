import { z } from "zod";
import { OUTPUT_SCHEMAS } from "./output-schemas.js";
import { formatPrice } from "./format.js";
import type { Deal } from "../domain/deals.js";
import type { RegisterableTool, ToolDeps } from "./types.js";
import { tagLinks } from "./tracking.js";

const inputSchema = {
  category_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Leaf category id to scan for discounts (from `list_categories`/`search_products`; top-level hub categories such as 'Počítače a notebooky' have no product grid and return nothing). Omit both this and `url` to scan the first page of a fixed set of popular categories (phones, notebooks, monitors, TVs, headphones)."
    ),
  url: z
    .string()
    .max(500)
    .optional()
    .describe(
      "A listing page on the configured storefront instead of `category_id`, e.g. an Alza dni promotion 'https://www.alza.sk/monitory-23-a-24/alza-dni/18848792-e39.htm' or any category URL. Query and '#…' parts are ignored; '-p2.htm' is read from page 1."
    ),
  min_discount_percent: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe("Keep only products whose computed discount (`discountPercent`, promo-code price included) is at least this many percent. Default 0 (any discount)."),
  limit: z.number().int().min(1).max(50).optional().describe("Maximum deals to return, best discount first. Default 20, max 50."),
};

function dealLine(d: Deal): string {
  const money = (n: number) => formatPrice(n, d.currency);
  const parts = [`**${d.name}**`, `code: \`${d.code}\``];
  if (d.promoCode) {
    parts.push(`**${money(d.priceNow)}** with code ${d.promoCode} (-${d.discountPercent} %)`);
    parts.push(`list ${money(d.priceList)}${d.priceOriginal != null ? `, was ${money(d.priceOriginal)}` : ""}`);
    if (d.priceOriginal == null && d.savings !== undefined) parts.push(`save ${money(d.savings)}`);
  } else if (d.originalPrice !== undefined) {
    // Unchanged pre-promo-code wording (alza.cz shelf discounts).
    parts.push(`${money(d.price)} (was ${money(d.originalPrice)}, -${d.discountPercent} %)`);
  } else {
    parts.push(money(d.price));
  }
  if (d.badge) parts.push(d.badge);
  if (d.alzaPlusPrice != null) parts.push(`AlzaPlus+ ${money(d.alzaPlusPrice)}${d.nonMemberPrice != null ? ` (non-member ${money(d.nonMemberPrice)})` : ""}`);
  if (d.monthlyFrom != null) parts.push(`from ${money(d.monthlyFrom)}/month`);
  if (d.rating !== undefined) parts.push(`★ ${d.rating}${d.reviewCount !== undefined ? ` (${d.reviewCount}×)` : ""}`);
  if (d.availabilityText) parts.push(d.availabilityText);
  let line = `- ${parts.filter(Boolean).join(" · ")}\n  ${d.url}`;
  if (d.priceCheck && !d.priceCheck.ok) {
    line += `\n  ⚠ price check failed: list × (1 − ${d.promoPercent} %) = ${money(d.priceCheck.expected)}, but the code price shown is ${money(d.priceNow)} — verify on the product page.`;
  }
  return line;
}

function usedLine(d: Deal): string {
  const money = (n: number) => formatPrice(n, d.currency);
  const kind = d.condition === "used" ? "USED" : "OPENED BOX";
  const parts = [`**${d.name}**`, `code: \`${d.code}\``, `${kind}: **${money(d.priceNow)}**${d.promoCode ? ` with code ${d.promoCode}` : ""}`];
  if (d.newPrice !== null) parts.push(`new: ${money(d.newPrice)}`);
  if (d.availabilityText) parts.push(d.availabilityText);
  return `- ${parts.join(" · ")}\n  ${d.url}`;
}

export function formatDeals(deals: Deal[], scanned: number, usedOffers: Deal[] = [], partial = false): string {
  const partialNote = partial ? ["", "⚠ Time budget reached before every page was read — these results are partial. Call get_deals again with the same input: pages already loaded are reused, so it finishes faster."] : [];
  const usedBlock = usedOffers.length
    ? ["", `Previously sold goods (opened box / used) — NOT ranked or compared with the new goods above, since you accept a compromise on condition, but possibly a bargain:`, "", ...usedOffers.map(usedLine)]
    : [];
  if (deals.length === 0) return [`No discounted products found (scanned ${scanned} listing cards).`, ...usedBlock, ...partialNote].join("\n");
  const flagged = deals.filter((d) => d.priceCheck && !d.priceCheck.ok).length;
  return [
    `${deals.length} deal(s), best discount first (scanned ${scanned} listing cards):`,
    ...(flagged ? [`⚠ ${flagged} deal(s) failed the promo-code price check (marked below).`] : []),
    "",
    ...deals.map(dealLine),
    ...usedBlock,
    ...partialNote,
  ].join("\n");
}

export function createGetDealsTool(deps: ToolDeps): RegisterableTool {
  const name = "get_deals";
  return {
    name,
    register(server, errorWrap) {
      return server.registerTool(
        name,
        {
          title: "Find discounted Alza products",
          description:
            "Find currently discounted products on Alza.cz or Alza.sk (the storefront set by ALZA_BASE_URL), with the price you can pay now, the shelf (list) price, an older crossed-out price, promo codes and AlzaPlus+ member prices, and a discount % COMPUTED from the observed prices (never from marketing badges). " +
            "Per deal: `priceNow` (the price with the promo code when the card has one, e.g. Alza dni 'Kúpiť s kódom ALZADNI15'), `promoCode`/`promoPercent` (the code's trailing number), `priceList` (shelf price, also `price`), `priceOriginal` (the older crossed-out price on 'Zľavnené -N %' cards), `savings` (shelf savings, e.g. 'Ušetríte 7,90 €'), `badge` (e.g. 'SUPER CENA', 'CENOVÁ BOMBA'), `monthlyFrom`, `alzaPlusPrice`/`nonMemberPrice` (null when the card has no AlzaPlus+ price), rating, `reviewCount`, `availabilityText`. " +
            "`priceCheck` tests priceNow ≈ priceList × (1 − promoPercent/100) and is `ok: false` (also flagged in the text) when the card's numbers do not add up. " +
            "Pass `category_id` or a listing `url` (e.g. an Alza dni page '/monitory-23-a-24/alza-dni/18848792-e39.htm'); further pages (at most 4) are loaded in parallel. With neither, page 1 of five popular categories is scanned. It covers a bounded sample, not Alza's whole sale inventory (`candidatesScanned`, `pagesScanned`). " +
            "Opened-box and used goods (stock line 'Rozbalené'/'Zánovné', price box 'Nový 165 €') are never ranked with new goods: they come back separately in `usedOffers` with `condition` and `newPrice`; mention them to the user as a possible bargain and name the compromise on condition, but do not compare their price with new products. " +
            "If Alza's Cloudflare protection challenges the headless browser, set ALZA_CDP_URL to attach to your own Chrome. Read-only.",
          inputSchema,
          outputSchema: OUTPUT_SCHEMAS["get_deals"],
          annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
        },
        async (args) =>
          errorWrap(name, async () => {
            const res = tagLinks(await deps.catalog.getDeals({
              categoryId: args.category_id,
              url: args.url,
              minDiscountPercent: args.min_discount_percent,
              limit: args.limit,
            }));
            return {
              content: [{ type: "text", text: formatDeals(res.deals, res.candidatesScanned, res.usedOffers, res.partial) }],
              structuredContent: {
                categoryIds: res.categoryIds,
                ...(res.url ? { url: res.url } : {}),
                candidatesScanned: res.candidatesScanned,
                pagesScanned: res.pagesScanned,
                ...(res.partial ? { partial: true } : {}),
                total: res.deals.length,
                deals: res.deals as unknown as Record<string, unknown>[],
                usedOffers: res.usedOffers as unknown as Record<string, unknown>[],
              },
            };
          })
      );
    },
  };
}
