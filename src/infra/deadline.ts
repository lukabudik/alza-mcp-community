/**
 * Claude Desktop (and several other MCP hosts) abandon a tool call after about
 * 60 s. Tools that fetch several pages use a budget below that and return what
 * they have instead of nothing.
 */
export const TOOL_BUDGET_MS = 40_000;

/** Resolves with `{ value }` or, when `deadlineAt` (epoch ms) passes first, `{ timedOut: true }`. The work itself keeps running and may still fill caches. */
export async function raceDeadline<T>(work: Promise<T>, deadlineAt: number): Promise<{ value: T; timedOut?: false } | { timedOut: true }> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    work.catch(() => undefined);
    return { timedOut: true };
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), remaining);
    timer.unref();
  });
  try {
    return await Promise.race([work.then((value) => ({ value }) as { value: T }), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    work.catch(() => undefined);
  }
}
