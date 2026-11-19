import { z } from "zod";
import { OUTPUT_SCHEMAS } from "./output-schemas.js";
import { formatProduct } from "./format.js";
import type { RegisterableTool, ToolDeps } from "./types.js";
import { tagLinks } from "./tracking.js";

const inputSchema = {
  code: z
    .string()
    .min(1)
    .max(64)
    .describe(
      "Alza product code, e.g. 'WEXOA002B0'. This is the canonical identifier returned by `search_products` (the `code` field). Not the numeric id."
    ),
};

export function createGetProductTool(deps: ToolDeps): RegisterableTool {
  const name = "get_product";
  return {
    name,
    register(server, errorWrap) {
      return server.registerTool(
        name,
        {
          title: "Get product details",
          description:
            "Fetch details for a single product by its Alza code (the `code` from `search_products`, e.g. 'WEXOA002B0' — not the numeric id): name, price (with the original price when discounted), availability, rating, brand, category, primary image, URL, and the spec table when the product page carries one (up to 30 rows, merged from both the DOM spec table and the JSON-LD `additionalProperty` list some page templates use instead — fixed 2026-09-27 after a product with only the latter returned no params at all). " +
            "Use after `search_products` to compare shortlisted candidates in depth, and to get the canonical URL to show the user. " +
            "For reviews use `get_product_reviews`; for the complete spec sheet (parameterGroups) use `mobile_read` with operation=`router_product` and product_id = the numeric `d########` id from the product URL. " +
            "`price` is the price this visitor pays, read from the page's visible price box like `search_products` reads cards (with a `--login` session: the account's own price; `originalPrice` is the crossed-out price and `publicPrice` the price for visitors who are not signed in, when it differs). " +
            "The rest comes from the product page's JSON-LD schema; availability comes from the page's visible availability line (JSON-LD can say InStock for on-order items), with `jsonLdAvailability` set when the two disagree. Read-only.",
          inputSchema,
          outputSchema: OUTPUT_SCHEMAS["get_product"],
          annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
        },
        async (args) =>
          errorWrap(name, async () => {
            const product = tagLinks(await deps.catalog.getProduct(args.code));
            return {
              content: [{ type: "text", text: formatProduct(product) }],
              structuredContent: { product: product as unknown as Record<string, unknown> },
            };
          })
      );
    },
  };
}
