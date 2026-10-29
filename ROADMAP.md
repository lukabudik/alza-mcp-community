# Roadmap

Rough priority order. Every item is a GitHub issue — comment there before starting so work isn't duplicated. New to the project? Start with [`good first issue`](https://github.com/lukabudik/alza-mcp-community/labels/good%20first%20issue).

## Shipped

- **Catalog** — search with price/stock/screen-size filters and client-side sort, real pagination, product detail with spec params (DOM + JSON-LD), aggregate rating plus individual review bodies, category tree, checkbox and slider (range) facet filters (`list_category_filters`), EAN lookup, AlzaBox lockers and showroom pickup points without a cart.
- **Discovery tools** — `compare_products` (side-by-side spec table with an optional MCP-sampling summary), `recommend_alternatives`, `get_deals`, `autocomplete`.
- **Account & checkout** — OAuth PKCE sign-in, cart, delivery/AlzaBox selection, checkout preview, order placement (legacy web WCF path) and cancellation, after-order payments, order history/documents, claims, subscriptions, profile/addresses and credential changes — all high-impact mutations behind one-time confirmation tokens.
- **Price & stock watchdogs** — `watchdog_list` / `watchdog_set` / `watchdog_delete` over Alza's native watchdog ([#17](https://github.com/lukabudik/alza-mcp-community/issues/17)).
- **PC builder** — `pc_build_check` / `pc_build_suggest` in the `pc_builder` toolset ([#15](https://github.com/lukabudik/alza-mcp-community/issues/15)).
- **Progressive disclosure** — tools grouped into toolsets; only `catalog` and `auth` are enabled by default.
- **Streamable HTTP transport** — `alza-mcp-community --http` for local multi-session use (catalog-only unless account access is opted in).
- **Operator controls** — `ALZA_TOOLS_ALLOW` / `ALZA_MUTATION_ACTIONS_ALLOW` allowlists, `ALZA_PROXY_URL`, and `ALZA_PERSIST_SIGNIN` (0.6.0).
- **Distribution** — published on npm as `alza-mcp-community`, CI on Node 20/22, trusted publishing on tag push; `server.json` and `smithery.yaml` in the repo, published to the official MCP Registry from the release workflow ([#19](https://github.com/lukabudik/alza-mcp-community/issues/19), 0.4.0). Cursor and VS Code install badges plus a Claude Desktop `.mcpb` bundle attached to each release.

## Near-term

- [#118](https://github.com/lukabudik/alza-mcp-community/issues/118) postinstall `MODULE_NOT_FOUND` inside playwright-core 1.64.1 (reported on Windows; needs a Windows repro, then pin or report upstream)
- [#22](https://github.com/lukabudik/alza-mcp-community/issues/22) One-click install — links and `.mcpb` bundle shipped and Docker-tested; needs a confirmation on macOS or Windows Claude Desktop
- [#20](https://github.com/lukabudik/alza-mcp-community/issues/20) List in MCP directories (Smithery, Glama, PulseMCP, mcp.so)

## Long-term

- PC builder follow-ups: facet-based candidate filtering (blocked by Alza redirects) and latency
- Self-hosted price watchlist (storage + scheduled check + notification), after a hosted endpoint exists
- Hosted HTTP endpoint (follow-up to [#16](https://github.com/lukabudik/alza-mcp-community/issues/16); local `--http` mode shipped — Cloudflare blocks datacenter IPs, see docs/gap-analysis.md)

Known limitations and dead ends (with dated evidence) live in [docs/gap-analysis.md](docs/gap-analysis.md). Ideas not listed here: open a [feature request](https://github.com/lukabudik/alza-mcp-community/issues/new/choose).
