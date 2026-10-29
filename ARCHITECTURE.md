# Architecture

This is a deeper companion to the [README](README.md) — written for contributors who want to understand *why* the code looks the way it does.

## The core problem

Alza.cz has no public consumer API. There are three official surfaces — Alza Trade (B2B marketplace, OAuth-gated), AlzaBox (parcel-locker logistics, OpenAPI'd), and the affiliate program (links/creatives only) — none of which lets a third party query the catalog or act on a shopper's account.

The Android app's REST endpoints (`/Services/RestService.svc/`, `/api/`, on `www`, `webapi` and `identity`) are the de-facto data plane. Route names and DTOs are recovered from the decompiled APK and recorded in [docs/mobile-endpoint-coverage.md](docs/mobile-endpoint-coverage.md). Alza protects every surface with **Cloudflare Bot Management**: a plain Node `fetch` gets a `403` managed challenge.

Approaches we considered:

| Approach | Verdict |
|---|---|
| **HTTP + okhttp UA + `__cf_bm`/`VST` cookie handshake** (the [topmonks/hlidac-shopu](https://github.com/topmonks/hlidac-shopu/tree/trunk/actors/alza) recipe) | Works **only** through Apify's residential proxy network. Direct calls fail. Not viable for a free `npx` install. |
| **External CF-bypass services** (FlareSolverr, ZenRows) | Either a Docker dependency or a paid SaaS. Neither fits the "community OSS, one-line install" goal. |
| **Real browser via Playwright** | **Shipped** for catalog pages. Cloudflare lets a real browser through; we just *are* one. Costs a ~92 MB Chromium download and a few seconds per call. |
| **Chrome TLS/HTTP2 fingerprint** (`curl_cffi`) | **Shipped** for the account/checkout API. Verified 2026-09-15 against `www`, `webapi` and `identity`, authenticated calls included. Runs as an optional Python sidecar (`scripts/cf-transport.py`). |

So there are two transports, chosen per surface:

- **Catalog** (search, product pages, categories, deals): Playwright Chromium, or the user's own Chrome via `ALZA_CDP_URL`.
- **Mobile API** (auth, cart, checkout, orders, account, reviews API, watchdogs): the `curl_cffi` sidecar first. If the sidecar is missing or never sent the request, it falls back to plain fetch and, for same-origin calls, an in-page fetch in the browser. A request that changes something is never re-sent after the sidecar may already have sent it; the tool reports an unknown outcome (`OutcomeUnknownError`) instead of risking a double order or payment.

`ALZA_PROXY_URL` routes both transports through an HTTP(S) or SOCKS5 proxy. While it is set, the mobile API never falls back to an un-proxied connection.

## Module map

```
src/
  index.ts               entrypoint: stdio (default) or --http, --setup-cf, signal handling
  cli.ts                 command-line flags and usage text
  http.ts                Streamable HTTP transport — one McpServer per session, account toolsets locked unless opted in
  server.ts              buildServer() — wires deps, registers tools/resources/prompts, wraps errors
  infra/
    browser.ts           Playwright facade — lazy launch, page pool, idle shutdown, CDP attach
    impersonate-transport.ts  Node client for the curl_cffi Chrome-fingerprint sidecar
    mobile-api.ts        APK-derived REST client: OAuth PKCE, token refresh, transport fallback chain
    app-action.ts        AppActionExecutor — runs server-provided hypermedia actions under route policies
    proxy.ts             ALZA_PROXY_URL parsing and validation
    setup-cf.ts          --setup-cf: cross-platform curl_cffi venv setup
    locale.ts            storefront base URL → Accept-Language + currency mapping
    jsonld.ts            schema.org parser (Product, Offer, Review, AggregateRating)
    cache.ts             tiny LRU + TTL with async memoize()
    deadline.ts          time budgets so multi-page tools return before the host's ~60 s timeout
    initialize-guard.ts  rejects requests sent before the MCP initialize handshake
    issue-report.ts      drafts redacted GitHub issues for report_issue
    errors.ts            typed errors (see Errors)
    logger.ts            stderr-only structured JSON logging
  domain/
    catalog.ts           search (incl. range filters), getProduct, categories, facets, deal pages
    reviews.ts           aggregate rating from JSON-LD + individual reviews from the mobile reviews API
    pickup.ts            AlzaBox lockers (public salesNetwork API) + showrooms, Nominatim geocoding
    autocomplete.ts      search suggestions (whisper endpoint)
    alternatives.ts      recommend_alternatives candidate pool and ranking
    deals.ts             sale detection from listing cards
    availability.ts      one availability vocabulary for every tool
    watchdog.ts          Alza's native price/stock watchdog
    pc-build.ts          PC builder: spec normalisation and compatibility rules (pure)
    pc-build-service.ts  PC builder orchestration over live products
    mobile-account.ts    cart, checkout, orders, payments, account — and the one-time mutation tokens
    types.ts             shared domain types
  data/branches.ts       curated AlzaShop showroom dataset
  tools/                 MCP surface — mostly one file per tool, plus:
    toolsets.ts          progressive disclosure: groups every tool into exactly one toolset
    allowlist.ts         ALZA_TOOLS_ALLOW / ALZA_MUTATION_ACTIONS_ALLOW operator allowlists
    account.ts, advanced.ts  the account / checkout / order tools
    output-schemas.ts    per-tool outputSchema
    tracking.ts          UTM attribution on storefront links
  resources/             alza://product/{code} resource
  prompts/               /find-product prompt template
```

`infra/` knows about HTTP, cookies, browsers and transports. `domain/` orchestrates business operations. `tools/` is the MCP surface — every tool delegates to `domain/`. The boundary keeps test friction down: domain modules are exercised against fixtures and fakes in `test/`; the live catalog path is exercised by `npm run validate:api`.

## Tool design

Every tool returns:

1. `structuredContent` — typed JSON for the agent, validated against the tool's `outputSchema` (`src/tools/output-schemas.ts`).
2. `content[].text` — Markdown summary for the chat UI. This is what the human reading the conversation sees.

Every Zod field has `.describe()` — that text is what the model reads when deciding *whether and how* to call the tool. Vague descriptions = bad tool calls.

Annotations follow what the tool does: read tools carry `readOnlyHint: true`, ID-resolved reads also `idempotentHint: true`. Writes carry `readOnlyHint: false`, and anything irreversible or money-relevant (order placement, payment, cancellation, credential changes, account deletion) carries `destructiveHint: true`.

### Progressive disclosure

The server has 63 domain tools plus three always-visible meta tools (`list_toolsets`, `set_toolset`, `report_issue`). Listing all of them on every `tools/list` would fill an agent's context, so `src/tools/toolsets.ts` groups them into ten toolsets. Only `catalog` and `auth` start enabled; the rest are turned on with `set_toolset`, which fires `notifications/tools/list_changed`. Startup fails if a tool is in no toolset or in two.

### Guarded mutations

Every write needs a single-use token from `prepare_mutation` (the order flow uses the token from `checkout_preview`). The token is bound to one action (and, when `prepare_mutation` is given the payload, to that exact payload), expires after five minutes, and is consumed before any request is sent, so concurrent calls with one token run at most once. This guards against accidental or injected calls; it is not user consent — the MCP client should still ask the user.

Server-driven actions (`AppAction` hrefs returned by Alza) run only through `AppActionExecutor`: same-origin HTTPS, a path allowlist, a per-tool route family and method, a denylist of credential/payment/order routes, and a sensitive-field blocklist. No tool accepts an arbitrary URL. Details are in [SECURITY.md](SECURITY.md) and [docs/mobile-endpoint-coverage.md](docs/mobile-endpoint-coverage.md).

### Transports and deployment modes

- **stdio** (default): one user, all toolsets available.
- **Streamable HTTP** (`--http`): one `McpServer`, `MobileApi` and token state per session. Only `catalog` and `pc_builder` are usable unless the operator sets `ALZA_HTTP_ENABLE_ACCOUNT=1`. Binds to `127.0.0.1` and validates `Host`/`Origin`.
- **Allowlists**: `ALZA_TOOLS_ALLOW` and `ALZA_MUTATION_ACTIONS_ALLOW` cut the surface down for an agent you do not fully trust.

## Caching

Per-process LRU + TTL (`src/infra/cache.ts`), no external dependencies:

| Cache | TTL | Why |
|---|---|---|
| Search results | 60 s | Same query a few seconds apart usually wants the same answer |
| Product detail, reviews | 15 min | Prices and availability shift, but rarely within a user session |
| Product code → URL | 1 h | Lets `get_product` skip the search step on warm calls |
| Category facets, category existence | 1 h | Filters change rarely |
| Category tree | 24 h | Top-level categories are stable for years |
| Autocomplete, deals, deal pages | 5 min | Fast-moving; keeps repeated calls cheap |
| AlzaBox lockers / opening hours | 12 h / 1 h | Locker network is stable; hours change by day |

Account, cart and order data are never cached.

## Data hydration strategy

Search uses **DOM scraping** — `.browsingitem` cards on the search HTML page have stable `data-code`/`data-id` attributes plus reliably-classed inner anchors and price text. 24 cards per page; we strip sponsored items.

Product detail uses **JSON-LD** — every product page embeds a `Product` schema for SEO with `name`, `sku`, `brand`, `offers.{price, priceCurrency, availability}`, `aggregateRating.{ratingValue, reviewCount}`, and `image[]`. SEO data is more stable than DOM markup; Alza won't break Google rich snippets without a strong reason. Spec params come from the page DOM.

Reviews take the aggregate from JSON-LD and individual review bodies from the mobile reviews API; if that API fails, the tool returns the aggregate only.

Categories use a stable selector pattern (`li[class*="category-naviga"] a`) on the homepage MUI navigation list.

## Errors

`src/infra/errors.ts` defines typed errors on top of `AlzaError`: `NotFoundError`, `UpstreamError`, `CloudflareChallengeError`, `HandshakeError`, `ConfigurationError`, `AuthenticationError`, `AlzaRejectedError`, `UserError`, and `OutcomeUnknownError` (a write may have reached Alza but its result is unknown — don't retry blindly). The wrapper in `server.ts` converts everything to `{ isError: true, content: [...] }` so the agent sees a clean message instead of a crash. We never let the server die — a flaky endpoint should not take down the whole MCP.

## Resilience

Two things will inevitably break: Alza redesigning its pages or API, and Cloudflare tightening rules.

For **drift**, `npm run validate:api` runs every read-only catalog tool against live Alza and exits non-zero if any returns nothing or throws (exit 2 means Cloudflare challenged the machine). It also runs daily as the live canary (`.github/workflows/live-canary.yml`). Account and checkout tools are not covered, since they act on real accounts; their live evidence is under `docs/live-evidence/`.

For **bot-protection escalation**, the levers in place are the `curl_cffi` sidecar, `ALZA_PROXY_URL` (for example a residential proxy), and `ALZA_CDP_URL` to use the user's own Chrome. Datacenter IPs are challenged far more often; see [docs/gap-analysis.md](docs/gap-analysis.md).

## Anti-features

Things we deliberately don't do:

- **No arbitrary-URL or arbitrary-route tools.** Only fixed, APK-confirmed operations and origin-validated server-provided actions. `mobile_read` (the opt-in `advanced_raw` toolset) is read-only.
- **No unguarded writes.** Every mutation needs a one-time token; administrative, telemetry, device-token and external payment hand-off routes stay `blocked`.
- **No background scraping or pre-fetching.** Every tool call corresponds to a user request.
- **No analytics / telemetry.** Logs go to stderr only, as structured JSON (`ALZA_LOG_LEVEL`, or `ALZA_DEBUG=true` for debug). The only addition to outgoing data is UTM attribution on storefront links shown to the user, at Alza's request (`src/tools/tracking.ts`).
- **No bundled proxy lists.** If you need a proxy, set `ALZA_PROXY_URL` yourself.
- **No runtime package installs.** The `curl_cffi` venv is set up by postinstall or `--setup-cf`, never by the running server.
