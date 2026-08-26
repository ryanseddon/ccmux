import type { ProcessInfo, TmuxPane } from "../types/session";
import { CLAUDE_AGENT_DEF } from "../lib/agents";
import { ZOMBIE_STALE_MS } from "../lib/config";
import {
  isBackgroundSession,
  isMultiplexedOpenCodeSession,
  type SessionManager,
} from "./sessions";
import type { ProcessTree } from "./process-tree";
import {
  getSessionTimestampsIn,
  readClaudeHistory,
} from "./adapters/claude/history";
import { getSessionPidMarker, getMarkerPidSnapshot } from "./session-markers";
import { DaemonPerf } from "./perf";
import { discoverAgentProcesses } from "./processes";
import { listTmuxPanes, normalizeTty } from "./pane-discovery";
import {
  decideScanBindings,
  decideNewSessionPane,
  decideStaleCleanup,
  type Binding,
  type NewSessionPaneDecision,
  type SessionSlice,
} from "./binder";

// Pure matching primitives live in the binder module (the single owner of
// matching policy); re-exported here so existing imports keep working.
export { encodeProjectPath, type ProcPaneMatch } from "./binder";

/**
 * Match sessions to tmux panes based on TTY.
 * Thin wrapper over the binder's scan decision (ladder 1): builds the
 * observation, lets the pure binder decide, applies the bindings in order.
 * The SessionManager's own no-op guards make unconditional setter calls
 * equivalent to the pre-binder conditional ones.
 */
export function matchSessionsToPanes(
  manager: SessionManager,
  agentProcesses: ProcessInfo[],
  panes: TmuxPane[],
  processTree?: ProcessTree,
): void {
  DaemonPerf.incFindIterations(panes.length + agentProcesses.length);

  const sessions: SessionSlice[] = manager
    .getSessions()
    .filter((s) => !isMultiplexedOpenCodeSession(s))
    .map((s) => ({
      id: s.id,
      agentType: s.agentType,
      cwd: s.cwd,
      tmuxPane: s.tmuxPane,
      pid: s.pid,
      isBackground: isBackgroundSession(s),
    }));

  const bindings: Binding[] = decideScanBindings({
    sessions,
    processes: agentProcesses,
    panes,
    processTree,
    markerPidBySessionId: getMarkerPidSnapshot(),
  });

  for (const binding of bindings) {
    if (binding.paneId !== null) {
      manager.setTmuxPane(binding.sessionId, binding.paneId);
    }
    if (binding.pid !== null) {
      manager.setPid(binding.sessionId, binding.pid);
    }
  }
}

/**
 * Clean up sessions without active agent processes or with dead tmux panes.
 * Thin wrapper over the binder's pure `decideStaleCleanup` (branch logic and
 * the per-session rules documented there). Destructive transitions carry
 * two-scan hysteresis: `pending` is the previous scan's
 * unconfirmed proposals, and the returned set is this scan's — the caller
 * holds it across scans. Passing an empty set therefore never destroys
 * anything on the first call.
 */
export function cleanupStaleSessions(
  manager: SessionManager,
  agentProcesses: ProcessInfo[],
  panes: TmuxPane[],
  pending: ReadonlySet<string>,
): Set<string> {
  const decision = decideStaleCleanup(
    {
      sessions: manager.getSessions().map((s) => ({
        id: s.id,
        agentType: s.agentType,
        cwd: s.cwd,
        tmuxPane: s.tmuxPane,
        pid: s.pid,
        isBackground: isBackgroundSession(s),
        updatedAtMs: s.updatedAt.getTime(),
      })),
      processes: agentProcesses,
      panes,
      nowMs: Date.now(),
      zombieStaleMs: ZOMBIE_STALE_MS,
    },
    pending,
  );

  for (const sessionId of decision.unbinds) {
    manager.setTmuxPane(sessionId, null);
  }
  for (const sessionId of decision.removals) {
    manager.removeSession(sessionId);
  }

  return decision.nextPending;
}

/**
 * Find tmux pane using session PID marker (authoritative when hooks are configured)
 * Returns the pane matching the marker's PID/TTY, or null if no marker exists
 */
export async function findPaneByMarker(
  sessionId: string,
): Promise<TmuxPane | null> {
  const marker = getSessionPidMarker(sessionId);
  if (!marker) return null;

  const panes = await listTmuxPanes();
  const normalizedMarkerTty = normalizeTty(marker.tty);

  // Match by TTY (most reliable). OpenCode markers have no TTY, so this
  // pass no-ops for them; the PID fallback below picks them up.
  if (normalizedMarkerTty) {
    for (const pane of panes) {
      const normalizedPaneTty = normalizeTty(pane.tty);
      if (normalizedPaneTty === normalizedMarkerTty) {
        return pane;
      }
    }
  }

  // Fallback: match by PID
  const claudeProcs = await discoverAgentProcesses([CLAUDE_AGENT_DEF]);
  const matchingProc = claudeProcs.find((p) => p.pid === marker.pid);
  if (matchingProc?.tty) {
    const normalizedProcTty = normalizeTty(matchingProc.tty);
    for (const pane of panes) {
      if (normalizeTty(pane.tty) === normalizedProcTty) {
        return pane;
      }
    }
  }

  return null;
}

/**
 * Find the tmux pane for a newly created session. Thin wrapper over the
 * binder's ladder-2 decision (assignment-gated): gathers the
 * observation (process + pane discovery, existing sessions' claims, one
 * history.jsonl read) and returns the decision. `ambiguous` means the
 * caller should create the session visibly UNBOUND rather than bind
 * a guess; `none` means no eligible candidate.
 *
 * @param encodedProjectPath - The encoded project path from the log file
 * @param sessionId - Session ID whose history timestamps gate the match
 * @param transcriptCwd - Raw cwd from the transcript, when known
 */
export async function findPaneForNewSession(
  manager: SessionManager,
  encodedProjectPath: string,
  sessionId: string,
  transcriptCwd: string | null,
): Promise<NewSessionPaneDecision> {
  const [claudeProcs, panes] = await Promise.all([
    discoverAgentProcesses([CLAUDE_AGENT_DEF]),
    listTmuxPanes(),
  ]);

  const historyEntries = readClaudeHistory();

  return decideNewSessionPane({
    processes: claudeProcs,
    panes,
    sessionId,
    encodedProjectPath,
    transcriptCwd,
    getSessionTimestamps: (id, projectPath) =>
      getSessionTimestampsIn(historyEntries, id, projectPath),
    sessions: manager.getSessions().map((s) => ({
      tmuxPane: s.tmuxPane,
      pid: s.pid,
    })),
  });
}
