import { z } from "zod";

/**
 * Per-tool `outputSchema` (audit docs/mcp-best-practices-audit.md F-06c → N-1,
 * implemented 2026-09-13).
 *
 * Design contract, recorded with the audit:
 * - The schema describes the STABLE top-level shape the tool is guaranteed to
 *   return, not the deep per-operation data shapes (those stay dynamic — the
 *   2026-09-10 audit judged per-operation schemas disproportionate).
 * - Raw upstream tools (the account/mobile stack) all return the Alza
 *   envelope: `err` 0/1/113 (number) — or an HTML error-page string in one
 *   2026-09-09 capture — `msg` string-or-null, `data`, plus operation-specific
 *   top-level keys (basket, items, form, …). Hence `passthrough`.
 * - Typed tools get their fixed shape (auth_start, prepare_mutation,
 *   account_status, checkout_preview, web_pickup_places, the 5 catalog tools).
 * - The TS SDK (1.29) validates every successful call's `structuredContent`
 *   against this schema; error results (`isError: true`) are exempt, so the
 *   errorWrap path (which carries no structuredContent) stays valid.
 * - Schemas are published on tools/list via zod-to-json-schema (JSON Schema
 *   2020-12, per SEP-2106 in the 2026-07-28 spec revision).
 */

/** Raw Alza upstream envelope — the shape every raw tool's response shares. */
export const ENVELOPE = z
  .object({
    /** 0 = ok; 1 = Alza-side validation failure (see msg); 113 = the documented gate retry; an HTML error-page string has been observed in one capture. */
    err: z.union([z.number(), z.string(), z.null()]).optional(),
    /** Alza-side validation message when err === 1; null on success. */
    msg: z.union([z.string(), z.null()]).optional(),
    /** Operation-specific payload — deliberately opaque (any JSON value). */
    data: z.unknown().optional(),
  })
  .passthrough()
  .describe(
    "Raw Alza envelope. err 0/1/113 (number; an HTML error-page string was observed once), msg string-or-null, data plus operation-specific top-level keys (e.g. basket, items, form).",
  );

/** `auth_discovery` result — the raw OIDC discovery document, not an envelope. */
export const AUTH_DISCOVERY = z
  .object({
    issuer: z.string().optional(),
    authorization_endpoint: z.string().optional(),
    token_endpoint: z.string().optional(),
    jwks_uri: z.string().optional(),
    grant_types_supported: z.array(z.string()).optional(),
    code_challenge_methods_supported: z.array(z.string()).optional(),
  })
  .passthrough()
  .describe("Raw OpenID Connect discovery document served by the Alza authority (issuer, authorization_endpoint, token_endpoint).");

/** `auth_start` result (OAuth start). */
export const AUTH_START = z
  .object({
    /** Full browser sign-in URL to open for the user. */
    authorizationUrl: z.string(),
    /** OAuth state to pass back to `auth_exchange`. */
    state: z.string(),
  })
  .passthrough();

/** `prepare_mutation` result — the one-time confirmation token binding. */
export const PREPARE_MUTATION = z
  .object({
    /** The exact mutation action the token is bound to. */
    action: z.string(),
    /** Single-use token; pass as confirmation_token on the matching tool. */
    confirmationToken: z.string(),
    /** When the token stops being accepted (ISO 8601; 5 minutes after issue). */
    expiresAt: z.string(),
    /** Whether the token is bound to the prepared payload (always true via the tool). */
    payloadBound: z.boolean(),
  })
  .passthrough();

/** `account_status` result — local process state, no network call. */
export const ACCOUNT_STATUS = z
  .object({
    /** Whether a mobile API access token is loaded in this process. */
    authenticated: z.boolean(),
    /** Alza visitor id (empty when unauthenticated). */
    visitorId: z.string(),
    /** Mobile API base URL in use. */
    apiBaseUrl: z.string(),
    /** Access-token expiry (ISO 8601), when known from the JWT `exp` or the token store. */
    expiresAt: z.string().optional(),
    /** True when the access token is expired (or within 60 s of it); the next account call refreshes it first. */
    expired: z.boolean().optional(),
  })
  .passthrough();

