import { MUTATION_ACTIONS } from "../domain/mobile-account.js";

/**
 * Operator allowlists for a deployment that hands the server to an agent it
 * does not fully trust (e.g. a remote connector on a phone). Toolsets and
 * `ALZA_TOOLSETS` decide what is *visible*; these decide what *exists*:
 *
 *  - `ALZA_TOOLS_ALLOW`: tool names the server exposes. Every other tool —
 *    including `list_toolsets`, `set_toolset` and `report_issue` — is removed
 *    after registration, so no `set_toolset` call can bring it back. The
 *    allowed tools are enabled from the start.
 *  - `ALZA_MUTATION_ACTIONS_ALLOW`: `prepare_mutation` actions that may be
 *    issued a confirmation token. Every guarded write needs that token, so an
 *    action outside the list cannot run (e.g. `mutate_list` `submit_discussion`
 *    publishing a post under the user's name). Both tools' `action` enums
 *    shrink to the list.
 *
 * Comma/space-separated; unset means no restriction. Unknown names are a
 * startup error, so a typo cannot silently drop or keep something.
 */
function parseList(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  return [...new Set(raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
}

/** Names are checked against the registered tools in registerToolsets. */
export function parseToolsAllowEnv(raw: string | undefined): ReadonlySet<string> | undefined {
  const names = parseList(raw);
  return names && new Set(names);
}

export function parseMutationActionsAllowEnv(raw: string | undefined): readonly string[] | undefined {
  const actions = parseList(raw);
  if (!actions) return undefined;
  const known = MUTATION_ACTIONS as readonly string[];
  for (const a of actions) {
    if (!known.includes(a)) throw new Error(`ALZA_MUTATION_ACTIONS_ALLOW: unknown action "${a}" (known: ${known.join(", ")})`);
  }
  return actions;
}
