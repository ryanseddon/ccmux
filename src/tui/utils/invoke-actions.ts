import type { EnrichedSession } from "../../types";
import { sessionRoute } from "../../lib/session-route";

/**
 * The daemon endpoint path for the "kill" action on a row.
 *
 * An invoke-driven row (`originInvocationId` set) is cancelled cleanly via
 * `POST /invoke/:id/cancel` — the invoker's unwind tears down its session
 * (if any). A subprocess invoke row has no real tmux session at all, so
 * `POST /sessions/:id/kill` would 404; a Claude invoke's session must
 * unwind through the invoker rather than have its pane yanked. Crucially
 * the cancel always targets `originInvocationId`, never the row `id` (for a
 * subprocess row they're equal, but for a Claude invoke the row id is the
 * native session id, which is NOT the invocation id).
 *
 * Everything else kills the tmux session as before.
 */
export function killActionPath(
  session: Pick<EnrichedSession, "id" | "originInvocationId">,
): string {
  return session.originInvocationId
    ? `/invoke/${session.originInvocationId}/cancel`
    : sessionRoute(session.id, "/kill");
}

/**
 * The daemon endpoint path for the "restart" action on a row. A one-shot
 * invoke has no meaningful restart, so an invoke-driven row cancels
 * instead (same clean unwind as kill); everything else restarts.
 */
export function restartActionPath(
  session: Pick<EnrichedSession, "id" | "originInvocationId">,
): string {
  return session.originInvocationId
    ? `/invoke/${session.originInvocationId}/cancel`
    : sessionRoute(session.id, "/restart");
}
