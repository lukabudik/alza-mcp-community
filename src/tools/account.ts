import { z } from "zod";
import { OUTPUT_SCHEMAS } from "./output-schemas.js";
import { MUTATION_ACTIONS, type MobileAccount } from "../domain/mobile-account.js";
import type { RegisterableTool, ToolDeps, ToolResult } from "./types.js";
import { ANONYMOUS_NOTE, formatAddToCart, formatCart, formatCheckoutPreview, formatDeliveryOptions, isAnonymousUserData, jsonResult, withConciseText } from "./account-format.js";

function apiAccount(deps: ToolDeps): MobileAccount {
  if (!deps.mobileAccount) throw new Error("mobile API account tools are not configured");
  return deps.mobileAccount;
}

function result(value: unknown): ToolResult {
  // Issue #73: the text channel is capped; structuredContent keeps the full value.
  return jsonResult(value);
}

const jsonObject = z.record(z.string(), z.unknown());

/** Shared prerequisite sentence for token-scoped tools. */
const AUTH_PREREQ =
  "Requires a loaded mobile API access token — check `account_status` first; if none is loaded, run `auth_start`, have the user complete the browser sign-in, then `auth_exchange` with the returned code and state.";

/** The whitelisted writes `mutate_list` executes; each is also a guarded MUTATION_ACTIONS entry. */
const LOW_RISK_ACTIONS = [
  "create", "rename", "delete", "add", "remove", "move", "set_country", "set_isic",
  "add_gift", "add_order_service", "send_feedback", "submit_discussion", "rate_discussion",
  "coupon_add", "coupon_remove", "basket_update", "basket_unlock",
  "gdpr_export",
] as const satisfies readonly (typeof MUTATION_ACTIONS)[number][];

const READ_OPERATIONS = [
  "url_info", "legacy_product", "router_product", "quick_order_summary", "user_review",
  "discussion_posts", "premium_trial", "validate_login_name", "o3_info", "validate_isic",
  "order_helpdesk_questions", "user_data", "contacts", "visitor_navigation", "user_navigation",
  "catalog_user_navigation", "anonymous_orders", "anonymous_order", "user_order", "order_part",
  "after_order_payments", "order_add_info", "order2_info", "delivery_countries",
  "commodity_lists", "commodity_list", "alternatives", "branches", "zip_codes", "search",
  "category", "facets", "ean_lookup", "hierarchical_filter", "basket_info", "cart",
  "cost_estimate", "web_after_payment_dialog", "home_categories", "web_zip_codes",
  "chat_navigation",
] as const;

