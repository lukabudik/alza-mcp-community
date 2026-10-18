import { z } from "zod";
import { OUTPUT_SCHEMAS } from "./output-schemas.js";
import { formatSearchResult } from "./format.js";
import type { RegisterableTool, ToolDeps } from "./types.js";
import { tagLinks } from "./tracking.js";

const inputSchema = {
  query: z.string().trim().min(1).max(200).describe("Search keywords. Required. Example: 'iPhone 15 Pro', 'PlayStation 5', 'gaming mouse Logitech'."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Maximum number of results to return. Default 20, max 50."),
  page: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe(
      "1-indexed result page (1-50) (follows Alza's rendered pagination). Only pages Alza actually renders are reachable — a page beyond the rendered set returns no results rather than repeating page 1. Paginating this way does not change which page the sweep scans (sorting still scans from page 1)."
    ),
  sort: z
    .enum(["relevance", "price-asc", "price-desc", "rating", "newest"])
    .optional()
    .describe(
      "Sort order, default 'relevance'. Alza's search page ignores server-side sort parameters, so price (asc/desc) and rating sorts gather candidates from up to 3 result pages (~72 items — the top of Alza's relevance ranking) and sort them client-side; the response's `candidatesScanned` says how many candidates were scanned. 'newest' is best-effort (Alza's newest-sort is client-side JS, so it returns relevance order). For an absolute price floor, also pass `max_price` and/or narrow `category_id`."
    ),
  min_price: z
    .number()
    .min(0)
    .optional()
    .describe("Minimum price in the locale's currency. Products whose price could not be read are excluded. Must not exceed `max_price`. Applied client-side to the scanned candidates (up to ~72 top-ranked results over 3 pages, see `candidatesScanned`), not to the whole catalog."),
  max_price: z
    .number()
    .min(0)
    .optional()
    .describe("Maximum price in the locale's currency. Products whose price could not be read are excluded. Must not be below `min_price`. Applied client-side to the scanned candidates (up to ~72 top-ranked results over 3 pages, see `candidatesScanned`), not to the whole catalog."),
  in_stock: z
    .boolean()
    .optional()
    .describe(
      "If true, keep only products purchasable right now (card shows a 'Do košíku'/'Vybrat variantu' (alza.sk: 'Do košíka'/'Vybrať variant') purchase CTA; cards with a 'Hlídat'/'Strážiť' watch button are excluded). Derived from the search card's CTA — for real delivery dates use `get_product`."
    ),
  category_id: z
    .number()
    .int()
    .optional()
    .describe(
      "Restrict the search to a specific category id. Use list_categories to discover ids."
    ),
  min_screen_inches: z
    .number()
    .min(0)
    .optional()
    .describe(
      "Minimum screen diagonal in inches, for display products (monitors, TVs, laptops). With `category_id` (and a category that has a diagonal slider) this is Alza's own server-side diagonal filter (live-verified 2026-10-06), snapped to the slider's real sizes and reported in `appliedRanges`; like `filters`, that switches to the category-browse page, so `query` is not applied. Without `category_id` it falls back to parsing the product name's leading size (e.g. '40\" MSI MAG401QR' → 40), excluding products whose name doesn't start with a size."
    ),
  max_screen_inches: z
    .number()
    .min(0)
    .optional()
    .describe("Maximum screen diagonal in inches. See `min_screen_inches` for when this is a server-side filter vs a name-based fallback."),
  producer_ids: z
    .array(z.number().int().positive())
    .max(1)
    .optional()
    .describe(
      "Filter by ONE brand id (an array of at most one — Alza has no multi-brand category URL; to compare brands call once per brand) — get real ids from `list_category_filters`'s `brands`. Requires `category_id`. Works in every category."
    ),
  filters: z
    .array(
      z.union([
        z
          .object({
            param_id: z.number().int().positive().describe("The facet's param_id from `list_category_filters` (a `filterMode: \"value\"` group)."),
            value_id: z.number().int().positive().describe("The chosen value's value_id from that facet's `values` list."),
          })
          .strict(),
        z
          .object({
            param_id: z.number().int().positive().describe("The facet's param_id from `list_category_filters` (a `filterMode: \"range\"` slider group)."),
            min: z.number().optional().describe("Lower bound, inclusive, in the facet's own units — use a `values[].value` number from `list_category_filters` (e.g. 711.2 for a 28\" monitor diagonal in mm). Snapped up to the nearest real step."),
            max: z.number().optional().describe("Upper bound, inclusive, in the facet's own units (`values[].value`). Snapped down to the nearest real step."),
          })
          .strict(),
      ])
    )
    .optional()
    .describe(
      "Attribute filter selections from `list_category_filters` (`filterable: true` groups only; never guess ids). Requires `category_id`. Combines with `producer_ids`. Two forms: `{param_id, value_id}` for Checkbox groups (`filterMode: \"value\"`), and `{param_id, min?, max?}` for Slider groups (`filterMode: \"range\"` — screen size, refresh rate, brightness, weight, port counts, …; at least one bound; units are the group's `values[].value`; live-verified 2026-10-06). The ranges Alza actually applied come back in `appliedRanges`. If Alza doesn't honour a filter, the call errors instead of returning unfiltered results."
    ),
};

type FilterArg = { param_id: number; value_id: number } | { param_id: number; min?: number; max?: number };

/** Split the `filters` argument into Checkbox (value) and Slider (range) selections. */
export function splitFilterArgs(filters: FilterArg[] | undefined): {
  filters?: Array<{ paramId: number; valueId: number }>;
  ranges?: Array<{ paramId: number; min?: number; max?: number }>;
} {
  if (!filters) return {};
  const values: Array<{ paramId: number; valueId: number }> = [];
  const ranges: Array<{ paramId: number; min?: number; max?: number }> = [];
  for (const f of filters) {
    if ("value_id" in f) {
      values.push({ paramId: f.param_id, valueId: f.value_id });
      continue;
    }
    if (f.min === undefined && f.max === undefined) {
      throw new Error(`filters: range entry for param_id ${f.param_id} needs min and/or max (or use value_id for a Checkbox facet)`);
    }
    ranges.push({ paramId: f.param_id, min: f.min, max: f.max });
  }
  return {
    ...(values.length > 0 ? { filters: values } : {}),
    ...(ranges.length > 0 ? { ranges } : {}),
  };
}

export function createSearchProductsTool(deps: ToolDeps): RegisterableTool {
  const name = "search_products";
  return {
    name,
    register(server, errorWrap) {
      return server.registerTool(
        name,
        {
          title: "Search Alza products",
          description:
            "Search the Alza.cz catalog by keyword. Use this for product discovery — finding what's available, comparing options, or starting research. Returns a list with product code, name, price, stock (from the card's purchase CTA), and rating. Each result's `price` is the shelf price; when the card offers a promo code the lowest price payable is `priceNow` with its `promoCode` (and `alzaPlusPrice` for members) — quote those, not just `price`. Results with `condition` ('opened' = Rozbalené, 'used') are previously sold goods with a `newPrice` reference: never compare their price with new goods or call the gap to `newPrice` a discount, but do tell the user they may be a bargain. To get full details for one product, follow up with `get_product`. Price filters (`min_price`/`max_price`, rejected when inverted) and sorts are applied client-side to the top ~72 ranked candidates, so a narrow window can return fewer items than exist; `pageSize` is the real number of cards per Alza page (~24, not your `limit`) and `hasMore` says whether further pages exist. Sorting: Alza's search page ignores server-side sort, so price-asc / price-desc / rating scan up to ~72 top-ranked candidates (3 pages) and sort them client-side — `candidatesScanned` reports how many were scanned; for an absolute price floor also pass `max_price`. `in_stock: true` keeps only products with a live purchase CTA. " +
            "Brand/attribute filtering: call `list_category_filters({category_id})` for real ids, then pass `producer_ids` and/or `filters` with `category_id`. This switches to Alza's own filtered category page, so `query` is ignored and results match what the website shows; a filter Alza doesn't honour returns an error rather than unfiltered results. Slider facets (screen size, refresh rate, brightness, weight, …) filter by `{param_id, min?, max?}` range; the applied ranges come back in `appliedRanges`. " +
            "`min_screen_inches`/`max_screen_inches` use the category's real diagonal slider when `category_id` is given, and a product-name size heuristic otherwise. For attributes Alza has no facet for, compare shortlisted candidates with `get_product`'s `params`. " +
            "Read-only.",
          inputSchema,
          outputSchema: OUTPUT_SCHEMAS["search_products"],
          annotations: {
            readOnlyHint: true,
            idempotentHint: true,
            openWorldHint: true,
          },
        },
        async (args) =>
          errorWrap(name, async () => {
            const raw = await deps.catalog.searchProducts({
              query: args.query,
              limit: args.limit,
              page: args.page,
              sort: args.sort,
              minPrice: args.min_price,
              maxPrice: args.max_price,
              inStock: args.in_stock,
              categoryId: args.category_id,
              minScreenInches: args.min_screen_inches,
              maxScreenInches: args.max_screen_inches,
              producerIds: args.producer_ids,
              ...splitFilterArgs(args.filters),
            });
            const result = tagLinks(raw);
            return {
              content: [{ type: "text", text: formatSearchResult(result) }],
              structuredContent: {
                query: result.query,
                total: result.total,
                page: result.page,
                pageSize: result.pageSize,
                ...(result.hasMore !== undefined ? { hasMore: result.hasMore } : {}),
                ...(result.nextPage !== undefined ? { nextPage: result.nextPage } : {}),
                candidatesScanned: result.candidatesScanned,
                products: result.products,
                ...(result.appliedRanges ? { appliedRanges: result.appliedRanges } : {}),
              },
            };
          })
      );
    },
  };
}
