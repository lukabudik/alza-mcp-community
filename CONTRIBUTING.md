# Contributing to alza-mcp-community

Thanks for considering a contribution. This is a small, focused project — an MCP server for Alza.cz covering the catalog plus token-guarded account/checkout tools — and the bar for any change is "does it make agents better at helping people shop?".

Looking for something to work on? See [ROADMAP.md](ROADMAP.md) and the [`good first issue`](https://github.com/lukabudik/alza-mcp-community/labels/good%20first%20issue) label. Comment on an issue before starting so work isn't duplicated.

## Quick start

```bash
git clone https://github.com/lukabudik/alza-mcp-community.git
cd alza-mcp-community
npm install
npm test          # unit tests
npm run typecheck # TS strict
npm run build     # compile to dist/
npm run validate:api  # hits real Alza endpoints — internet required
```

### Clean-environment install tests (Docker)

`npm run test:docker` checks the packed package the way users and MCP clients install it, in throwaway containers. It needs Docker and internet access, takes about 10 minutes the first time (most of it image builds and Chromium downloads), and is **not** part of `npm test`.

```bash
npm run test:docker                          # every suite that applies to this tree
npm run test:docker -- install smithery      # only some suites
npm run test:docker -- --live install        # plus ONE live search_products call from a clean container
bash scripts/docker-install-tests.sh --source ../alza-mcp-other-branch   # test another checkout with this harness
```

It packs the tree (`npm pack`) and publishes the tarball to a local Verdaccio container, so `npx -y alza-mcp-community` in every container resolves to the code under test. Other packages are proxied from npmjs. Suites:

| Suite | What it verifies |
|---|---|
| `install` | node 20/22/24 images with and without python3 (`npx -y` and `npm install <tgz>`): postinstall runs, `.venv-cf` with `curl_cffi` is created only when python3 + venv exist and is skipped cleanly otherwise, the sidecar files ship, and stdio `initialize` + `tools/list` work. |
| `badges` | Decodes the README Cursor and VS Code badge links, checks the config is exactly `npx -y alza-mcp-community` with no env, and follows the https redirects. |
| `vscode` | Official VS Code `.deb` under Xvfb with a fresh profile: opens the badge's `vscode:mcp/install` URI with `code --open-url`, clicks Install over CDP, asserts the profile's `mcp.json`, launches the installed entry, and takes screenshots. |
| `cursor` | Cursor AppImage, signed out with a fresh profile: opens the `cursor://` deeplink, reads and confirms the install dialog, asserts `~/.cursor/mcp.json`, and launches the entry. |
| `mcpb` | Builds the Claude Desktop bundle with `scripts/build-mcpb.sh` and runs `mcpb validate`/`info`. It then unpacks the bundle in a container with no network and launches `manifest.server.mcp_config` with default and empty user settings. |
| `http` | Runs `npx -y alza-mcp-community --http` in one container and the SDK Streamable HTTP client in another. Covers sessions, per-session toolset isolation, locked account toolsets, Host/Origin checks, DELETE, and the loopback-only default bind. |
| `smithery` | Evaluates `smithery.yaml`'s `commandFunction`, checks that every env var it emits is read by `dist/`, and launches the result. |

Suites that do not apply to the tree (no badges, no `mcpb/`, no `--http`) report `BLOCKED`. Logs, decoded URIs, the resulting `mcp.json` files and screenshots go to `test/docker/.out/` (gitignored), with `summary.txt` listing every check. The run exits non-zero if any check fails, and removes every container, image and network it created unless you pass `--keep`.

## Project layout

```
src/
  index.ts          # entrypoint: stdio (default), --http, --setup-cf
  http.ts           # Streamable HTTP transport (per-session servers)
  server.ts         # builds the McpServer; testable
  infra/            # browser, mobile-API client, curl_cffi sidecar client, AppAction executor,
                    # proxy, locale, JSON-LD, cache, errors, logger
  domain/           # catalog, reviews, pickup, deals, watchdog, PC builder, mobile-account (cart/checkout/orders)
  tools/            # MCP tools (mostly one file per tool), toolsets, allowlists, output schemas
  resources/        # alza:// resource handlers
  prompts/          # MCP prompt templates
  data/             # static datasets (e.g. branches)
test/               # vitest tests + fixtures; test/docker/ holds the install-test harness
scripts/            # validate-api, eval, auth helpers, cf-transport sidecar, live and e2e scripts
docs/               # endpoint coverage matrix, gap analysis, live evidence
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full module map.

## Adding a new tool

1. Create `src/tools/your-tool.ts` exporting `createYourTool(deps): RegisterableTool`. Its `register()` must **return** the SDK's `RegisteredTool` handle (`return server.registerTool(...)`) — toolsets use it to enable/disable the tool.
2. Define a Zod input schema. **Every field gets `.describe()`** — that text is what the LLM reads to decide whether and how to call the tool.
3. Set `annotations.readOnlyHint: true` for read-only tools. Anything that mutates must set `readOnlyHint: false`; anything irreversible or money-relevant must also set `destructiveHint: true` and be gated by a one-time token (`prepare_mutation` → `confirmation_token` argument, see `web_place_order`/`cancel_order`).
4. Return both `content[].text` (Markdown summary for chat) and `structuredContent` (typed JSON for the agent), and add an entry to `OUTPUT_SCHEMAS` in `src/tools/output-schemas.ts`.
5. Register the tool in `src/server.ts` **and assign it to exactly one toolset** in `src/tools/toolsets.ts`. Startup throws if a registered tool isn't in a toolset (or is in two), so a new tool can never be silently unreachable. The only exceptions are the always-visible meta tools (`list_toolsets`, `set_toolset`, `report_issue`), which are registered outside the toolsets.
6. Add tests: update the tool counts in `test/tool-annotations.test.ts`, `test/output-schemas.test.ts` and `test/toolsets.test.ts`, add any new mutating/destructive/no-network tool to the sets in `tool-annotations.test.ts`, update `scripts/eval.ts`'s `CANONICAL_ORDER` and counts, and add a behavioural test for the tool's logic in `test/`.
7. For anything touching a live Alza route, record it in `docs/mobile-endpoint-coverage.md` with a verification label (`source-confirmed` / `live-verified` / `blocked` / `unresolved`) and update `CHANGELOG.md`.

## Adding a data source

Add a domain module under `src/domain/`. If it talks to a new upstream:

- Prefer an official API with a documented schema (see how `pickup.ts` reads AlzaBox lockers from Alza's public `/api/salesNetwork/v1/places` JSON API).
- If you have to reverse-engineer, document the recipe in a top-of-file comment and reference any prior art.
- Always plumb errors through the typed errors in `src/infra/errors.ts` so the server can return clean MCP errors.

## Style

- TypeScript strict, no `any`, no `// @ts-ignore` without a comment explaining why.
- Small files, single responsibility.
- No comments that just restate the code.
- Tests are vitest; integration script is `npm run validate:api`.

## Reporting upstream breakage

Agents using the server can draft these reports themselves: `report_issue` returns a redacted body plus `gh issue list` / `gh issue create` commands (see the README, "Reporting problems"). By hand:

When Alza changes an endpoint shape:

1. Run `npm run validate:api` and paste the output.
2. Open an "Endpoint broken" issue.
3. Bonus: include a HAR file or a curl snippet showing the new shape.

## Releasing

`server.json` (the official MCP Registry manifest) and `mcpb/manifest.json` (the Claude Desktop bundle) are bumped together with `package.json`: `npm version <patch|minor|major>` runs `scripts/sync-version.cjs` (the npm `version` lifecycle script), which sets `server.json`'s top-level `version` and `packages[0].version` `mcpb/manifest.json`'s `version` and the `VERSION` constant in `src/server.ts`, and stages those files into the version commit. `npm run version:check` reports a mismatch without changing anything. The release workflow (`.github/workflows/publish.yml`) fails before `npm publish` if any of them differ, then publishes to the registry via `mcp-publisher` (OIDC login) after the npm publish. Keep `description` at 100 characters or fewer (registry limit).

## Code of conduct

Be kind. This is a hobby project run by volunteers.
