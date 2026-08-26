import { beforeEach, describe, expect, it, mock } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";

/** Redirect STATE_FILE to a temp dir so tests don't touch real ~/.config/ccmux/state.json */
const tempRoot = join(
  tmpdir(),
  `ccmux-nohooks-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
);
process.env.CCMUX_HOME = tempRoot;

const actualConfig = await import("../lib/config");
mock.module("../lib/config", () => ({
  ...actualConfig,
  STATE_FILE: join(tempRoot, "state.json"),
}));

import { Daemon } from "./index";
import { BUILTIN_AGENTS } from "../lib/agents";
import { reconcileAll } from "./state-reconciler";
import type { ProcessInfo, TmuxPane } from "../types/session";

type DaemonInternals = {
  agents: typeof BUILTIN_AGENTS;
  claudeRuntimeMode: "claude-with-hooks" | "claude-no-hooks";
  sessionManager: ReturnType<Daemon["getSessionManager"]>;
  watcher: { isRecentlyProcessed(sessionId: string): boolean };
  createOrUpdatePaneTrackedSessions(
    processes: ProcessInfo[],
    panes: TmuxPane[],
  ): Promise<void>;
  resolveNativeSessionId(
    pid: number,
    agent?: (typeof BUILTIN_AGENTS)[number],
  ): Promise<string | undefined>;
  resolvePaneTrackedSessionVersion(
    sessionId: string,
    processCommand: string,
    pid: number,
    agent?: (typeof BUILTIN_AGENTS)[number],
  ): Promise<void>;
};

function fakePane(
  paneId: string,
  tty: string,
  currentPath: string,
  overrides: Partial<TmuxPane> = {},
): TmuxPane {
  return {
    paneId,
    panePid: 1000,
    sessionName: "ccmux",
    windowIndex: 0,
    paneIndex: 0,
    target: `ccmux:0.${paneId.replace("%", "")}`,
    tty,
    startTime: null,
    windowActivity: null,
    paneTitle: "✳ Claude Code",
    currentCommand: "claude",
    currentPath,
    ...overrides,
  };
}

function fakeClaudeProcess(pid: number, tty: string, cwd: string): ProcessInfo {
  return {
    pid,
    command: "claude",
    agentType: "claude",
    tty,
    cwd,
    startTime: Date.now() - 60_000,
  };
}

function fakeProcess(
  agentType: string,
  command: string,
  pid: number,
  tty: string,
  cwd: string,
): ProcessInfo {
  return {
    pid,
    command,
    agentType,
    tty,
    cwd,
    startTime: Date.now() - 60_000,
  };
}

describe("Daemon no-hooks Claude sessions", () => {
  let daemon: Daemon;
  let internals: DaemonInternals;

  beforeEach(() => {
    daemon = new Daemon();
    internals = daemon as unknown as DaemonInternals;
    internals.agents = BUILTIN_AGENTS;
    internals.resolveNativeSessionId = async () => undefined;
    internals.resolvePaneTrackedSessionVersion = async () => {};
  });

  it("creates pane-scoped Claude sessions in no-hooks mode", async () => {
    internals.claudeRuntimeMode = "claude-no-hooks";

    await internals.createOrUpdatePaneTrackedSessions(
      [fakeClaudeProcess(12345, "ttys001", "/Users/test/proj")],
      [fakePane("%1", "/dev/ttys001", "/Users/test/proj")],
    );

    const session = internals.sessionManager.getSession("claude_pane1");
    expect(session).toBeDefined();
    expect(session?.agentType).toBe("claude");
    expect(session?.tmuxPane).toBe("%1");
    expect(session?.pid).toBe(12345);
    expect(session?.cwd).toBe("/Users/test/proj");
  });

  it("does not resolve native session IDs for Claude in no-hooks mode", async () => {
    internals.claudeRuntimeMode = "claude-no-hooks";

    let resolveCalls = 0;
    internals.resolveNativeSessionId = async () => {
      resolveCalls += 1;
      return "native-claude";
    };

    await internals.createOrUpdatePaneTrackedSessions(
      [fakeClaudeProcess(12345, "ttys001", "/Users/test/proj")],
      [fakePane("%1", "/dev/ttys001", "/Users/test/proj")],
    );

    expect(resolveCalls).toBe(0);
    expect(
      internals.sessionManager.getSession("claude_pane1")?.nativeSessionId,
    ).toBeUndefined();
  });

  it("keeps multiple no-hooks Claude panes distinct even in the same cwd", async () => {
    internals.claudeRuntimeMode = "claude-no-hooks";

    await internals.createOrUpdatePaneTrackedSessions(
      [
        fakeClaudeProcess(12345, "ttys001", "/Users/test/proj"),
        fakeClaudeProcess(12346, "ttys002", "/Users/test/proj"),
      ],
      [
        fakePane("%1", "/dev/ttys001", "/Users/test/proj"),
        fakePane("%2", "/dev/ttys002", "/Users/test/proj"),
      ],
    );

    const first = internals.sessionManager.getSession("claude_pane1");
    const second = internals.sessionManager.getSession("claude_pane2");

    expect(first?.pid).toBe(12345);
    expect(second?.pid).toBe(12346);
    expect(first?.cwd).toBe("/Users/test/proj");
    expect(second?.cwd).toBe("/Users/test/proj");
  });

  it("does not create pane-tracked Claude sessions when hooks are enabled", async () => {
    internals.claudeRuntimeMode = "claude-with-hooks";

    await internals.createOrUpdatePaneTrackedSessions(
      [fakeClaudeProcess(12345, "ttys001", "/Users/test/proj")],
      [fakePane("%1", "/dev/ttys001", "/Users/test/proj")],
    );

    expect(internals.sessionManager.getSession("claude_pane1")).toBeUndefined();
  });

  it("still resolves native session IDs for pane-tracked non-Claude agents", async () => {
    internals.claudeRuntimeMode = "claude-no-hooks";

    let resolveCalls = 0;
    internals.resolveNativeSessionId = async () => {
      resolveCalls += 1;
      return "native-codex";
    };

    await internals.createOrUpdatePaneTrackedSessions(
      [fakeProcess("codex", "codex", 22345, "ttys003", "/Users/test/proj")],
      [
        fakePane("%3", "/dev/ttys003", "/Users/test/proj", {
          paneTitle: "Codex",
          currentCommand: "codex",
        }),
      ],
    );

    expect(resolveCalls).toBe(1);
    expect(
      internals.sessionManager.getSession("codex_pane3")?.nativeSessionId,
    ).toBe("native-codex");
  });

  it("does not flap a synthetic OpenCode row when a multiplexed row already occupies the pane", async () => {
    internals.claudeRuntimeMode = "claude-no-hooks";
    internals.sessionManager.createMultiplexedOpenCodeSession({
      uiInstanceId: "marker-pid-9000",
      nativeSessionId: "tab",
      paneId: "%4",
      cwd: "/Users/test/proj",
      pid: 9000,
      focused: true,
      state: { status: "idle" },
    });
    let resolveCalls = 0;
    internals.resolveNativeSessionId = async () => {
      resolveCalls += 1;
      return undefined;
    };

    await internals.createOrUpdatePaneTrackedSessions(
      [fakeProcess("opencode", "opencode-wrapper", 9001, "ttys004", "/Users/test/proj")],
      [fakePane("%4", "/dev/ttys004", "/Users/test/proj")],
    );

    expect(internals.sessionManager.getSession("opencode_pane4")).toBeUndefined();
    expect(internals.sessionManager.getSessions()).toHaveLength(1);
    expect(resolveCalls).toBe(0);
  });

  it("derives state from pane inspection in no-hooks mode", async () => {
    internals.claudeRuntimeMode = "claude-no-hooks";

    await internals.createOrUpdatePaneTrackedSessions(
      [fakeClaudeProcess(12345, "ttys001", "/Users/test/proj")],
      [fakePane("%1", "/dev/ttys001", "/Users/test/proj")],
    );

    const panes = [
      fakePane("%1", "/dev/ttys001", "/Users/test/proj", {
        paneTitle: "⠂ Claude Code",
      }),
    ];
    await reconcileAll(
      {
        sessionManager: internals.sessionManager,
        watcher: internals.watcher,
        hookManager: {
          getMarkerForSession: () => null,
          getMarkersByAgentAndPid: () => [],
        },
        agents: internals.agents,
        logAdapters: new Map(),
        now: Date.now,
        getLogFileMtime: () => 0,
      },
      {
        processes: [fakeClaudeProcess(12345, "ttys001", "/Users/test/proj")],
        panes,
        processTree: { findShellDescendants: () => [] },
      },
    );

    const session = internals.sessionManager.getSession("claude_pane1");
    expect(session?.status).toBe("working");
  });
});
