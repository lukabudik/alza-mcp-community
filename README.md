# alza-mcp-community

> Let your AI agent shop on **[Alza.cz](https://www.alza.cz)** — Central Europe's largest e-commerce store.

**Unofficial, community-built project. Not made, endorsed or supported by Alza.cz a.s.**

[![npm version](https://img.shields.io/npm/v/alza-mcp-community.svg)](https://www.npmjs.com/package/alza-mcp-community)
[![CI](https://github.com/lukabudik/alza-mcp-community/actions/workflows/ci.yml/badge.svg)](https://github.com/lukabudik/alza-mcp-community/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/-TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Playwright](https://img.shields.io/badge/-Playwright-2EAD33?logo=playwright&logoColor=white)](https://playwright.dev/)
[![MCP](https://img.shields.io/badge/-Model%20Context%20Protocol-7C3AED)](https://modelcontextprotocol.io)

`alza-mcp-community` is an unofficial **Model Context Protocol** server that gives Claude (or any MCP-aware agent) an interface to Alza through browser-based catalog scraping and reverse-engineered mobile/web APIs: search products, pull full detail, read reviews, use anonymous/account data, manage a cart, select delivery/AlzaBox pickup, preview checkout, and submit an order only with an explicit one-time confirmation token.

<p align="center"><img src="docs/demo.gif" alt="Animated recording of a real Claude Code session: search_products finds wheel cleaners under 600 Kč, get_product shows price and stock, find_pickup_points lists Prague showrooms" width="780"></p>

<p align="center"><sub>Real session, catalog toolset only, no account. Re-record: <a href="docs/demo-recording.md">docs/demo-recording.md</a>. Static version: <a href="docs/demo.svg">docs/demo.svg</a>.</sub></p>

Ask: *"Find me the best pro-grade wheel cleaner under 600 Kč and tell me where I can pick it up in Prague."* The agent calls `search_products` → `get_product` → `find_pickup_points` and gives you a real answer with real prices and a real address.

> [!IMPORTANT]
> This project is **unofficial** — not affiliated with, endorsed by, or sponsored by Alza.cz a.s. It's a community wrapper for personal/research use. Read the [disclaimer](#disclaimer) before deploying or sharing widely.

---

## Quick install

> [!NOTE]
> **Renamed from `alza-mcp`.** At Alza's request, the project is now `alza-mcp-community`, so it's clear it isn't an official Alza product. If you installed the old package, replace `alza-mcp` with `alza-mcp-community` in your MCP config. Your saved login in `~/.alza-mcp/` keeps working.

### One-click install

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=alza&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImFsemEtbWNwLWNvbW11bml0eSJdfQ==)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_alza--mcp--community-0098FF?logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=alza&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22alza-mcp-community%22%5D%7D)

Both buttons install the same thing as the manual config below: `npx -y alza-mcp-community`, no environment variables, no secrets. With `npx`/`npm`, install runs a postinstall step that downloads Playwright's headless Chromium (~92 MB) and sets up the optional `curl_cffi` venv, so the first install takes a while and later starts take a few seconds. The `.mcpb` bundle and `--ignore-scripts` installs skip postinstall: Chromium is then downloaded on the first browser-backed call (~30 s) and the venv is not created (see [Install paths](#install-paths-and-the-curl_cffi-venv)). For Claude Desktop, download the one-click `alza-mcp-community-<version>.mcpb` bundle from the [latest release](https://github.com/lukabudik/alza-mcp-community/releases/latest) and open it, or use the JSON config below.

### Claude Code

```bash
claude mcp add alza --scope user -- npx -y alza-mcp-community
```

That's it. Restart Claude Code, type `/mcp` to confirm, and start asking. The install downloads Playwright's headless Chromium browser (~92 MB) via postinstall; if that was skipped, the first browser-backed call downloads it (~30 s).

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "alza": {
      "command": "npx",
      "args": ["-y", "alza-mcp-community"]
    }
  }
}
```

Restart the app. Same install-time download.

### Cursor / Continue / any MCP client

Same shape — `command: "npx"`, `args: ["-y", "alza-mcp-community"]`. Stdio transport, standard MCP everywhere.

---

## What you can ask

A real session captured during testing:

> **You:** Find me the best pro-grade wheel cleaner on Alza, around 500 Kč. I want a detailer-tier brand.
>
> **Claude:** *(calls `search_products` "čistič disků kol" sort=rating, then `get_product` on the top picks)*
>
> Top three from the live catalog:
>
> | # | Product | Brand | Volume | Price | ★ |
> |---|---|---|---:|---:|---:|
> | 1 | Sonax Xtreme Full Effect | Sonax 🇩🇪 | 750 ml | 559 Kč | 4.8 |
> | 2 | Kenotek Wheel Cleaner Ultra | Kenotek 🇧🇪 | 1 L | 455 Kč | 4.8 |
> | 3 | Auto Finesse Reactive 1L | Auto Finesse 🇬🇧 | 1 L | 599 Kč | 4.4 |
>
> Pick: **Sonax Xtreme Full Effect 750 ml** — the de-facto detailer recommendation. It's iron-fallout reactive (turns purple on contact with brake-dust particles so you can watch it work), Sonax is a German workshop standard, and it's in stock.

That's the agent calling four MCP tools across two parallel searches and synthesizing real Alza data. No hallucinated SKUs.

---

## What it does

With 63 domain tools (66 including `list_toolsets`, `set_toolset` and `report_issue`), listing every tool on every `tools/list` call would front-load an agent's context with dozens of tools it may never touch in a given conversation. So they're grouped into **toolsets**, and only two are enabled by default, exposing 15 domain tools plus the two toolset controls and `report_issue`:

| Toolset | Enabled by default? | Covers |
|---|---|---|
| `catalog` | ✅ | Search, product detail, side-by-side comparison, reviews, categories, pickup-point lookup |
| `auth` | ✅ | OAuth handshake, account status, the mutation-token issuer |
| `basket_and_checkout` | — | Cart, delivery/pickup selection, checkout, order placement & cancellation |
| `account_management` | — | Profile, contacts, addresses, registration, credential/identity changes |
| `orders_and_payments` | — | Order history, payment methods, after-order payments, claims, documents |
| `reviews_and_subscriptions` | — | Reviews, complaints, AlzaSubscription, attachments, EAN lookup |
| `watchdogs` | — | Alza's native price-drop / back-in-stock watchdog (list, set, delete) |
| `chat` | — | Alza's in-app chatbot |
| `pc_builder` | — | Compatibility-checked PC parts lists: `pc_build_check`, `pc_build_suggest` |
| `advanced_raw` | — | `mobile_read`, the untyped escape hatch |

Call **`list_toolsets`** to see every group and **`set_toolset({id, enabled: true})`** to turn one on before using its tools — e.g. enable `basket_and_checkout` before adding something to a cart. This is standard MCP progressive disclosure (`RegisteredTool.enable()`/`.disable()`, which fires the normal `tools/list_changed` notification) — no functionality is removed, it's just not all visible at once.

**Reporting problems.** `report_issue` is always available, whichever toolsets are on. When a tool fails unexpectedly, returns clearly wrong data, or breaks because Alza changed something, the server instructions and the error message itself point the agent to it. It returns a redacted draft (with version, Node, platform, storefront, transport and this session's recent tool errors), a `gh issue list` command to check for duplicates, a ready-to-run `gh issue create --repo lukabudik/alza-mcp-community …` command, and a prefilled new-issue link for agents without a shell. The server files nothing itself: the agent shows the draft to you and files it from your GitHub account only if you agree. Credentials (including cookies and API keys), e-mails, phone numbers, UUIDs, URL query values, account ids and home-directory paths are redacted automatically, and recent errors keep only route and status. Invalid arguments and unknown products don't trigger the hint.

Catalog tools:

| Tool | Purpose |
|---|---|
| **`search_products`** | Keyword search, price/stock/screen-size filters, and bounded client-side sorting (price filters and sorts apply to the top ~72 ranked candidates, `pageSize` is the real cards-per-page, `hasMore`/`nextPage` page on; an inverted price range or a blank query is rejected); brand/attribute filters use category pages and ignore `query` |
| **`get_product`** | Full detail for one product — price, availability, brand, image, URL |
| **`compare_products`** | 2–6 products side by side — one aligned table of price, availability, rating and every spec row; optional `summarize: true` verdict via MCP sampling when the client supports it |
| **`get_product_reviews`** | Aggregate rating + review count + individual reviews (author, date, rating, body, pros/cons) via the reviews API, newest first; the list may be longer than the aggregate count (it appears to include other storefronts' reviews) |
| **`recommend_alternatives`** | Cheaper / better-rated / same-brand alternatives to a product (Alza's own alternatives list, same-category search fallback) |
| **`find_pickup_points`** | Nearest AlzaBox lockers and AlzaShop showrooms by 5-digit postal code, merged by distance, with opening hours, no cart needed. The postal code is geocoded with the public OpenStreetMap Nominatim service (`nominatim.openstreetmap.org`), so the normalised code and country are sent to that third party (not to Alza); results are cached for a week. It can't tell whether a specific product fits an AlzaBox; use `delivery_options` for that |
| **`list_category_filters`** | Category brands (`brands[].valueId`) and attribute facets with live ids/counts — use `producer_ids` or `filters` with `category_id` (`{param_id, value_id}` for checkbox facets, `{param_id, min?, max?}` for slider ranges such as screen size or refresh rate); unsupported URL filters return an error (checkbox values work only where Alza publishes a landing page for the value — HDMI does, monitor panel type and resolution do not) |
| **`get_deals`** | Discounted products (alza.cz only) with current/original price and discount % computed from observed prices — scans category listing pages for a `category_id`, or popular categories when omitted |
| **`list_categories`** | Top-level categories, or real subcategories when `parent_id` is supplied — feed the returned ids into `search_products` |
| **`autocomplete`** | Search-box suggestions over plain HTTP (no page render): phrases, categories, brands and products with ids/codes — refine a messy Czech query before `search_products` |
| **`product_by_ean`** | Looks up catalog products by barcode/EAN (the app's camera barcode-scan API, AT3; read-only, no account required; enable `reviews_and_subscriptions`) |

PC builder tools (enable `pc_builder`):

| Tool | Purpose |
|---|---|
| **`pc_build_check`** | Checks a parts list (Alza codes). Checks socket, RAM generation/slots, PSU wattage + headroom, GPU length and cooler height/radiator vs case, form factors, and display output. Returns prices, total, stock, and one verdict per rule with the spec values used |
| **`pc_build_suggest`** | Proposes a compatible build within a CZK budget from Alza's real component categories (gaming / workstation / office, pinned `fixed_parts`, bounded detail fetches) |

Account and checkout tools:

| Tool | Purpose |
|---|---|
| **`auth_start`** | Creates a mobile-API OAuth PKCE authorization URL |
| **`auth_exchange`** | Exchanges the returned authorization code for mobile-API tokens |
| **`auth_discovery`** | Reads live OIDC metadata from `identity.alza.cz` |
| **`mobile_read`** | Reads fixed APK-confirmed catalog, navigation, account, order-history, list, branch, alternative-product, basket, cost-estimate, web after-payment-dialog, web zip-code (WCF `GetZipCodes` twin), and chatbot-navigation capabilities |
| **`prepare_mutation`** | Creates a one-time token for a fixed, source-confirmed mutation without sending a request; the token is bound to the action and the exact call arguments (`payload`) and expires after 5 minutes |
| **`mutate_list`** | Executes a validated APK-confirmed low-risk mutation (lists, coupons, basket, country/ISIC, gift, watchdog, feedback, discussion) with that token |
| **`account_status`** | Checks whether a mobile API access token is loaded |
| **`cart`** | Reads the current cart and total |
| **`add_to_cart`** | Adds a product by Alza code |
| **`delivery_options`** | Reads delivery + AlzaBox/pickup options from the APK `getDeliveryPaymentGroups` endpoint |
| **`select_pickup_point`** | Despite the name, returns the delivery → payment associations from `getDeliveryAssociations` (which payments fit a delivery, and the delivery fee under each). It does not pick a pickup point: re-tested on an authenticated cart on 2026-10-06. To choose an AlzaBox, use `web_pickup_places` → `web_place_order` with `parcel_shop_id`. |
| **`checkout_preview`** | Previews checkout and returns a one-time confirmation token |
| **`cancel_order`** | Cancels an order part using its cancel form, a reason, and a one-time `prepare_mutation` token |
| **`place_order`** | Runs the mobile API order sequence only when supplied the preview token and required API payloads |
| **`web_pickup_places`** | Reads the live web pickup family (AlzaBox/branches/24-7 availability, place list, place detail) for web-checkout delivery selection (read-only) |
| **`web_add_to_cart`** | Adds a product to the live web HATEOAS basket (`basket/v1/items`, visitor-keyed) and returns the extracted basket id |
| **`web_cart`** | Reads the live web checkout cart state + item list for a basket id from `web_add_to_cart` (read-only) |
| **`chat_navigation`** | Reads the live chatbot HATEOAS navigation (`chatbotapi.alza.cz`, server-provided chat actions; read-only) |
| **`chat_send`** | Opens/continues a chatbot session with page context (session-scoped, visitor-keyed; returns `{configuration, showChat}`) |

User-management, payments, orders, and post-purchase tools:

| Tool | Purpose |
|---|---|
| **`profile`** | Reads the authenticated profile + address book (APK `getUserData`) |
| **`contacts`** | Reads the account contact list |
| **`register`** | Registers a new Alza account (credential-bearing, one-time token) |
| **`address_upsert`** | Creates/edits a delivery address through the server-provided address form |
| **`address_delete`** | Deletes a delivery address via its per-address action |
| **`address_search`** | Zip/city search via the verified `getZipCodes` lookup, or a profile `addressSearchAction` if one is supplied (read-only) |
| **`payment_methods`** | Lists payment methods from the APK delivery-payment-group endpoint |
| **`after_order_payments`** | Lists after-order payment options for an order part |
| **`pay_after_order`** | Executes an after-order payment (APK `AfterOrderRequestBody`, one-time token) |
| **`web_place_order`** | Places an order through the live-verified legacy web WCF pipeline (SaveOrder2→3, 113-gate retry, CheckOrder4, SendOrder4; one-time token) — the working submission path while mobile `sendOrder3` 500s |
| **`web_pay_after_order`** | Executes a web after-order payment through the live-verified WCF `CreateAfterPayment` (one-time token) |
| **`order`** | Reads a user order by numeric `user_id` + `order_id` (+ optional part detail, milestones, invoice refs) |
| **`review_submit`** | Submits a product review through the server-provided review form |
| **`complaint_claims`** | Lists active or archived warranty claims by `user_id` (K1; read-only) |
| **`subscription_overview`** | Reads the account's subscription section (the navigation's `userSubscription` link) by `user_id` (S1; response shape not yet live-verified) |
| **`subscription_activate`** | Activates AlzaSubscription (one-time token) |
| **`subscription_update_installment`** | Changes the installment plan (one-time token) |
| **`upload_attachment`** | Uploads image attachments via the multipart server-provided action (one-time token) |
| **`order_search`** | Searches the account's orders by term (OR6; read-only) |
| **`order_archive`** | Reads the account's archived orders (OR7; read-only; the "Skrýt zrušené" include/hide-cancelled toggle) |
| **`order_document`** | Downloads an order invoice/document from its server-provided href (OR10; origin-validated to the Alza host family; the body is returned in `structuredContent` only) |
| **`gdpr_info`** | Reads the GDPR section + export dialog (A17; read-only — where the data export will be sent) |
| **`claim_detail`** | Reads one warranty claim's detail from its `detailAction` link (K2; read-only; pinned to the warranty-claims routes) |
| **`change_password`** | Changes the account password (A14; one-time token; logs the user out of every device) |
| **`two_factor_set`** | Enables/disables SMS two-factor (A15; one-time token) |
| **`phone_change`** | Changes the contact phone number (A16; one-time token) |
| **`email_change`** | Changes the contact email (A16 sibling; one-time token) |
| **`delete_account`** | Deletes the account (A18; one-time token; **irreversible — disposable accounts only**) |
| **`watchdog_list`** | Lists the account's Alza watchdogs: price-drop and back-in-stock alerts (B9a; read-only; no email in the output) |
| **`watchdog_set`** | Sets a watchdog on a product (`max_price` and/or `track_stock`). Alza emails the account when the condition is met (B9; one-time token) |
| **`watchdog_delete`** | Deletes a watchdog by `watchdog_id` or `commodity_id` (B9b; one-time token) |

High-impact mutations require one-time confirmation tokens (`checkout_preview` for mobile `place_order`, `prepare_mutation` for the other guarded mutations); the full route inventory, exposure decisions, and verification labels live in [docs/mobile-endpoint-coverage.md](docs/mobile-endpoint-coverage.md).

OAuth sign-in happens outside the MCP; `auth_exchange` exchanges the returned code and the server holds access/refresh tokens in memory or loads them from the configured token file. An access token that is expired (or within 60 s of its JWT `exp`) is refreshed before the next account call, and parallel calls share one refresh. `account_status` reports `expiresAt`/`expired`. When the tokens were loaded from the token file, refreshed tokens are written back to it (atomically, mode 0600), so a restart does not begin with a stale token; tokens from an in-process `auth_exchange` stay in memory.

> **"Při přihlášení došlo k chybě." after signing in?** The sign-in usually worked. Alza redirects to `alza://identity?code=…&state=…`, which a desktop browser can't open, so the page stalls and a 40-second timer in Alza's login page shows that message. Before signing in, open DevTools and turn on **Network → Preserve log**. After you sign in, copy the `alza://identity?code=…` URL from the redirect's `Location` header, or from the Console error about failing to launch `alza://`. Pass the whole URL to `auth_exchange` as `code`. The code expires quickly, so exchange it right away. Registration and credential-change tools do accept passwords or verification codes as arguments, guarded by one-time confirmation tokens. Account/cart/order tools issue API requests and can fall back to browser-backed requests when challenged; they do not automate checkout forms.

**Checkout paths:** `web_place_order` submits the cart populated by `add_to_cart`, after `delivery_options` and any cart-scoped `web_pickup_places` lookup. The `web_add_to_cart` → `web_cart` HATEOAS basket is separate. The mobile `place_order` route was blocked by server-side HTTP 500 in the recorded live tests; the legacy WCF path was live-verified. See [known limitations](docs/gap-analysis.md) for dated evidence.

Mobile API environment variables:

| Env var | Purpose |
|---|---|
| `ALZA_API_BASE_URL` | Mobile API base URL, default `https://www.alza.cz` |
| `ALZA_VISITOR_ID` | Optional anonymous visitor UUID; otherwise generated per process |
| `ALZA_OAUTH_CLIENT_ID` | OAuth client id used by `auth_start`, `auth_exchange` and token refresh, default `alza_Android`. Change it only together with `ALZA_OAUTH_CLIENT_SECRET` |
| `ALZA_OAUTH_REDIRECT_URI` | OAuth redirect URI, default `alza://identity` |
| `ALZA_COUNTRY` / `ALZA_CULTURE` | `countryCode` / `culture` sent on the OAuth authorize URL, default: the `ALZA_BASE_URL` storefront's (`CZ` / `cs-CZ` for alza.cz, `SK` / `sk-SK` for alza.sk) |
| `ALZA_OAUTH_AUTHORITY` | OAuth authority, default `https://identity.alza.cz` |
| `ALZA_OAUTH_CLIENT_SECRET` | The `alza_Android` OAuth client is confidential — token requests need its APK-embedded secret (default: the source-verified value; set `""` to omit it for public clients). Used by `auth_exchange` and token refresh |
| `ALZA_CLIENT_SECRET` | Same secret for the PKCE exchange scripts (`scripts/e2e-order-payment.browser.mjs exchange`, `scripts/alza-auth-exchange.mjs`) |
| `ALZA_TOKEN_FILE` | JSON token store written by `scripts/alza-auth-login*` / `scripts/alza_auth_login.py` (default `~/.alza-mcp/tokens.json`; set `none` to disable auto-load). The server rewrites it (atomic, 0600) after refreshing tokens it loaded from it; with `none` it is neither read nor written |

Plus:

- 📦 **Resource** — `alza://product/{code}` lets agents read a product as a URI.
- 💬 **Prompt** — `/find-product` is a guided shopping helper.
- 🌍 **Multi-locale** — catalog locale configuration supports `alza.cz`, `.sk`, `.hu`, `.at`, `.de`, `.co.uk` via `ALZA_BASE_URL`. The API calls (`autocomplete`, individual reviews, alternatives, navigation, chatbot, account reads) send that storefront's `country` and `Accept-Language`; `webapi.alza.cz` and `chatbotapi.alza.cz` serve every storefront and pick it from `country` (live-verified for alza.sk 2026-10-12). Account/checkout verification is for CZ only, and the account writes (2FA, phone, email, account deletion, watchdogs, basket unlock) keep sending `country=CZ`.

---

## Configuration

All optional — `alza-mcp-community` works out of the box.

| Env var | Default | Purpose |
|---|---|---|
| `ALZA_BASE_URL` | `https://www.alza.cz` | Switch locale: `https://www.alza.cz`, `.sk`, `.hu`, `.at`, `.de`, `.co.uk` |
| `ALZA_CDP_URL` | _unset_ | Connect to your already-running Chrome via CDP instead of launching a managed Chromium. Reuses the existing browser session; set `ALZA_MCP_SKIP_INSTALL=1` separately to skip the installation-time download. Launch Chrome with `--remote-debugging-port=9222` and set `ALZA_CDP_URL=http://localhost:9222`. |
| `ALZA_TOOLSETS` | _unset_ | Toolsets to enable at startup in addition to the default `catalog` + `auth`, comma-separated (`basket_and_checkout,orders_and_payments`) or `all`. For MCP clients that do not reload the tool list after `set_toolset` (they ignore `notifications/tools/list_changed`), so the basket, order and account tools are visible from the first `tools/list`. Ids: see `list_toolsets`; an unknown id stops the server at startup. |
| `ALZA_HEADLESS` | `true` | Set `false` to show the browser used for scraping and API fallback; OAuth/MFA/payment interactions remain user-controlled |
| `ALZA_IDLE_TTL_MS` | `180000` | Close the headless Chromium after this many ms with no tool calls. Lower it on memory-constrained machines; raise it (or disable by setting absurdly high) if you make many calls in quick succession and don't want the relaunch latency. |
| `ALZA_PROXY_URL` | _unset_ | Route Alza traffic through an HTTP(S) or SOCKS5 proxy (`http://user:pass@host:port`, `socks5://host:port`), for example a residential proxy when this machine's IP gets Cloudflare challenges (datacenter and CI IPs do). Used by the managed Chromium and the `curl_cffi` sidecar. While it is set, the account stack never falls back to an un-proxied plain fetch (only to the managed browser), and with the sidecar disabled (`ALZA_CF_TRANSPORT=0`) OAuth, AppAction and document requests are refused instead of sent directly, so a proxy failure is reported instead of bypassed. An invalid value stops the server at startup with a one-line error. Not proxied: `ALZA_CDP_URL` browsers and multipart uploads (`upload_attachment`), which the sidecar cannot carry. |
| `ALZA_DEBUG` | `false` | Verbose stderr logging (equivalent to `ALZA_LOG_LEVEL=debug`) |
| `ALZA_LOG_LEVEL` | `info` | Minimum stderr log level: `debug`, `info`, `warn` or `error` |
| `ALZA_CF_TRANSPORT` | _enabled_ | Set `0` to disable the Chrome-fingerprint `curl_cffi` sidecar (the account stack then uses plain fetch and the browser) |
| `ALZA_CF_PYTHON` | _auto_ | Python interpreter that has `curl_cffi`. Default search order: this variable, `.venv-cf` in the package (`bin/python`, or `Scripts\python.exe` on Windows), then `python3` (`python`/`py` on Windows) |

### Install paths and the curl_cffi venv

The Chrome-fingerprint sidecar needs a Python venv with `curl_cffi` (pinned to `>=0.16,<0.17`, the tested range). What each install path does:

| Install path | Chromium headless-shell | `curl_cffi` venv |
|---|---|---|
| `npx -y alza-mcp-community` / `npm i alza-mcp-community` (Linux, macOS, WSL, MSYS bash) | downloaded by postinstall | created by postinstall if `bash` and `python3` (with `venv`) exist; a failed attempt removes the partial venv |
| `ALZA_MCP_SKIP_INSTALL=1` or `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` | skipped (downloaded at runtime when needed) | still created |
| `ALZA_MCP_SKIP_VENV=1` | downloaded | skipped |
| `--ignore-scripts`, or the `.mcpb` bundle | downloaded at runtime when needed | **not created**. For `--ignore-scripts` run `npx -y alza-mcp-community --setup-cf` (cross-platform, no bash) or `bash scripts/ensure-cf-venv.sh` in the package directory; for the `.mcpb` bundle run `--setup-cf` once and point `ALZA_CF_PYTHON` at any interpreter that has `curl_cffi` |
| This repository's own checkout (`npm ci`) | skipped | skipped; run `npm run setup:cf` and `npx playwright install chromium --only-shell` yourself |

Without the venv the server still works: the account stack falls back to plain fetch and the browser, which Cloudflare challenges more often. Windows: the interpreter lookup also tries `.venv-cf\Scripts\python.exe`, `python` and `py`, and the bash script does not run on plain Windows. Use `npx -y alza-mcp-community --setup-cf` instead: it is implemented in Node, finds `py -3`/`python`/`python3`, runs `python -m venv .venv-cf` in the package directory, installs `curl_cffi>=0.16,<0.17`, verifies the import, prints success or failure and exits 0/1. It is idempotent, removes a venv it half-built if pip fails, honours `ALZA_MCP_SKIP_VENV=1`, and is never run automatically (the server never installs packages at runtime; when the sidecar is unavailable it only logs a one-line hint to run it). The venv is created inside the package copy that runs the command (for `npx`, its cache directory, which is replaced when a new version is fetched or the npm cache is cleared; re-run `--setup-cf` then), so the `.mcpb` bundle, which has its own directory, does not pick it up: after running it, set `ALZA_CF_PYTHON` to the interpreter it prints (or to any interpreter that has `curl_cffi`) in the bundle's environment. The Windows path (`Scripts\python.exe`, `py -3`) is unit-tested with mocked processes only and is `unresolved` on a real Windows machine (not tested live).

---

## Running over HTTP (Streamable HTTP)

stdio is the default and what the install snippets above use. To serve the same server over [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http) instead, for example for a client that only takes a URL:

```bash
npx -y alza-mcp-community --http --port 3000          # or: ALZA_TRANSPORT=http ALZA_HTTP_PORT=3000 npx -y alza-mcp-community
# → MCP endpoint http://127.0.0.1:3000/mcp, health check http://127.0.0.1:3000/healthz

claude mcp add --transport http alza http://127.0.0.1:3000/mcp
```

On HTTP the server is stricter than on stdio, because a network endpoint can be reached by more than one client:

- **Catalog only by default.** Only the read-only, anonymous toolsets are usable: `catalog` (on) and `pc_builder` (enable with `set_toolset`). Every other toolset (`auth`, basket/checkout, account, orders/payments, reviews/subscriptions, chat, `advanced_raw`) is **locked**: `list_toolsets` shows it with the reason, and `set_toolset` refuses to enable it. These tools sign in to and act on a real Alza account (orders, payments, credentials), so a shared endpoint must not offer them by accident. Set `ALZA_HTTP_ENABLE_ACCOUNT=1` to unlock them.
- **One server per MCP session.** Each `Mcp-Session-Id` gets its own server instance: its own toolset state, OAuth tokens and one-time confirmation tokens. With `ALZA_HTTP_ENABLE_ACCOUNT=1`, each session also gets its own browser context and Chrome-fingerprint sidecar, because both keep Alza cookies. Sessions expire after 30 idle minutes.
- **No token file.** `ALZA_TOKEN_FILE` (`~/.alza-mcp/tokens.json`) holds one person's login, so HTTP mode does not load it. Each session signs in with `auth_start` → `auth_exchange`. For a single-user localhost setup you can set `ALZA_HTTP_ALLOW_TOKEN_FILE=1` (together with `ALZA_HTTP_ENABLE_ACCOUNT=1`); every session then starts signed in as that account, so never do this on a shared host. All sessions start from the same refresh token. Alza may rotate it on refresh (reported on 2026-09-10; a 2026-10-07 run saw the same refresh token come back six times, so treat rotation as possible, not guaranteed), in which case the first session that refreshes invalidates the copy the others hold (they then need `auth_start` → `auth_exchange`). Each session writes its refreshed tokens back to the token file, so a restart picks up the newest ones; keep to one active session in this mode.
- **Localhost only by default.** It binds `127.0.0.1` and rejects requests whose `Host` or `Origin` is not a loopback name (DNS-rebinding protection). There is no built-in authentication or TLS. If you bind elsewhere (`--host 0.0.0.0`), put it behind a reverse proxy that does both, and set `ALZA_HTTP_ALLOWED_HOSTS`.

| Env var / flag | Default | Purpose |
|---|---|---|
| `--http`, `ALZA_TRANSPORT=http` | stdio | Serve over Streamable HTTP |
| `--help`, `--version` (`-h`, `-v`) | | Print usage or the version and exit |
| `--port N`, `ALZA_HTTP_PORT` (or `PORT`) | `3000` | Listen port (`0` picks a free one) |
| `--host H`, `ALZA_HTTP_HOST` | `127.0.0.1` | Bind address |
| `ALZA_HTTP_ALLOWED_HOSTS` | loopback names when bound to loopback, otherwise no check | Comma-separated hostnames accepted in `Host`/`Origin` |
| `ALZA_HTTP_ENABLE_ACCOUNT` | off | Unlock the auth/account/checkout/order/payment toolsets (per-session logins) |
| `ALZA_HTTP_ALLOW_TOKEN_FILE` | off | Also load `ALZA_TOKEN_FILE` into every session (single-user only; needs `ALZA_HTTP_ENABLE_ACCOUNT`) |
| `ALZA_HTTP_MAX_SESSIONS` | `50` | Concurrent session cap (HTTP 503 beyond it) |
| `ALZA_HTTP_SESSION_IDLE_MS` | `1800000` | Close a session after this long without a request (a session holding an open GET/SSE stream is not closed) |
| `ALZA_HTTP_REQUEST_TIMEOUT_MS` | `30000` | Time a client has to send a whole request (headers get half); HTTP 408 beyond it. Responses, including tool calls and GET/SSE streams, are not limited |
| `ALZA_HTTP_MAX_CONNECTIONS` | `256` | Open TCP connection cap (SSE streams count); connections over it are dropped |

**Hosting is not supported yet.** A hosted endpoint (Vercel `mcp-handler`, Fly, Railway, …) is a follow-up. The main obstacle is Cloudflare, not the transport: Alza is behind Cloudflare Bot Management, and both the headless browser and the `curl_cffi` sidecar get through it from a residential IP (live-verified) but are far more likely to be challenged from a datacenter IP. A hosted instance will probably need a residential proxy (`ALZA_PROXY_URL`) or a browser-as-a-service (for example Browserbase via `ALZA_CDP_URL`). The daily canary's GitHub-hosted runs show this: they get Cloudflare's interactive challenge. Other things a host needs: Chromium and Python with `curl_cffi` in the image, enough memory for one browser per account session, sticky routing (sessions live in one process's memory), and authentication in front of the endpoint. Keep the account toolsets locked on any multi-user host.

---

## Pi agent integration

Register the local build in pi's global MCP config (`~/.pi/agent/mcp.json`):

```json
{
  "alza": {
    "command": "node",
    "args": ["/absolute/path/to/alza-mcp-community/dist/index.js"]
  }
}
```

Run `/reload` (or `mcp connect alza` — the gateway respawns the stdio process, so a freshly built `dist/` takes effect without `/reload`). The gateway exposes the tools (the domain tools plus `list_toolsets`/`set_toolset`/`report_issue`; only the `catalog` and `auth` toolsets are enabled until you call `set_toolset`) under the `alza_` prefix (`alza_search_products`, `alza_get_product`, `alza_cart`, …). Auth auto-loads from `~/.alza-mcp/tokens.json`. Verified in both modes: (a) in-session through the gateway — search/filter/detail, authenticated add-to-cart, bogus-coupon round-trip → server-side `err:1` envelope ([docs/live-evidence/pi-integration-2026-09-10.md](docs/live-evidence/pi-integration-2026-09-10.md)); and (b) **headless** (`pi -p` one-shot prompt), where the agent discovers the `alza_*` tools, calls `search_products` with the right args, and reports the correct cheapest in-stock product ([docs/live-evidence/headless-pi-2026-09-12.json](docs/live-evidence/headless-pi-2026-09-12.json)); the 2026-09-13 re-run adds three more headless scenarios — catalog search with price-ascending sort, the authenticated account stack (`account_status` + `cart`), and the one-time mutation token flow (`prepare_mutation`) — all captured in [docs/live-evidence/headless-pi-2026-09-13.json](docs/live-evidence/headless-pi-2026-09-13.json).

---

## How it works

Alza has no public consumer API. This project reverse-engineers the Android app's REST surface (route names and DTOs recovered from the APK) and the website's own checkout pipeline. Neither is a supported or documented interface, so any of it can change or break without notice.

**Cloudflare Bot Management.** Alza sits behind it and returns HTTP 403 to plain HTTP clients. This server gets past it in two ways: a headless Chromium (catalog scraping) and a Chrome-fingerprint HTTP sidecar (`scripts/cf-transport.py`, using `curl_cffi` to impersonate Chrome's TLS/HTTP2 fingerprint) for the account/checkout API. That is circumvention of a bot-protection measure, which Alza's terms of use may prohibit. The sidecar and its setup script ship in the npm package, and postinstall tries to set up its `curl_cffi` venv. It stays optional: without Python or `curl_cffi`, the account stack (including OAuth sign-in) falls back to plain fetch and, for same-origin API calls, the browser. A request that changes something (POST/PUT/PATCH/DELETE) is only re-sent another way when the sidecar never sent it; if the sidecar fails after sending (timeout, connection error), the tool reports that the outcome is unknown instead of sending the order, payment or account change a second time. See the [Disclaimer](#disclaimer) and [SECURITY.md](SECURITY.md) before using it.

**Link attribution.** Product, category and suggestion links that the catalog tools return (`search_products`, `get_product`, `compare_products`, `recommend_alternatives`, `get_deals`, `autocomplete`, `list_categories`, `pc_build_*`, `watchdog_list` and the `alza://product/{code}` resource) carry `utm_source=alza-mcp-community&utm_medium=mcp`, at Alza's request, so Alza can see visits that came through this server. The parameters are only added to Alza storefront links shown to you. The server's own requests to Alza, sign-in, payment, API, PDF and image URLs, and the account and checkout tools' raw responses are not tagged. No other data is added.

No generic arbitrary-route tool is exposed. What is and isn't covered:

- Excluded: administrative login routes, telemetry/audit routes, device-token and anonymous-activity routes, and external payment hand-offs (Klarna, Google Pay) plus the quick-order payment family (documented as `blocked` in the coverage matrix).
- Included, behind one-time tokens: order placement and cancellation, account registration, and credential/identity changes (password, 2FA, phone, email, account deletion — `delete_account` is irreversible).
- Server-driven action URLs are followed only when returned by a confirmed response, through the origin-validated `AppActionExecutor` (GET/POST, path allowlist, a per-tool route family and method, a denylist of credential/payment/order and GET-write routes, sensitive-field blocklist, one-time confirmation token); they are not accepted as arbitrary MCP URLs.

The complete 12-family route inventory with method, DTO, prerequisites, side effects, exposure, and verification status is maintained in [docs/mobile-endpoint-coverage.md](docs/mobile-endpoint-coverage.md).

Legacy catalog compatibility still uses the original page adapter:

- Search navigates `/search.htm?exps=...` and scrapes `.browsingitem` cards.
- Product detail comes from page JSON-LD.
- Reviews use JSON-LD aggregate ratings.
- Pickup points combine branch data and geocoding.
- Per-process caching remains enabled.

Image, font, and analytics requests are blocked at the route level. Catalog pages still load scripts, and sorted searches may fetch multiple result pages. Typical latencies: search ~2 s, product detail ~5 s warm.

```
┌────────────────────────────────────────────┐
│ stdio transport (npx alza-mcp-community)             │
├────────────────────────────────────────────┤
│ MCP tools / resources / prompts            │
│  grouped into toolsets (toolsets.ts)       │
├────────────────────────────────────────────┤
│ Domain: catalog · reviews · pickup ·       │
│         mobile-account (cart/checkout/…)   │
├────────────────────────────────────────────┤
│ Infra:                                     │
│  • browser (Playwright, CDP)               │
│  • impersonate-transport (curl_cffi        │
│    Chrome-fingerprint sidecar)             │
│  • mobile-api (APK-derived REST client)    │
│  • jsonld (schema.org parser)              │
│  • cache (LRU + TTL)                       │
│  • locale (multi-country)                  │
└────────────────────────────────────────────┘
```

For deeper architecture notes — including why we don't ship the HTTP/okhttp recipe — see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Development

```bash
git clone https://github.com/lukabudik/alza-mcp-community.git
cd alza-mcp-community
npm install                 # dev checkout: postinstall is skipped on purpose
npm run setup:cf            # optional curl_cffi venv (needs bash + python3)
npx playwright install chromium --only-shell   # browser for live runs
npm test                    # unit tests, no network
npm run typecheck
npm run build               # → dist/
npm run eval                # agent-driven MCP eval harness (6 scenarios) → docs/live-evidence/
npm run validate:api        # hits real Alza — runs every tool end-to-end
npm run pentest:app-action  # Node AppAction transport comparison
npm run live:endpoint-matrix # bounded read-only APK route matrix; requires ALZA_API_BASE_URL
npm run live:user-journeys   # catalog, delivery/cart, and anonymous-account journeys
npm run auth:login:py        # PKCE login step 1 (prints browser URL + pending-login.json)
npm run auth:exchange        # PKCE login step 2 (Node, needs a CF-friendly egress)
node scripts/e2e-order-payment.browser.mjs exchange "<pasted alza://identity redirect>"
                             # step 2 via Playwright (works even when Cloudflare challenges plain HTTP)
npm run live:e2e             # real order + after-order payment through the MCP tools
                             # (browser-backed transport; use ALZA_HEADLESS=false to watch it)
npm run live:e2e:node        # same journey over plain HTTP (in-memory MCP client); needs a
                             # non-challenged egress or a fresh ~/.alza-mcp/tokens.json
STOP_BEFORE_ORDER=1 npm run live:e2e   # dry run: stop right before order submission
ALLOW_ANON=1 STOP_BEFORE_ORDER=1 npm run live:e2e
                             # anonymous dry run; ALLOW_ANON alone does not prevent ordering
node dist/index.js          # run the server (waits for stdio MCP messages)
node dist/index.js --http   # or serve MCP Streamable HTTP on http://127.0.0.1:3000/mcp
```

**Further reading:**
- [ARCHITECTURE.md](ARCHITECTURE.md) — why the code looks the way it does (CF, Playwright, hydration strategy)
- [ROADMAP.md](ROADMAP.md) — what's planned next
- [CONTRIBUTING.md](CONTRIBUTING.md) — repo layout and how to add a tool

---

## Roadmap

`main` already covers catalog, filtering, cart, checkout, order placement/cancellation and account management (see [What it does](#what-it-does) and the known limitations in [docs/gap-analysis.md](docs/gap-analysis.md)). Next up:

- **PC builder** follow-ups ([#15](https://github.com/lukabudik/alza-mcp-community/issues/15); `pc_builder` toolset shipped) and a **hosted HTTP endpoint** (follow-up to [#16](https://github.com/lukabudik/alza-mcp-community/issues/16); local `--http` mode is shipped)

Priorities live in [ROADMAP.md](ROADMAP.md); everything is tracked in [issues](https://github.com/lukabudik/alza-mcp-community/issues) — [`good first issue`](https://github.com/lukabudik/alza-mcp-community/labels/good%20first%20issue) is the place to start.

---

## FAQ

### Why the 92 MB Chromium download?

Alza's bot protection can challenge ordinary HTTP requests. The catalog uses headless Chromium to render product pages; the account stack can also use the optional Chrome-fingerprint sidecar, with browser-backed requests as a fallback. Chromium is installed by the postinstall hook or on first launch if needed. See [How it works](#how-it-works).

### How are login and ordering protected?

1. OAuth sign-in does not pass the Alza password as an MCP tool argument — sign-in happens in the user's browser (OAuth PKCE) and the MCP only exchanges the returned code. Tools that necessarily carry credentials as arguments (`register`, `change_password`, `phone_change`, `email_change`) require an explicit one-time token and should only be called with the user's direct instruction.
2. `checkout_preview` creates a one-time confirmation token after the cart and delivery choice are reviewed; `place_order` refuses arbitrary tokens.
3. `web_place_order` (the currently working submission path — mobile `place_order` returns HTTP 500 server-side) and every other high-impact mutation (`cancel_order`, `pay_after_order`, `delete_account`, …) require a one-time token from `prepare_mutation`. Tokens are single-use, bound to one action and to the exact arguments passed as `payload`, and expire after 5 minutes. MFA and 3-D Secure remain user-controlled browser interactions.
4. These tools create, change and cancel **real orders and accounts**. The token is a guard against accidental calls by an agent, not a substitute for the user confirming the action — have your agent show the order summary and ask first.

### Can I avoid the Chromium download?

Yes. Set `ALZA_CDP_URL` to your existing Chrome's debug port:

```bash
# launch Chrome with debugging
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222
# tell alza-mcp-community to attach
ALZA_MCP_SKIP_INSTALL=1 ALZA_CDP_URL=http://localhost:9222 npx alza-mcp-community
```

The MCP will use *your* Chrome — no separate download, faster cold starts, and it inherits any Alza cookies you already have.

### Will Alza take this down?

It might, and you should assume that's possible. The project has no commercial intent, caches to minimize traffic, and provides a takedown contact path via [issues](https://github.com/lukabudik/alza-mcp-community/issues) — if Alza requests removal, we'll comply. But it does get past Alza's bot protection (see [How it works](#how-it-works)), so it is not a polite scraper by Alza's standards, and Alza's terms of use may forbid it. Use it for personal automation, not at scale.

### How does this compare to rohlik-mcp?

[tomaspavlin/rohlik-mcp](https://github.com/tomaspavlin/rohlik-mcp) is the inspiration. Differences:
- Rohlik isn't behind a Cloudflare challenge → rohlik-mcp uses plain HTTP. We're forced to a real browser because Alza is.
- Alza is a much larger catalog (millions of SKUs vs. a grocery list).
- We cover the whole purchase path (cart, checkout, order placement and cancellation) plus account management, not only catalog reads, and group the tools into toolsets so only the catalog and auth toolsets are enabled by default.
- We expose MCP **resources** and **prompts** in addition to tools.

---

## Disclaimer

`alza-mcp-community` is **not affiliated with, endorsed by, or sponsored by Alza.cz a.s.** "Alza", "Alza.cz", and "AlzaBox" are trademarks of their respective owners.

**What this software does.** It is a reverse-engineered client. Its mobile-API routes and data shapes were recovered from the Alza Android application, and its catalog tools scrape alza.cz pages with a headless browser. To reach Alza's servers it circumvents Cloudflare Bot Management (headless Chromium plus a Chrome-fingerprint HTTP sidecar). The Android app's OAuth client credential, which is embedded in the public APK, is used as the default for the token exchange.

**Legal.** None of this is a published or supported interface, and Alza's terms of use may prohibit automated access, bot-protection circumvention and reverse engineering. Whether and how you may use this software depends on your jurisdiction and your agreement with Alza. You are solely responsible for that determination. This is not legal advice, and the maintainers make no representation that use of this software is lawful or permitted.

**It acts on real accounts and spends real money.** The checkout, order, payment, registration and account-deletion tools operate on live Alza accounts. Orders placed are real and binding; cancellation is not guaranteed to succeed. One-time tokens guard against accidental agent calls but are not a substitute for confirming each action yourself. Test only with accounts and orders you are prepared to lose, and never with credentials you are not prepared to expose to your agent's context.

**No warranty.** Provided "as is" under the MIT license. The maintainers make no guarantees of availability, accuracy, or fitness for any purpose, and are not liable for orders, charges, account lockouts or bans resulting from its use. The upstream interfaces can change without notice, so any tool may stop working. Do not rely on this for commercial decisions.

**Security issues** — see [SECURITY.md](SECURITY.md). **Alza employees or rights holders** with concerns: please open an issue or contact the maintainers — we will respond promptly and comply with reasonable removal requests.

---

## License

MIT. See [LICENSE](LICENSE).

## Contributors

<table>
  <tr>
    <td align="center"><a href="https://github.com/lukabudik"><img src="https://github.com/lukabudik.png?size=100" width="80" alt=""><br><sub><b>Luka Budík</b></sub></a><br><sub>Creator, maintainer</sub></td>
    <td align="center"><a href="https://github.com/samuelseidel"><img src="https://github.com/samuelseidel.png?size=100" width="80" alt=""><br><sub><b>Samuel Seidel</b></sub></a><br><sub>Maintainer</sub></td>
    <td align="center"><a href="https://github.com/jankryh"><img src="https://github.com/jankryh.png?size=100" width="80" alt=""><br><sub><b>@jankryh</b></sub></a><br><sub>OAuth login fix</sub></td>
  </tr>
</table>

A big thank you to **[Samuel Seidel](https://github.com/samuelseidel)**, the project's first outside contributor and now a co-maintainer. He built the account, cart, checkout and order tools, toolsets, typed output schemas, category filtering and the live-verified test harness, which together took the project from a 5-tool catalog browser to a full shopping agent ([#1](https://github.com/lukabudik/alza-mcp-community/pull/1), [#5](https://github.com/lukabudik/alza-mcp-community/pull/5)).

Thanks also to **[@jankryh](https://github.com/jankryh)**, who tracked down why OAuth login never worked from the npm package and fixed it ([#29](https://github.com/lukabudik/alza-mcp-community/issues/29), [#30](https://github.com/lukabudik/alza-mcp-community/pull/30)).

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) and the [open issues](https://github.com/lukabudik/alza-mcp-community/issues).

## Acknowledgements

- [tomaspavlin/rohlik-mcp](https://github.com/tomaspavlin/rohlik-mcp) — direct inspiration; layout patterns we mirror.
- [topmonks/hlidac-shopu](https://github.com/topmonks/hlidac-shopu) — reference Alza scraper recipe (HTTP + proxies).
- [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) — official Playwright MCP, proof that browser-driven MCPs are the right abstraction for many websites.
- [Model Context Protocol](https://modelcontextprotocol.io) and the [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).