export function createAccountTools(deps: ToolDeps): RegisterableTool[] {
  const authDiscovery: RegisterableTool = {
    name: "auth_discovery",
    register(server, wrap) {
      return server.registerTool(
        "auth_discovery",
        {
          title: "Read Alza OAuth discovery",
          description:
            "Read the live OpenID Connect discovery document that the Alza mobile app uses (issuer, authorization endpoint, token endpoint). " +
            "Use only when debugging the OAuth flow or verifying which identity endpoints Alza exposes before calling `auth_start`. " +
            "Do not use for everyday shopping — it returns a configuration document, not account data, and changes nothing. " +
            "Read-only; no credentials are ever sent.",
          inputSchema: {},
          annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["auth_discovery"],
        },
        async () => wrap("auth_discovery", async () => result(await apiAccount(deps).authDiscovery())),
      );
    },
  };
  const authStart: RegisterableTool = {
    name: "auth_start",
    register(server, wrap) {
      return server.registerTool(
        "auth_start",
        {
          title: "Start Alza mobile API OAuth",
          description:
            "Start an OAuth 2.0 PKCE sign-in for the Alza mobile API: returns an authorization URL plus a state value. " +
            "Use when `account_status` reports no loaded token, or when account tools start failing with authentication errors. " +
            "Flow: open the returned authorization URL in a browser, sign in to Alza, the app redirects to `alza://identity?code=...&state=...` — then call `auth_exchange` with that redirect URL (or its code and this state). " +
            "Desktop browsers cannot open the `alza://` scheme, so the page appears to stall and after ~40 s shows \"Při přihlášení došlo k chybě.\" — that message is a client-side timer, not a failed sign-in. " +
            "Tell the user to open DevTools before signing in (Network tab with \"Preserve log\" on) and copy the `alza://identity?code=...` URL from the redirect's `Location` header, or from the Console error about failing to launch `alza://`. The code is short-lived, so exchange it promptly. " +
            "This call only creates a local PKCE session: the user's credentials never enter the MCP and nothing changes on Alza's side. " +
            "Do not call it repeatedly for one sign-in — each call supersedes the previous state.",
          inputSchema: {},
          annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["auth_start"],
        },
        async () => wrap("auth_start", async () => result(await apiAccount(deps).authStart())),
      );
    },
  };
  const authExchange: RegisterableTool = {
    name: "auth_exchange",
    register(server, wrap) {
      return server.registerTool(
        "auth_exchange",
        {
          title: "Exchange Alza OAuth code",
          description:
            "Complete the OAuth 2.0 PKCE sign-in: exchange the authorization code for mobile API tokens and load them into this server. " +
            "Use immediately after the user finishes the `auth_start` flow in the browser. " +
            "Pass the whole `alza://identity?code=...&state=...` redirect URL as `code` (state is then read from it), or the bare `code` plus `state` — never a password and never a refresh token here. " +
            "Fails if the state does not match a pending `auth_start` session (start over from `auth_start` in that case). " +
            "Side effect: replaces the token set currently loaded in this process; afterwards account tools such as `cart`, `profile`, and `order` are authenticated.",
          inputSchema: {
            code: z.string().min(1).describe("Authorization code from the `alza://identity` redirect (the `code` query parameter), or the full redirect URL."),
            state: z.string().min(1).optional().describe("State value returned by `auth_start`; must match the pending PKCE session exactly. Optional when `code` is the full redirect URL."),
          },
          annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["auth_exchange"],
        },
        async (args) => wrap("auth_exchange", async () => result(await apiAccount(deps).authExchange(args.code, args.state))),
      );
    },
  };
  const mobileRead: RegisterableTool = {
    name: "mobile_read",
    register(server, wrap) {
      return server.registerTool(
        "mobile_read",
        {
          title: "Read a raw Alza mobile API operation",
          description:
            "Read-only escape hatch for Alza mobile API operations that have no dedicated tool. " +
            "Prefer the typed tool when one exists — `cart` (operation `basket_info`), `profile` (`user_data`), `contacts` (`contacts`), `search_products` (`search`), `list_categories` (`category`), `order` (`user_order` {order_id, user_id} — the numeric user id from `profile`, not a 0/1 flag) — and use `mobile_read` for the rest. " +
            "High-value operations: `router_product` {product_id} returns the full product envelope including the `parameterGroups` spec sheet (product_id is the numeric `d########` id from the product URL, e.g. 13078770 from https://www.alza.cz/...-d13078770.htm); `legacy_product` {product_id, ucik, pgrik, country} is the same with the server-required UCÍK/PGŘÍK values (copy them from a `router_product` response); also `alternatives` {commodity_id}, `ean_lookup` {ean_list}, `facets` {category_id}, `hierarchical_filter`, `commodity_lists`, `commodity_list` {list_id}, `cost_estimate`, `delivery_countries`, `web_after_payment_dialog` {order_id}, `order_part`/`after_order_payments` {order_id, part_id}, `order2_info`, `order_helpdesk_questions`, `user_review` {commodity_id}, `discussion_posts` {commodity_id}, `premium_trial` {user_id}, `validate_login_name` {email}, `validate_isic` {card_number, name}, `o3_info`, `quick_order_summary` {user_id, commodity_id, pgrik, ucik}, `user_navigation` {user_id}, `search` {search_term}, `category` {category_id}, `branches` {latitude, longitude}, `url_info` {url}, `anonymous_orders` {invoice_number}, `anonymous_order` {order_id}, `home_categories` (requires the server-side pgri/ui query values — copy them from an upstream `self` href in a navigation response, e.g. `?pgri=p__…&ui=u__…`), `zip_codes`, `web_zip_codes` {input}, `visitor_navigation`, `catalog_user_navigation`. Required arguments are checked before any request; a missing or non-numeric one is refused with an `Invalid arguments` error. " +
            "This tool never accepts arbitrary URLs or credentials, and never mutates state. " +
            "Account-scoped operations " + AUTH_PREREQ + " Returns the raw upstream envelope (`err`/`msg`/`data`); `err:1` with a `msg` is an Alza-side validation (e.g. unknown product id).",
          inputSchema: {
            operation: z.enum(READ_OPERATIONS).describe("Which fixed, APK-confirmed mobile API read operation to execute. See the tool description for per-operation arguments."),
            args: jsonObject.optional().describe("Operation-specific arguments as a JSON object, e.g. router_product: {product_id: 13078770}; web_after_payment_dialog: {order_id: \"...\"}. Omit for operations that take none."),
          },
          annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["mobile_read"],
        },
        async (args) => wrap("mobile_read", async () => {
          const out = result(await apiAccount(deps).read(args.operation, args.args ?? {}));
          if (args.operation === "user_data" && isAnonymousUserData(out.structuredContent)) {
            out.content[0]!.text = `${ANONYMOUS_NOTE}\n\n${out.content[0]!.text}`;
          }
          return out;
        }),
      );
    },
  };
  const prepareMutation: RegisterableTool = {
    name: "prepare_mutation",
    register(server, wrap) {
      return server.registerTool(
        "prepare_mutation",
        {
          title: "Prepare an Alza mutation",
          description:
            "Start a two-step mutation by returning a one-time confirmation token bound to exactly one action. This call itself sends nothing to Alza. " +
            "Use it before the high-impact typed mutations — `register` (action `register`), `address_upsert` (`address_create` or `address_edit`), `address_delete` (`address_delete`), `pay_after_order` (`after_order_payment`), `web_place_order` (`web_place_order`), `web_pay_after_order` (`web_after_order_payment`), `cancel_order` (`cancel_order`), `review_submit` (`review_submit`), `subscription_activate` (`subscription_activate`), `subscription_update_installment` (`subscription_update_installment`), `upload_attachment` (`attachment_upload`), `watchdog_set` (`watchdog_set`), `watchdog_delete` (`watchdog_delete`) — and before any low-risk `mutate_list` action (" + LOW_RISK_ACTIONS.map((a) => "`" + a + "`").join(", ") + "). " +
            "Pass `payload`: exactly the arguments you will send to that tool, all except `confirmation_token` (for `mutate_list`, the object you will pass as its `payload`). The token is bound to the action and to that payload — a call with different arguments is refused and spends the token. " +
            "Pass the returned token as `confirmation_token` on the matching call; the token is single-use — the first call that presents it spends it, even if that call fails, so prepare a new one to retry — and it expires 5 minutes after it is issued (`expiresAt`). " +
            "Each action has its own pending token: preparing the same action again replaces its earlier token, tokens prepared for other actions stay valid. " +
            "Do not use for read-only tools, and not for `add_to_cart` (which is a low-risk cart write that needs no token).",
          inputSchema: {
            // The list assertMutationToken enforces, so the schema cannot drift from it (#112).
            action: z.enum(MUTATION_ACTIONS).describe("Which mutation you are about to perform; the token will only be accepted by that action's tool."),
            payload: jsonObject.describe("The exact arguments of the mutation call, without `confirmation_token` — e.g. cancel_order: {order_id, part_id, hash, reason}; mutate_list coupon_add: {coupon: \"CODE\"}. Show these to the user when asking for confirmation; the call must repeat them unchanged (omitted defaulted arguments are fine)."),
          },
          annotations: { readOnlyHint: true, idempotentHint: false, destructiveHint: false, openWorldHint: false },
          outputSchema: OUTPUT_SCHEMAS["prepare_mutation"],
        },
        async (args) => wrap("prepare_mutation", async () => result(apiAccount(deps).prepareMutation(args.action, args.payload))),
      );
    },
  };
  const mutateList: RegisterableTool = {
    name: "mutate_list",
    register(server, wrap) {
      return server.registerTool(
        "mutate_list",
        {
          title: "Execute a whitelisted Alza mutation",
          description:
            "Execute one low-risk, APK-confirmed mutation using a one-time token from `prepare_mutation`. " +
            "Use for shopping-list operations (`create`/`rename`/`delete`/`add`/`remove`/`move`), account settings (`set_country`, `set_isic`), `add_gift`, `add_order_service`, `send_feedback`, `submit_discussion`, `rate_discussion`, coupons (`coupon_add` takes `{coupon: \"CODE\"}`; `coupon_remove` takes `{couponId: <int>}` — the id from a prior `cart` read), basket flags (`basket_update` takes `{basket_id, flag?, is_delayed_payment?}`; `basket_unlock`), and the GDPR data export (`gdpr_export` takes `{user_id}` — queues the XML personal-data export to the account's own login email, 202 Accepted; read `gdpr_info` first). " +
            "Do not use for high-impact mutations (order, payment, registration, address, review, subscription, attachment) — each has its own typed tool with its own token. " +
            "The `payload` fields must match the mobile DTO for the chosen action exactly. " +
            "Side effect: persists the change on the user's Alza account. Example: `mutate_list({action: \"coupon_add\", confirmation_token: \"...\", payload: {coupon: \"WELCOME10\"}})`.",
          inputSchema: {
            action: z.enum(LOW_RISK_ACTIONS).describe("Which whitelisted mutation to execute; determines the expected `payload` shape."),
            confirmation_token: z.string().min(32).describe("One-time token from `prepare_mutation` prepared with this same `action` and this same `payload`."),
            payload: jsonObject.describe("Mutation payload matching the mobile DTO for `action`, e.g. coupon_add: {coupon: \"CODE\"}; coupon_remove: {couponId: 123}; basket_update: {basket_id: 1, flag: true}."),
          },
          annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["mutate_list"],
        },
        async (args) => wrap("mutate_list", async () => result(await apiAccount(deps).mutateList(args.action, args.confirmation_token, args.payload))),
      );
    },
  };
  const status: RegisterableTool = {
    name: "account_status",
    register(server, wrap) {
      return server.registerTool(
        "account_status",
        {
          title: "Check mobile API auth status",
          description:
            "Report whether a mobile API access token is loaded in this server process, and when it expires (`expiresAt`, `expired`) if that is known. An expired token is refreshed automatically before the next account call when a refresh token is loaded. " +
            "Use as a first check before account-scoped tools (`cart`, `profile`, `order`, `add_to_cart`), or to diagnose \"not authenticated\" failures. " +
            "If no token is loaded, run `auth_start`, have the user complete the browser sign-in, then `auth_exchange`. " +
            "Read-only; no network call.",
          inputSchema: {},
          annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
          outputSchema: OUTPUT_SCHEMAS["account_status"],
        },
        async () => wrap("account_status", async () => result(apiAccount(deps).status())),
      );
    },
  };
  const cart: RegisterableTool = {
    name: "cart",
    register(server, wrap) {
      return server.registerTool(
        "cart",
        {
          title: "Read the Alza account cart",
          description:
            "Read the authenticated user's Alza shopping cart: item lines with quantities and prices, applied discounts, vouchers, and the basket/order identifiers later checkout steps need. " +
            "Use to verify an `add_to_cart` worked, to inspect coupon/voucher state, or to collect ids for `mutate_list` (e.g. `coupon_remove.couponId`) and `basket_update`. " +
            "Do not use for the anonymous web/visitor cart — that is `web_cart`. " +
            AUTH_PREREQ + " Read-only. The response envelope is large (item lines + order summary); the `basket_cnt`, `pricePay`, and `items` fields are the signal.",
          inputSchema: {},
          annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["cart"],
        },
        async () => wrap("cart", async () => withConciseText(await apiAccount(deps).cart(), formatCart)),
      );
    },
  };
  const add: RegisterableTool = {
    name: "add_to_cart",
    register(server, wrap) {
      return server.registerTool(
        "add_to_cart",
        {
          title: "Add a product to the account cart",
          description:
            "Add one product to the mobile-API cart (`restservice.svc/v2/basket/add`) by its Alza product code (the `code` from `search_products`/`get_product`, e.g. `RI054b1` — not the numeric id). " +
            "Use when the user wants a product put into their Alza account; pass `quantity` (default 1, max 99). " +
            "Side effect: mutates the cart — the item stays there until removed or ordered (there is no basket-remove tool). " +
            "Do not use for the separate HATEOAS web checkout cart — that is `web_add_to_cart` (does not share state with this tool; see its description). " +
            "LIVE NOTE (2026-09-26): despite the usual auth prerequisite, this call also succeeds with no OAuth token loaded — it falls back to an anonymous, visitor-keyed (Balancer-Guid) WCF cart (`user_id: -1`). With a token loaded, an anonymous answer means the token is stale: it is refreshed before the call when expired, and an anonymous answer to a loaded token is reported as an error (not retried) so nothing lands in the visitor cart unnoticed. " +
            "That anonymous cart is exactly what `delivery_options` + `web_place_order` need for the working (non-500) anonymous order pipeline — do NOT use `checkout_preview`/`place_order` for anonymous checkout, their `sendOrder3` step 500s unconditionally (https://github.com/lukabudik/alza-mcp-community/blob/main/docs/gap-analysis.md G1/G5). " +
            AUTH_PREREQ + " The response echoes the added line and the new basket count; verify with `cart` if in doubt. Example: `add_to_cart({code: \"RI054b1\", quantity: 1})`.",
          inputSchema: {
            code: z.string().min(1).describe("Alza product code, e.g. 'RI054b1' (the `code` field from `search_products`)."),
            quantity: z.number().int().min(1).max(99).default(1).describe("How many units to add. Default 1, max 99."),
          },
          annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["add_to_cart"],
        },
        async (args) => wrap("add_to_cart", async () => withConciseText(await apiAccount(deps).addToCart(args.code, args.quantity), formatAddToCart)),
      );
    },
  };
  const delivery: RegisterableTool = {
    name: "delivery_options",
    register(server, wrap) {
      return server.registerTool(
        "delivery_options",
        {
          title: "List delivery & payment options",
          description:
            "List the delivery and payment option groups for the current Alza account cart (AlzaShop pickup, AlzaBox lockers, courier, payment methods) from the mobile API. " +
            "Use after items are in the cart and before `checkout_preview`, to show the user delivery/payment choices and to obtain the `selected_delivery_option_id` that later steps may require. " +
            "Do not use on an empty cart — Alza answers with validation errors. " +
            "Pass `selected_delivery_option_id` to re-fetch the groups anchored on a specific delivery choice. " +
            AUTH_PREREQ + " Read-only.",
          inputSchema: {
            selected_delivery_option_id: z.number().int().optional().describe("Delivery option id from a prior response to anchor the group listing on a chosen delivery method. Omit for the default listing."),
          },
          annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["delivery_options"],
        },
        async (args) => wrap("delivery_options", async () => withConciseText(await apiAccount(deps).deliveryOptions(args.selected_delivery_option_id), formatDeliveryOptions)),
      );
    },
  };
  const pickup: RegisterableTool = {
    name: "select_pickup_point",
    register(server, wrap) {
      return server.registerTool(
        "select_pickup_point",
        {
          title: "Delivery → payment associations (does NOT pick a pickup point)",
          description:
            "Despite the name, this tool does not select an AlzaBox or pickup point. It POSTs a delivery selection to the mobile `getDeliveryAssociations` route and returns the payment methods that work with that delivery, each with the resulting delivery price (`data[]`: payment `id` such as 103/143/144/203, `price`, `paymentPrice`, `isLowCredit`, `isHidden`). " +
            "This was re-tested live on 2026-10-06 against an authenticated cart. All 127 entries in `delivery_options` (115 deliveries across 2 groups plus 12 payments) had null `beforeSelectAction`/`afterSelectAction`, so the server never provides a pickup-point association form. The authenticated response was the same payment-association list the anonymous run returned on 2026-09-26 (https://github.com/lukabudik/alza-mcp-community/blob/main/docs/gap-analysis.md, https://github.com/lukabudik/alza-mcp-community/blob/main/docs/live-evidence/select-pickup-point-auth-retest-2026-10-06.md). " +
            "To actually pick an AlzaBox or pickup point and order, use `add_to_cart`, then `delivery_options` (read `orderId`/`groupId` from the AlzaBox option's `deliveryOption.href`), then `web_pickup_places` (choose a place), then `web_place_order` with that place's `parcel_shop_id`. " +
            "Use this tool only to check which payment methods (and delivery fee) apply to a delivery you already know. The payload is `{cardId: 0, deliveryGroups: [{deliveryGroupId, deliveryId, parcelShopId, deliveryServicesIds: [], timeFrameId: 0, timeSlotId: 0}]}`, built from the `delivery_options`/`cart` ids. " +
            "No change to the cart, delivery, or payment selection was observed (2026-10-06), and the call never submits an order. " +
            AUTH_PREREQ,
          inputSchema: {
            association: jsonObject.describe("Delivery selection: `{cardId: 0, deliveryGroups: [{deliveryGroupId, deliveryId, parcelShopId, deliveryServicesIds: [], timeFrameId: 0, timeSlotId: 0}]}`, with ids from `delivery_options`/`cart`."),
          },
          annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["select_pickup_point"],
        },
        async (args) => wrap("select_pickup_point", async () => result(await apiAccount(deps).selectAlzaBox(args.association))),
      );
    },
  };
  const preview: RegisterableTool = {
    name: "checkout_preview",
    register(server, wrap) {
      return server.registerTool(
        "checkout_preview",
        {
          title: "Preview mobile checkout",
          description:
            "Run the read-side of the mobile checkout (sendOrder1 + delivery/payment-group reads) and return a one-time checkout token plus totals. " +
            "Use after `delivery_options`/`select_pickup_point` to preview fees and the final order shape before committing, and to obtain the token that `place_order` requires. " +
            "This never submits the order. " +
            "Not read-only: it runs Alza's first checkout step (`sendOrder1`, which starts the server-side checkout state that `place_order` continues) and replaces any earlier checkout token (valid 5 minutes). " +
            "Requires a non-empty cart. " +
            AUTH_PREREQ + " Note: the mobile submission step (`sendOrder3`) currently returns HTTP 500 (https://github.com/lukabudik/alza-mcp-community/blob/main/docs/gap-analysis.md G1/G5) — the known-working submission path is `web_place_order`.",
          inputSchema: {
            selected_delivery_option_id: z.number().int().optional().describe("Delivery option id from `delivery_options` to preview that specific delivery method. Omit for the server default."),
          },
          annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["checkout_preview"],
        },
        async (args) => wrap("checkout_preview", async () => withConciseText(await apiAccount(deps).previewOrder(args.selected_delivery_option_id), formatCheckoutPreview)),
      );
    },
  };
  const place: RegisterableTool = {
    name: "place_order",
    register(server, wrap) {
      return server.registerTool(
        "place_order",
        {
          title: "Submit an order (mobile API)",
          description:
            "Submit an order through the mobile API's multi-step sequence using a checkout token from `checkout_preview` plus the three explicit payloads (`delivery_payment`, `user_info`, `complete_order`) copied from the preview/delivery responses. " +
            "Use only when the user has explicitly confirmed the purchase. " +
            "High-impact, money-relevant side effect: creates a real Alza order. " +
            "Known issue: the mobile `sendOrder3` step currently returns HTTP 500 (https://github.com/lukabudik/alza-mcp-community/blob/main/docs/gap-analysis.md G1/G5) — for a known-working submission path prefer `web_place_order` (legacy web WCF). " +
            AUTH_PREREQ,
          inputSchema: {
            confirmation_token: z.string().min(32).describe("Checkout token from `checkout_preview` (one-time)."),
            delivery_payment: jsonObject.describe("SelectedDeliveryPayment object copied from the checkout/delivery response."),
            user_info: jsonObject.describe("SendOrderUserInfo object (contact + address fields) copied from or confirmed against the profile/address book."),
            complete_order: jsonObject.describe("SendCompleteOrder object copied from the checkout response."),
          },
          annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["place_order"],
        },
        async (args) => wrap("place_order", async () => result(await apiAccount(deps).submitOrder(args.confirmation_token, args.delivery_payment, args.user_info, args.complete_order))),
      );
    },
  };
  const webPickupPlaces: RegisterableTool = {
    name: "web_pickup_places",
    register(server, wrap) {
      return server.registerTool(
        "web_pickup_places",
        {
          title: "List web pickup places (AlzaBox, branches, 24/7)",
          description:
            "List Alza pickup places from the live m.alza.cz personalPickup/v1 API: the type-availability form (AlzaBox/branches/24-7/showroom counts), a paginated place list, and — with `place_id` — a single place's detail (deliveryId, parcelShopId, isFree, typeText, opening hours). " +
            "Use to find where the user can collect or pick up, or to obtain the `deliveryId`/`parcelShopId` that `web_place_order` needs. " +
            "Unlike `delivery_options`, this is visitor-readable — no account token required. " +
            "IMPORTANT (live-verified 2026-09-26): `order_id`/`group_id` are typed optional but the live API 400s without both (`{\"OrderId\":[\"...required\"],\"GroupId\":[\"...required\"]}`) — this endpoint is checkout-cart-scoped, not a standalone geo lookup. Get them by calling `add_to_cart` on a product, then `delivery_options`, then reading the AlzaBox delivery option's `deliveryOption.href` query params (`orderId`, `groupId` — the same session's ids only; a fresh session's own `add_to_cart` result won't match another session's ids). " +
            "Distance sorting also needs both `latitude`/`longitude` valid alongside `order_id`/`group_id` — without a matching cart context, results come back as a fixed small list unrelated to the given coordinates. " +
            "Not every product is AlzaBox-eligible: large items (observed: 34\"+ monitors) are excluded from the full ~4000-locker AlzaBox network and only route to a handful of oversized-item pickup points nationwide — check the place list size/spread as a signal. " +
            "Read-only (this call itself has no side effect; `add_to_cart` does). Example: `add_to_cart({code: \"WK060a1l56\"})` → `delivery_options({})` → parse `orderId`/`groupId` from the AlzaBox option's `deliveryOption.href` → `web_pickup_places({order_id, group_id, latitude: 50.08, longitude: 14.42, types: [1], limit: 10})`.",
          inputSchema: {
            order_id: z.number().int().positive().optional().describe("Basket/order id of the current checkout, parsed from `delivery_options`' AlzaBox `deliveryOption.href` (`orderId` query param). In practice required — the live API 400s without it alongside `group_id`."),
            group_id: z.number().int().positive().optional().describe("Delivery group id, parsed from `delivery_options`' response (`deliveryGroupId`) or the same `deliveryOption.href` (`groupId` query param). In practice required — the live API 400s without it alongside `order_id`."),
            latitude: z.number().min(-90).max(90).optional().describe("Latitude to centre the search on (WGS84). Distance sorting requires this alongside a matching `order_id`/`group_id`."),
            longitude: z.number().min(-180).max(180).optional().describe("Longitude to centre the search on (WGS84). Distance sorting requires this alongside a matching `order_id`/`group_id`."),
            types: z.array(z.number().int().positive()).min(1).max(5).optional().describe("Pickup type filter (e.g. 1=AlzaBox, 2=branches); omit for all types."),
            limit: z.number().int().min(1).max(100).optional().describe("Page size for the place list. Default server value."),
            offset: z.number().int().min(0).optional().describe("Pagination offset for the place list."),
            place_id: z.number().int().positive().optional().describe("Fetch the detail for a single place (the call the web UI fires on place selection)."),
          },
          annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["web_pickup_places"],
        },
        async (args) => wrap("web_pickup_places", async () => result(await apiAccount(deps).webPickupPlaces(args))),
      );
    },
  };
  const webAdd: RegisterableTool = {
    name: "web_add_to_cart",
    register(server, wrap) {
      return server.registerTool(
        "web_add_to_cart",
        {
          title: "Add a product to the web visitor cart",
          description:
            "Add a product to the anonymous (visitor-keyed) Alza HATEOAS web cart via the live m.alza.cz basket/v1 API, using the numeric `commodity_id` (e.g. 7229946) from `search_products`/`get_product`. " +
            "Use for the web checkout flow (row W5) instead of the account cart — this basket is keyed to the visitor (Balancer-Guid), not to an Alza login. " +
            "The response carries the basket id; pass it to `web_cart` to read this same HATEOAS cart. " +
            "IMPORTANT — separate cart, live-verified 2026-09-26: `web_place_order` does NOT read this basket. It runs the legacy WCF pipeline (`EShopService.svc`), which shares its cart with `add_to_cart`'s mobile `restservice.svc/v2/basket/add` cart instead (same visitor session, different API family). To actually place an order, use `add_to_cart` (not this tool) → `delivery_options` → `web_place_order`. " +
            "Side effect: creates or extends the visitor HATEOAS basket. No account token required. " +
            "Example: `web_add_to_cart({commodity_id: 7229946, count: 1})`.",
          inputSchema: {
            commodity_id: z.number().int().positive().describe("Numeric Alza commodity id (e.g. 7229946; the numeric id from `get_product`/`search_products`)."),
            count: z.number().int().min(1).max(99).default(1).describe("How many units to add. Default 1, max 99."),
          },
          annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["web_add_to_cart"],
        },
        async (args) => wrap("web_add_to_cart", async () => result(await apiAccount(deps).webAddToCart({ commodity_id: args.commodity_id, count: args.count }))),
      );
    },
  };
  const chatNav: RegisterableTool = {
    name: "chat_navigation",
    register(server, wrap) {
      return server.registerTool(
        "chat_navigation",
        {
          title: "Read the chatbot HATEOAS navigation",
          description:
            "Read the live chatbotapi.alza.cz navigation for the current visitor (row W18): chatbotInitializeChatAction / chatbotReinitializeChatAction / metadata / rating actions with their server-provided hrefs and parameters. " +
            "Use when inspecting what Alza's live chatbot offers for a page, or before `chat_send` to discover the current actions. " +
            "The `country` query field is required by the server (defaults to the configured storefront, ALZA_BASE_URL). " +
            "Read-only; no token required.",
          inputSchema: {
            country: z.string().length(2).optional().describe("2-letter country code, e.g. 'CZ' or 'SK'. Defaults to the configured storefront (ALZA_BASE_URL)."),
          },
          annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["chat_navigation"],
        },
        async (args) => wrap("chat_navigation", async () => result(await apiAccount(deps).chatNavigation(args.country))),
      );
    },
  };
  const chatSend: RegisterableTool = {
    name: "chat_send",
    register(server, wrap) {
      return server.registerTool(
        "chat_send",
        {
          title: "Open/continue an Alza chatbot session",
          description:
            "Open or continue an Alza chatbot session via chatbotapi.alza.cz /v1/chat (row W18): returns the chat configuration (configId, teamName, welcomeText, messages, allowTextInput) and showChat. " +
            "Use to start a support-style conversation with page context (product detail, checkout steps). " +
            "Pass `page_type` per the 2026-09-09 capture: 1=product detail, 5=Order1, 6=Order2, 24=Order4; `initial_input` carries the user's first message. " +
            "Session-scoped, visitor-keyed write — no account state and no token required (like `web_add_to_cart`). " +
            "Example: `chat_send({page_type: 1, initial_input: 'Is this in stock?'})`.",
          inputSchema: {
            page_type: z.number().int().min(1).max(30).describe("Page context code: 1=product detail, 5=Order1, 6=Order2, 24=Order4 (2026-09-09 capture)."),
            country: z.string().length(2).optional().describe("2-letter country code, e.g. 'CZ' or 'SK'. Defaults to the configured storefront (ALZA_BASE_URL)."),
            referrer: z.string().max(500).optional().describe("Referrer URL for the chat context, if known."),
            initial_input: z.string().max(2000).optional().describe("The user's first message text (initialInput)."),
            force_initialize: z.boolean().optional().describe("Force a fresh chat initialization instead of reusing the session."),
            list_category_id: z.array(z.object({ category_id: z.number().int(), category_type_id: z.number().int() })).max(10).optional().describe("Product-context categories; the server requires the field — an empty array works without context."),
            commodity_code: z.string().max(64).optional().describe("Alza product code for the product-detail context (page_type 1)."),
            commodity_type: z.number().int().optional().describe("Commodity type id for the product-detail context."),
            manufacturer: z.string().max(64).optional().describe("Manufacturer name for the product-detail context, if known."),
            entity_id: z.string().max(64).optional().describe("Entity id for the page context, if known."),
            seo_prefix: z.string().max(128).optional().describe("SEO prefix from the product page URL, if known."),
          },
          annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["chat_send"],
        },
        async (args) => wrap("chat_send", async () => result(await apiAccount(deps).chatSend(args as unknown as Record<string, unknown>))),
      );
    },
  };
  const webCart: RegisterableTool = {
    name: "web_cart",
    register(server, wrap) {
      return server.registerTool(
        "web_cart",
        {
          title: "Read the web visitor cart",
          description:
            "Read the anonymous (visitor) Alza web checkout cart by `basket_id` (obtained from `web_add_to_cart`): the HATEOAS cart state (maxStep, itemsAction, emptyCartAction) plus item lines (productId, count, basketItemId, updateQuantityAction). " +
            "Use to verify a `web_add_to_cart` worked or to inspect this HATEOAS cart's contents. " +
            "Note: this is a different cart than the one `web_place_order` submits (that pairs with `add_to_cart`, not `web_add_to_cart`) — see `web_add_to_cart`'s description. " +
            "Do not use for the authenticated account cart — that is `cart`. " +
            "Read-only; no token required.",
          inputSchema: {
            basket_id: z.number().int().positive().describe("Basket id returned by `web_add_to_cart` (the current web basket)."),
          },
          annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["web_cart"],
        },
        async (args) => wrap("web_cart", async () => result(await apiAccount(deps).webCart(args.basket_id))),
      );
    },
  };
  return [authDiscovery, authStart, authExchange, mobileRead, prepareMutation, mutateList, status, cart, add, delivery, pickup, preview, place, webPickupPlaces, webAdd, webCart, chatNav, chatSend];
}