/** `checkout_preview` result (read-side of the mobile checkout). */
export const CHECKOUT_PREVIEW = z
  .object({
    /** Full cart envelope as served by basketInfo. */
    cart: z.unknown().optional(),
    /** Delivery/payment groups as served by getDeliveryPaymentGroups. */
    deliveryPaymentGroups: z.unknown().optional(),
    /** Checkout state (sendOrder1 response). */
    checkoutState: z.unknown().optional(),
    /** One-time token that `place_order` requires. */
    confirmationToken: z.string(),
  })
  .passthrough()
  .describe("Read-side checkout: cart + delivery/payment groups + checkout state, plus the one-time token place_order requires.");

/** `order_search` result (OR6, 2026-09-22) — the HATEOAS search response:
 * `orders[]` (with `documents[]` invoice refs) + `commodities[]`. */
export const ORDER_SEARCH = z
  .object({
    self: z.unknown().optional(),
    orders: z.array(z.record(z.string(), z.unknown())).optional(),
    commodities: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .passthrough()
  .describe("Order search results: matching orders (status, phase, price, documents[]) and commodities.");

/** `order_archive` result (OR7, 2026-09-24) — the HATEOAS archive section:
 * `value[]` orders (same shape as the search results) + `paging`. */
export const ORDER_ARCHIVE = z
  .object({
    self: z.unknown().optional(),
    paging: z.unknown().optional(),
    value: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .passthrough()
  .describe("Archived orders: `value[]` (status, phase, price, documents[]) with `paging` (use `paging.next` for the next page).");

/** `product_by_ean` result (AT3, 2026-09-24) — the EAN-lookup envelope:
 * `data` on a match, or `err:1` + `msg` (\"No products found.\") when no
 * catalog product carries the scanned code. */
export const PRODUCT_BY_EAN = z
  .object({
    /** The matching product data (present on a catalog hit). */
    data: z.unknown().nullable().optional(),
    /** Alza `BaseResponse` error flag (0 = ok, 1 = not found). */
    err: z.number().int().optional(),
    /** Alza `BaseResponse` message (e.g. "No products found."). */
    msg: z.string().nullable().optional(),
  })
  .passthrough()
  .describe("Barcode/EAN product lookup: matching product data, or err:1 'No products found.' for unknown codes.");

/** `gdpr_info` result (A17, 2026-09-22). */
export const GDPR_INFO = z
  .object({
    /** The `PersonalGdprDetails` section (`gdprInfoAction`, `deleteAccountAction`). */
    personalDetails: z.unknown().optional(),
    /** The `AccountGdprDialog` (`emailInfo`, `sendGdprInfoForm`), or an error object when the dialog read failed. */
    gdprDialog: z.unknown().optional(),
  })
  .passthrough()
  .describe("GDPR section + export dialog (where the data export will be sent).");

/** `order_document` result (OR10, 2026-09-22) — downloaded document content. */
export const ORDER_DOCUMENT = z
  .object({
    name: z.string().nullable().optional(),
    /** The validated server-provided href that was fetched. */
    href: z.string(),
    contentType: z.string().nullable(),
    byteLength: z.number().int(),
    /** UTF-8 body when the content is text-like (JSON/XML/text). */
    text: z.string().nullable().optional(),
    /** Base64 body for binary content (PDF and friends). */
    base64: z.string().nullable().optional(),
  })
  .passthrough()
  .describe("Downloaded order document: metadata plus text or base64 content (max 8 MiB).");

/** Account credential/identity mutation results (A14–A18, 2026-09-22). These tools
 * return the Alza upstream envelope on success, or a small confirmation object when
 * the upstream body is empty. */
export const ACCOUNT_MUTATION = z
  .object({
    /** Present when Alza returns the standard envelope (err/msg/data). */
    err: z.union([z.number(), z.string(), z.null()]).optional(),
    msg: z.union([z.string(), z.null()]).optional(),
    data: z.unknown().optional(),
    /** Confirmation keys emitted when the upstream body was empty. */
    changed: z.boolean().optional(),
    enabled: z.boolean().optional(),
    phone: z.string().optional(),
    email: z.string().optional(),
    deleted: z.boolean().optional(),
  })
  .passthrough()
  .describe("Account credential/identity mutation (A14–A18): the Alza envelope on success, or a confirmation flag when the upstream body is empty.");

/** `web_pickup_places` result (W11–W14 family). */
export const WEB_PICKUP_PLACES = z
  .object({
    /** Availability form (W11). */
    form: z.unknown().optional(),
    /** Paginated place list (W12). */
    places: z.unknown().optional(),
    /** Single-place detail (W14) — only when place_id was passed. */
    detail: z.unknown().optional(),
  })
  .passthrough();

/** `watchdog_list` result (B9a, 2026-10-06) — normalised, no account email. */
export const WATCHDOG_LIST = z
  .object({
    count: z.number(),
    has_more: z.boolean(),
    empty_message: z.union([z.string(), z.null()]),
    items: z.array(
      z
        .object({
          watchdog_id: z.union([z.string(), z.null()]),
          commodity_id: z.union([z.number(), z.null()]),
          name: z.union([z.string(), z.null()]),
          url: z.union([z.string(), z.null()]),
          current_price: z.union([z.number(), z.null()]),
          availability: z.union([z.string(), z.null()]),
          is_tracking_stock: z.union([z.boolean(), z.null()]),
          max_price: z.union([z.number(), z.null()]),
        })
        .passthrough(),
    ),
  })
  .passthrough()
  .describe("The account's Alza watchdogs (price-drop / back-in-stock alerts).");

/** `watchdog_set` result (B9, 2026-10-06). */
export const WATCHDOG_SET = z
  .object({
    created: z.boolean(),
    watchdog_id: z.union([z.string(), z.null()]),
    commodity_id: z.number(),
    is_tracking_stock: z.boolean(),
    max_price: z.union([z.number(), z.null()]),
    created_at: z.union([z.string(), z.null()]),
    notification: z.string(),
  })
  .passthrough();

/** `watchdog_delete` result (B9b, 2026-10-06). */
export const WATCHDOG_DELETE = z
  .object({
    deleted: z.boolean(),
    watchdog_id: z.string(),
    commodity_id: z.number().optional(),
  })
  .passthrough();

/* ---------------- Catalog domain shapes ---------------- */

const PRODUCT_PARAM = z
  .object({ name: z.string(), value: z.string() })
  .passthrough();

const PRODUCT = z
  .object({
    code: z.string(),
    id: z.number(),
    name: z.string(),
    url: z.string(),
    image: z.string().optional(),
    price: z.number().optional(),
    originalPrice: z.number().optional(),
    priceNow: z.number().optional(),
    promoCode: z.string().optional(),
    promoPercent: z.number().optional(),
    alzaPlusPrice: z.number().optional(),
    condition: z.enum(["opened", "used"]).optional(),
    newPrice: z.number().optional(),
    currency: z.string(),
    availability: z.string().optional(),
    availabilityText: z.string().optional(),
    jsonLdAvailability: z.string().optional(),
    rating: z.number().optional(),
    brand: z.string().optional(),
    category: z.string().optional(),
    params: z.array(PRODUCT_PARAM).optional(),
  })
  .passthrough()
  .describe("Scraped product detail (JSON-LD sourced; stable fields listed, rest passthrough).");

export const SEARCH_PRODUCTS_OUTPUT = z
  .object({
    query: z.string(),
    total: z.number(),
    page: z.number(),
    pageSize: z.number().describe("Cards per rendered Alza result page (the real page capacity), not the requested limit."),
    /** True when Alza renders more result pages beyond the last one scanned. */
    hasMore: z.boolean().optional(),
    /** The `page` value that continues after the last scanned page; present when `hasMore`. */
    nextPage: z.number().optional(),
    products: z.array(PRODUCT),
    /** Present when a client-side price/rating sort swept multiple pages. */
    candidatesScanned: z.number().optional(),
    /** Slider (range) filters Alza applied, snapped to real facet steps. */
    appliedRanges: z
      .array(
        z
          .object({
            paramId: z.number(),
            name: z.string().optional(),
            from: z.number().optional(),
            to: z.number().optional(),
            empty: z.boolean().optional(),
            fromScreenInches: z.boolean().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const DEAL = PRODUCT.extend({
  price: z.number(),
  originalPrice: z.number().optional(),
  savings: z.number().optional(),
  discountPercent: z.number(),
  priceNow: z.number(),
  priceList: z.number(),
  priceOriginal: z.number().nullable(),
  promoCode: z.string().nullable(),
  promoPercent: z.number().nullable(),
  badge: z.string().nullable(),
  monthlyFrom: z.number().nullable(),
  alzaPlusPrice: z.number().nullable(),
  nonMemberPrice: z.number().nullable(),
  condition: z.enum(["opened", "used"]).nullable(),
  newPrice: z.number().nullable(),
  priceCheck: z.object({ expected: z.number(), ok: z.boolean() }).nullable(),
  reviewCount: z.number().optional(),
});

export const GET_DEALS_OUTPUT = z
  .object({
    categoryIds: z.array(z.number()),
    url: z.string().optional(),
    candidatesScanned: z.number(),
    pagesScanned: z.number(),
    partial: z.boolean().optional(),
    total: z.number(),
    deals: z.array(DEAL),
    usedOffers: z.array(DEAL).optional(),
  })
  .passthrough();

export const GET_PRODUCT_OUTPUT = z
  .object({ product: PRODUCT })
  .passthrough();

export const RECOMMEND_ALTERNATIVES_OUTPUT = z
  .object({
    source: PRODUCT,
    mode: z.enum(["cheaper", "better-specs", "same-brand"]).optional(),
    poolSource: z.enum(["alza-alternatives", "category-search"]),
    candidatesConsidered: z.number(),
    alternatives: z.array(PRODUCT),
  })
  .passthrough();

export const COMPARE_PRODUCTS_OUTPUT = z
  .object({
    products: z.array(
      z
        .object({
          code: z.string(),
          ok: z.boolean(),
          name: z.string().optional(),
          url: z.string().optional(),
          error: z.string().optional(),
        })
        .passthrough(),
    ),
    rows: z.array(z.object({ name: z.string(), values: z.array(z.string().nullable()) }).passthrough()),
    /** Requested codes dropped as duplicates of an earlier one. */
    duplicatesIgnored: z.array(z.string()).optional(),
    summary: z
      .object({
        status: z.enum(["generated", "unavailable", "failed"]),
        text: z.string().optional(),
        model: z.string().optional(),
        reason: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const GET_PRODUCT_REVIEWS_OUTPUT = z
  .object({
    code: z.string(),
    ratingAverage: z.number().optional(),
    reviewCount: z.number().optional(),
    reviews: z.array(
      z
        .object({
          author: z.string().optional(),
          date: z.string().optional(),
          rating: z.number().optional(),
          body: z.string().optional(),
          pros: z.array(z.string()).optional(),
          cons: z.array(z.string()).optional(),
          verifiedPurchase: z.boolean().optional(),
          variant: z.string().optional(),
          helpfulCount: z.number().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export const AUTOCOMPLETE_OUTPUT = z
  .object({
    query: z.string(),
    suggestions: z.array(z.string()),
    categories: z.array(z.object({ id: z.number(), name: z.string(), url: z.string() }).passthrough()),
    products: z.array(
      z.object({ id: z.number(), code: z.string().optional(), name: z.string(), url: z.string(), image: z.string().optional() }).passthrough(),
    ),
    brands: z.array(z.object({ id: z.number(), name: z.string(), url: z.string() }).passthrough()),
    articles: z.array(z.object({ name: z.string(), url: z.string() }).passthrough()),
  })
  .passthrough();

export const LIST_CATEGORIES_OUTPUT = z
  .object({
    categories: z.array(
      z
        .object({
          id: z.number(),
          name: z.string(),
          url: z.string().optional(),
          parentId: z.number().optional(),
          childCount: z.number().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export const FIND_PICKUP_POINTS_OUTPUT = z
  .object({
    points: z.array(
      z
        .object({
          type: z.union([z.literal("alzabox"), z.literal("branch")]),
          id: z.string(),
          name: z.string(),
          address: z.string(),
          city: z.string(),
          postalCode: z.string().optional(),
          latitude: z.number().optional(),
          longitude: z.number().optional(),
          distanceKm: z.number().optional(),
          openingHours: z.string().optional(),
          note: z.string().optional(),
          parcelShopId: z.number().optional(),
          deliveryId: z.number().optional(),
        })
        .passthrough(),
    ),
    warnings: z.array(z.string()).optional(),
  })
  .passthrough();

export const LIST_CATEGORY_FILTERS_OUTPUT = z
  .object({
    category_id: z.number(),
    brands: z.array(z.object({ valueId: z.number(), description: z.string(), count: z.number().optional() }).passthrough()),
    groups: z.array(
      z
        .object({
          paramId: z.number(),
          name: z.string(),
          renderType: z.string(),
          filterable: z.boolean(),
          filterMode: z.enum(["value", "range"]).optional(),
          values: z.array(
            z
              .object({
                valueId: z.number(),
                description: z.string(),
                count: z.number().optional(),
                value: z.number().optional(),
              })
              .passthrough(),
          ),
        })
        .passthrough(),
    ),
  })
  .passthrough();

/** `pc_build_check` / `pc_build_suggest` result (issue #15, 2026-10-06). */
const SPEC_VALUE = z.object({ value: z.unknown(), source: z.string(), raw: z.string() }).passthrough();
export const PC_BUILD_OUTPUT = z
  .object({
    parts: z.array(
      z
        .object({
          role: z.string(),
          code: z.string(),
          name: z.string(),
          url: z.string(),
          price: z.number().optional(),
          currency: z.string(),
          availability: z.string().optional(),
          inStock: z.boolean().nullable(),
          /** Normalised specs, each with the Czech spec row it came from. */
          specs: z.record(z.string(), SPEC_VALUE),
          specsFetched: z.boolean(),
          origin: z.enum(["fixed", "suggested"]).optional(),
        })
        .passthrough(),
    ),
    total: z.number(),
    currency: z.string(),
    unpriced: z.array(z.string()),
    totalIncomplete: z.boolean().describe("true when total leaves out unpriced parts"),
    missingRoles: z.array(z.string()).describe("Required roles (cpu, motherboard, ram, psu, case) the build lacks"),
    verdicts: z.array(
      z
        .object({
          rule: z.string(),
          title: z.string(),
          verdict: z.enum(["pass", "warn", "fail", "unknown", "not_applicable"]),
          detail: z.string(),
          values: z.record(z.string(), z.unknown()),
        })
        .passthrough(),
    ),
    overall: z.enum(["compatible", "incompatible", "needs_review", "no_conflicts_found"]),
    powerEstimate: z.record(z.string(), z.unknown()).optional(),
    notes: z.array(z.string()),
    detailFetches: z.number().int(),
    categoryPages: z.number().int(),
    budget: z.number().optional(),
    withinBudget: z.boolean().optional(),
    profile: z.string().optional(),
    allocation: z.record(z.string(), z.number()).optional(),
  })
  .passthrough()
  .describe("PC build: parts with live price/stock and normalised specs, total, one verdict per compatibility rule with the values compared, power estimate, notes.");

/** Map tool name → its output schema. Kept in one place so the registration
 * contract test can assert coverage per tool. */
export const OUTPUT_SCHEMAS: Record<string, z.AnyZodObject> = {
  // Catalog (typed domain shapes)
  search_products: SEARCH_PRODUCTS_OUTPUT,
  get_product: GET_PRODUCT_OUTPUT,
  compare_products: COMPARE_PRODUCTS_OUTPUT,
  get_product_reviews: GET_PRODUCT_REVIEWS_OUTPUT,
  recommend_alternatives: RECOMMEND_ALTERNATIVES_OUTPUT,
  list_categories: LIST_CATEGORIES_OUTPUT,
  autocomplete: AUTOCOMPLETE_OUTPUT,
  find_pickup_points: FIND_PICKUP_POINTS_OUTPUT,
  list_category_filters: LIST_CATEGORY_FILTERS_OUTPUT,
  get_deals: GET_DEALS_OUTPUT,
  // Account (typed)
  auth_start: AUTH_START,
  prepare_mutation: PREPARE_MUTATION,
  account_status: ACCOUNT_STATUS,
  checkout_preview: CHECKOUT_PREVIEW,
  web_pickup_places: WEB_PICKUP_PLACES,
  // Account (raw envelope)
  auth_discovery: AUTH_DISCOVERY,
  auth_exchange: ENVELOPE,
  mobile_read: ENVELOPE,
  mutate_list: ENVELOPE,
  cart: ENVELOPE,
  add_to_cart: ENVELOPE,
  delivery_options: ENVELOPE,
  select_pickup_point: ENVELOPE,
  place_order: ENVELOPE,
  web_add_to_cart: ENVELOPE,
  chat_navigation: ENVELOPE,
  chat_send: ENVELOPE,
  web_cart: ENVELOPE,
  profile: ENVELOPE,
  contacts: ENVELOPE,
  register: ENVELOPE,
  address_upsert: ENVELOPE,
  address_delete: ENVELOPE,
  address_search: ENVELOPE,
  payment_methods: ENVELOPE,
  after_order_payments: ENVELOPE,
  pay_after_order: ENVELOPE,
  order: ENVELOPE,
  review_submit: ENVELOPE,
  complaint_claims: ENVELOPE,
  subscription_overview: ENVELOPE,
  subscription_activate: ENVELOPE,
  subscription_update_installment: ENVELOPE,
  web_place_order: ENVELOPE,
  cancel_order: ENVELOPE,
  web_pay_after_order: ENVELOPE,
  upload_attachment: ENVELOPE,
  // Read-side dynamic-action wrappers (2026-09-22, task-5)
  order_search: ORDER_SEARCH,
  order_archive: ORDER_ARCHIVE,
  product_by_ean: PRODUCT_BY_EAN,
  gdpr_info: GDPR_INFO,
  claim_detail: ENVELOPE,
  order_document: ORDER_DOCUMENT,
  // account credential/identity mutations (2026-09-22, task-6)
  change_password: ACCOUNT_MUTATION,
  two_factor_set: ACCOUNT_MUTATION,
  phone_change: ACCOUNT_MUTATION,
  email_change: ACCOUNT_MUTATION,
  delete_account: ACCOUNT_MUTATION,
  // native price/stock watchdog (2026-10-06, issue #17)
  watchdog_list: WATCHDOG_LIST,
  watchdog_set: WATCHDOG_SET,
  watchdog_delete: WATCHDOG_DELETE,
  // PC builder (issue #15, 2026-10-06)
  pc_build_check: PC_BUILD_OUTPUT,
  pc_build_suggest: PC_BUILD_OUTPUT,
};
