import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import {
  OPENCODE_CLI_CONFIG_FILE,
  OPENCODE_CONFIG_DIR,
  OPENCODE_PLUGIN_DIR,
  OPENCODE_PLUGIN_FILE,
  OPENCODE_V2_LEGACY_PLUGIN_CONFIG_PATH,
  OPENCODE_V2_LEGACY_PLUGIN_FILE,
  OPENCODE_V2_PLUGIN_CONFIG_PATH,
  OPENCODE_V2_PLUGIN_DIR,
  OPENCODE_V2_PLUGIN_FILE,
} from "../../../lib/config";
import pkg from "../../../../package.json" with { type: "json" };
import { aggregateOpenCodeMarkers } from "./aggregate";
import {
  findPaneTrackedSession,
  type HookAdapter,
  type HookAdapterOutcome,
  type HookManagerContext,
} from "../../hook-adapter";
import { renderOpenCodePlugin } from "./plugin-script";
import { renderOpenCodeV2Plugin } from "./v2-plugin-script";
import {
  filterMarkerCache,
  type SessionPidMarker,
} from "../../session-markers";
import { markerStatusState } from "../../cascade-evaluator";
import {
  deriveMultiplexedOpenCodeSessionId,
  isMultiplexedOpenCodeSession,
} from "../../sessions";
import { isAbsolute, relative } from "path";

const CCMUX_VERSION: string = pkg.version;

const SENTINEL_PREFIX = "// ccmux-plugin v";
const SENTINEL_REGEX = /^\/\/ ccmux-plugin v(\S+)/;
const V2_SENTINEL_PREFIX = "// ccmux-v2-plugin v";
const V2_SENTINEL_REGEX = /^\/\/ ccmux-v2-plugin v(\S+)/;

interface MultiplexedCandidate {
  marker: SessionPidMarker;
  pane: NonNullable<
    Awaited<ReturnType<HookManagerContext["getPaneHostingPid"]>>
  >;
}

function directoryRank(candidate: MultiplexedCandidate): number {
  const directory = candidate.marker.directory;
  const paneCwd = candidate.pane.currentPath;
  if (!directory || !paneCwd) return 0;
  if (paneCwd === directory) return 2;
  const child = relative(directory, paneCwd);
  return child !== "" &&
    child !== ".." &&
    !child.startsWith("../") &&
    !isAbsolute(child)
    ? 1
    : 0;
}

function compareMultiplexedCandidates(
  a: MultiplexedCandidate,
  b: MultiplexedCandidate,
): number {
  const directory = directoryRank(b) - directoryRank(a);
  if (directory !== 0) return directory;
  const focused =
    Number(Boolean(b.marker.focused)) - Number(Boolean(a.marker.focused));
  if (focused !== 0) return focused;
  const activity =
    (b.marker.state_timestamp ?? b.marker.timestamp) -
    (a.marker.state_timestamp ?? a.marker.timestamp);
  if (activity !== 0) return activity;
  const ui = (a.marker.ui_instance_id ?? "").localeCompare(
    b.marker.ui_instance_id ?? "",
  );
  if (ui !== 0) return ui;
  const pid = a.marker.pid - b.marker.pid;
  if (pid !== 0) return pid;
  return a.pane.paneId.localeCompare(b.pane.paneId);
}

function inspectInstalledPlugin(
  path: string,
  sentinel = SENTINEL_REGEX,
): {
  exists: boolean;
  owned: boolean;
  version: string | null;
} {
  if (!existsSync(path)) return { exists: false, owned: false, version: null };
  let firstLine: string;
  try {
    firstLine = readFileSync(path, "utf-8").split("\n", 1)[0];
  } catch {
    return { exists: true, owned: false, version: null };
  }
  const match = firstLine.match(sentinel);
  if (!match) return { exists: true, owned: false, version: null };
  return { exists: true, owned: true, version: match[1] };
}

type CliConfig = Record<string, unknown> & { plugins?: string[] };

function readCliConfig(): CliConfig | null {
  if (!existsSync(OPENCODE_CLI_CONFIG_FILE)) return {};
  try {
    const parsed = JSON.parse(
      readFileSync(OPENCODE_CLI_CONFIG_FILE, "utf8"),
    ) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    const config = parsed as CliConfig;
    if (
      config.plugins !== undefined &&
      (!Array.isArray(config.plugins) ||
        config.plugins.some((entry) => typeof entry !== "string"))
    ) {
      return null;
    }
    return config;
  } catch {
    return null;
  }
}

function writeCliConfig(config: CliConfig): void {
  mkdirSync(OPENCODE_CONFIG_DIR, { recursive: true });
  const tmp = `${OPENCODE_CLI_CONFIG_FILE}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(tmp, OPENCODE_CLI_CONFIG_FILE);
}

function hasV2Registration(config: CliConfig | null): boolean {
  return config?.plugins?.includes(OPENCODE_V2_PLUGIN_CONFIG_PATH) ?? false;
}

function hasLegacyV2Registration(config: CliConfig | null): boolean {
  return (
    config?.plugins?.includes(OPENCODE_V2_LEGACY_PLUGIN_CONFIG_PATH) ?? false
  );
}

function migrateV2Registration(config: CliConfig): boolean {
  const plugins: string[] = [];
  let hasCurrent = false;
  for (const entry of config.plugins ?? []) {
    const migrated =
      entry === OPENCODE_V2_LEGACY_PLUGIN_CONFIG_PATH
        ? OPENCODE_V2_PLUGIN_CONFIG_PATH
        : entry;
    if (migrated === OPENCODE_V2_PLUGIN_CONFIG_PATH) {
      if (hasCurrent) continue;
      hasCurrent = true;
    }
    plugins.push(migrated);
  }
  if (!hasCurrent) {
    plugins.push(OPENCODE_V2_PLUGIN_CONFIG_PATH);
  }
  if (JSON.stringify(plugins) === JSON.stringify(config.plugins ?? [])) {
    return false;
  }
  config.plugins = plugins;
  return true;
}

/**
 * OpenCode plugin-based hook integration.
 *
 * Unlike Claude/Codex, there are no shell scripts to install. `install()`
 * writes a single JS file to OpenCode's auto-discovered plugin directory;
 * `uninstall()` unlinks it. The plugin's first line carries a sentinel
 * (`// ccmux-plugin v<version>`) so we can confirm ownership before
 * overwriting or deleting.
 *
 * Marker lifecycle is driven by the plugin: on every OpenCode bus event
 * it rewrites a `opencode-<session_id>.json` marker. The adapter reads
 * those markers (via `filterMarkerCache`) and folds the N-per-server set
 * into the single ccmux Session for the hosting tmux pane.
 */
export class OpenCodePluginAdapter implements HookAdapter {
  readonly agentType = "opencode";

  async install(): Promise<HookAdapterOutcome> {
    const lines: string[] = [];
    let changed = false;

    const inspection = inspectInstalledPlugin(OPENCODE_PLUGIN_FILE);
    if (inspection.exists && !inspection.owned) {
      // Matches Codex's "advisory, keep going" posture so a combined
      // `ccmux setup` invocation can still install Claude/Codex hooks.
      lines.push(
        `Skipped ${OPENCODE_PLUGIN_FILE}: first line does not start with "${SENTINEL_PREFIX}".`,
      );
      lines.push(
        "Move the existing file aside and re-run `ccmux setup --agent opencode` to install.",
      );
    } else {
      mkdirSync(OPENCODE_PLUGIN_DIR, { recursive: true });

      const source = renderOpenCodePlugin({
        version: CCMUX_VERSION,
      });
      const tmp = `${OPENCODE_PLUGIN_FILE}.tmp.${process.pid}.${Date.now()}`;
      writeFileSync(tmp, source);
      renameSync(tmp, OPENCODE_PLUGIN_FILE);
      changed = true;

      lines.push(
        inspection.exists
          ? `Updated plugin: ${OPENCODE_PLUGIN_FILE} (was v${inspection.version ?? "unknown"}, now v${CCMUX_VERSION})`
          : `Created plugin: ${OPENCODE_PLUGIN_FILE}`,
      );
      lines.push("OpenCode will auto-discover the plugin on next launch.");
    }

    const cliConfig = readCliConfig();
    if (!cliConfig) {
      lines.push(
        `Skipped OpenCode V2 setup: ${OPENCODE_CLI_CONFIG_FILE} is not strict JSON with a string-array "plugins" field.`,
      );
      lines.push(
        "Preserving the existing config; register the V2 plugin manually.",
      );
    } else {
      const v2Inspection = inspectInstalledPlugin(
        OPENCODE_V2_PLUGIN_FILE,
        V2_SENTINEL_REGEX,
      );
      const legacyV2Inspection = inspectInstalledPlugin(
        OPENCODE_V2_LEGACY_PLUGIN_FILE,
        V2_SENTINEL_REGEX,
      );
      if (v2Inspection.exists && !v2Inspection.owned) {
        lines.push(
          `Skipped ${OPENCODE_V2_PLUGIN_FILE}: first line does not start with "${V2_SENTINEL_PREFIX}".`,
        );
      } else {
        mkdirSync(OPENCODE_V2_PLUGIN_DIR, { recursive: true });
        const v2Source = renderOpenCodeV2Plugin({
          version: CCMUX_VERSION,
        });
        const v2Tmp = `${OPENCODE_V2_PLUGIN_FILE}.tmp.${process.pid}.${Date.now()}`;
        writeFileSync(v2Tmp, v2Source);
        renameSync(v2Tmp, OPENCODE_V2_PLUGIN_FILE);
        changed = true;
        if (migrateV2Registration(cliConfig)) {
          writeCliConfig(cliConfig);
          changed = true;
        }
        if (legacyV2Inspection.owned) {
          unlinkSync(OPENCODE_V2_LEGACY_PLUGIN_FILE);
          lines.push(
            `Removed legacy OpenCode V2 TUI plugin: ${OPENCODE_V2_LEGACY_PLUGIN_FILE}`,
          );
        } else if (legacyV2Inspection.exists) {
          lines.push(
            `Skipped foreign legacy V2 plugin: ${OPENCODE_V2_LEGACY_PLUGIN_FILE}`,
          );
        }
        lines.push(
          `Installed OpenCode V2 TUI plugin: ${OPENCODE_V2_PLUGIN_FILE}`,
        );
      }
    }
    lines.push("Restart any running OpenCode sessions to pick up the plugin.");
    return { lines, changed };
  }

  async uninstall(): Promise<HookAdapterOutcome> {
    const lines: string[] = [];
    let changed = false;
    const inspection = inspectInstalledPlugin(OPENCODE_PLUGIN_FILE);
    if (!inspection.exists) {
      lines.push(`No ccmux plugin at ${OPENCODE_PLUGIN_FILE}.`);
    } else if (!inspection.owned) {
      lines.push(
        `Skipped ${OPENCODE_PLUGIN_FILE}: first line does not start with "${SENTINEL_PREFIX}". ` +
          "Refusing to delete a file ccmux did not write.",
      );
    } else {
      unlinkSync(OPENCODE_PLUGIN_FILE);
      changed = true;
      lines.push(`Removed ${OPENCODE_PLUGIN_FILE}`);
    }

    const cliConfig = readCliConfig();
    if (!cliConfig) {
      lines.push(
        `Skipped OpenCode V2 removal: ${OPENCODE_CLI_CONFIG_FILE} could not be safely modified.`,
      );
    } else {
      const plugins = cliConfig.plugins ?? [];
      cliConfig.plugins = plugins.filter(
        (entry) =>
          entry !== OPENCODE_V2_PLUGIN_CONFIG_PATH &&
          entry !== OPENCODE_V2_LEGACY_PLUGIN_CONFIG_PATH,
      );
      if (cliConfig.plugins.length !== plugins.length) {
        writeCliConfig(cliConfig);
        changed = true;
        lines.push(
          `Removed V2 plugin registrations from ${OPENCODE_CLI_CONFIG_FILE}`,
        );
      }
    }
    for (const path of [
      OPENCODE_V2_PLUGIN_FILE,
      OPENCODE_V2_LEGACY_PLUGIN_FILE,
    ]) {
      const v2Inspection = inspectInstalledPlugin(path, V2_SENTINEL_REGEX);
      if (v2Inspection.owned) {
        unlinkSync(path);
        changed = true;
        lines.push(`Removed ${path}`);
      } else if (v2Inspection.exists) {
        lines.push(`Skipped foreign V2 plugin: ${path}`);
      }
    }
    lines.push(
      "Marker files under ~/.config/ccmux/session-pids/ will be swept on the next daemon cycle.",
    );
    return { lines, changed };
  }

  isInstalled(): boolean {
    return inspectInstalledPlugin(OPENCODE_PLUGIN_FILE).owned;
  }

  describeInstallDetail(): string | null {
    const inspection = inspectInstalledPlugin(OPENCODE_PLUGIN_FILE);
    if (!inspection.owned || !inspection.version) return null;
    return inspection.version === CCMUX_VERSION
      ? `(plugin v${inspection.version}, matches running ccmux)`
      : `(plugin v${inspection.version})`;
  }

  describeInstallAnomalies(): string[] {
    const inspection = inspectInstalledPlugin(OPENCODE_PLUGIN_FILE);
    if (!inspection.owned) return [];
    const warnings: string[] = [];
    if (inspection.version && inspection.version !== CCMUX_VERSION) {
      warnings.push(
        `OpenCode: plugin at ${OPENCODE_PLUGIN_FILE} is v${inspection.version} but ccmux is v${CCMUX_VERSION}. ` +
          "Run `ccmux setup --agent opencode` to update.",
      );
    }
    const v2 = inspectInstalledPlugin(
      OPENCODE_V2_PLUGIN_FILE,
      V2_SENTINEL_REGEX,
    );
    const config = readCliConfig();
    const legacy = inspectInstalledPlugin(
      OPENCODE_V2_LEGACY_PLUGIN_FILE,
      V2_SENTINEL_REGEX,
    );
    if (!v2.owned || !hasV2Registration(config)) {
      warnings.push(
        "OpenCode V2 TUI integration is not fully registered; run `ccmux setup --agent opencode`.",
      );
    }
    if (legacy.owned || hasLegacyV2Registration(config)) {
      warnings.push(
        `OpenCode V2 TUI integration uses legacy path ${OPENCODE_V2_LEGACY_PLUGIN_CONFIG_PATH}; run \`ccmux setup --agent opencode\` to migrate.`,
      );
    }
    return warnings;
  }

  isSessionStillLive(_marker: SessionPidMarker): boolean {
    // OpenCode has no per-session log to check. The generic PID-liveness
    // sweep in `cleanupStaleMarkers` is the whole story for us.
    return true;
  }

  async onMarkerAdded(
    marker: SessionPidMarker,
    ctx: HookManagerContext,
  ): Promise<void> {
    if (marker.ui_instance_id) {
      await this.syncMultiplexed(ctx);
      return;
    }
    await this.reaggregate(marker, ctx);
  }

  async onMarkerRemoved(
    marker: SessionPidMarker,
    ctx: HookManagerContext,
  ): Promise<void> {
    if (marker.ui_instance_id) {
      await this.syncMultiplexed(ctx, marker);
      return;
    }
    // Cache eviction for an unlinked marker happens on the next scan's
    // refreshMarkerCache, so the just-removed marker may still be in the
    // cache. Filter it out so the aggregate reflects reality.
    await this.reaggregate(marker, ctx, marker.session_id);
  }

  async onMarkerChanged(
    marker: SessionPidMarker,
    ctx: HookManagerContext,
  ): Promise<void> {
    if (marker.ui_instance_id) {
      await this.syncMultiplexed(ctx);
      return;
    }
    // Re-aggregate by server PID rather than session id. Closes the
    // non-winning-sibling gap from the generic resolver: when an
    // OpenCode plugin rewrites any sibling's marker (winning or not),
    // the daemon's `resolveSessionForMarkerEvent(marker.session_id)`
    // would miss for non-winning siblings since `nativeSessionId` only
    // stores the winning marker's id. The adapter has no such issue:
    // `reaggregate` maps `marker.pid` -> pane -> ccmux session in one
    // step.
    await this.reaggregate(marker, ctx);
  }

  async syncMarkers(ctx: HookManagerContext): Promise<void> {
    await this.syncMultiplexed(ctx);
  }

  private async syncMultiplexed(
    ctx: HookManagerContext,
    excluded?: SessionPidMarker,
  ): Promise<void> {
    const markers = filterMarkerCache(
      (marker) =>
        marker.agent_type === this.agentType &&
        marker.ui_instance_id !== undefined &&
        !(
          excluded &&
          marker.ui_instance_id === excluded.ui_instance_id &&
          marker.session_id === excluded.session_id
        ),
    );
    const desired = new Set<string>();
    const hostedPanes = new Set<string>();

    const panes = new Map<
      number,
      Awaited<ReturnType<HookManagerContext["getPaneHostingPid"]>>
    >();
    await Promise.all(
      [...new Set(markers.map((marker) => marker.pid))].map(async (pid) => {
        panes.set(pid, await ctx.getPaneHostingPid(pid));
      }),
    );

    const byNativeSession = new Map<string, SessionPidMarker[]>();
    for (const marker of markers) {
      const group = byNativeSession.get(marker.session_id);
      if (group) group.push(marker);
      else byNativeSession.set(marker.session_id, [marker]);
    }

    for (const [nativeSessionId, group] of byNativeSession) {
      const id = deriveMultiplexedOpenCodeSessionId(nativeSessionId);
      desired.add(id);
      const candidates = group
        .map((marker) => ({ marker, pane: panes.get(marker.pid) }))
        .filter(
          (
            candidate,
          ): candidate is {
            marker: SessionPidMarker;
            pane: NonNullable<typeof candidate.pane>;
          } => candidate.pane !== null && candidate.pane !== undefined,
        )
        .sort((a, b) => compareMultiplexedCandidates(a, b));
      // Pane discovery may transiently miss every live process. Retain the
      // stable native-session row until its final marker disappears, but as
      // soon as another marker resolves it becomes the routing failover.
      const chosen = candidates[0];
      if (!chosen) continue;
      const { marker, pane } = chosen;
      if (!marker.ui_instance_id) continue;
      const state = markerStatusState(marker);
      const cwd = marker.directory ?? pane.currentPath;
      if (!cwd) continue;
      hostedPanes.add(pane.paneId);
      const session = ctx.sessionManager.createMultiplexedOpenCodeSession({
        uiInstanceId: marker.ui_instance_id,
        nativeSessionId: marker.session_id,
        paneId: pane.paneId,
        cwd,
        pid: marker.pid,
        title: marker.title,
        focused: marker.focused,
        state: {
          ...state,
          attentionType: marker.focused ? state.attentionType : null,
          pendingTool: marker.focused ? state.pendingTool : null,
          lastActivityAt: new Date(
            (marker.state_timestamp ?? marker.timestamp) * 1000,
          ).toISOString(),
          lastPrompt: marker.last_prompt ?? null,
        },
      });
      if (!marker.focused) {
        ctx.sessionManager.setAttentionState(session.id, null);
      }
    }

    for (const session of ctx.sessionManager.getSessions()) {
      if (isMultiplexedOpenCodeSession(session) && !desired.has(session.id)) {
        ctx.sessionManager.removeSession(session.id);
      } else if (
        session.agentType === this.agentType &&
        session.trackingMode === "pane" &&
        session.tmuxPane !== null &&
        hostedPanes.has(session.tmuxPane)
      ) {
        ctx.sessionManager.removeSession(session.id);
      }
    }
  }

  private async reaggregate(
    marker: SessionPidMarker,
    ctx: HookManagerContext,
    excludeSessionId?: string,
  ): Promise<void> {
    const target = await this.findTargetSession(marker.pid, ctx);
    if (!target) return;
    const siblings = filterMarkerCache(
      (m) =>
        m.agent_type === this.agentType &&
        m.ui_instance_id === undefined &&
        m.pid === marker.pid &&
        m.session_id !== excludeSessionId,
    );
    this.applyAggregate(target.sessionId, siblings, ctx);
  }

  private async findTargetSession(
    pid: number,
    ctx: HookManagerContext,
  ): Promise<{ sessionId: string } | null> {
    const pane = await ctx.getPaneHostingPid(pid);
    if (!pane) return null;
    const session = findPaneTrackedSession(ctx, this.agentType, pane.paneId);
    return session ? { sessionId: session.id } : null;
  }

  private applyAggregate(
    sessionId: string,
    siblings: SessionPidMarker[],
    ctx: HookManagerContext,
  ): void {
    const aggregate = aggregateOpenCodeMarkers(siblings);
    const { nativeSessionId, ...state } = aggregate;
    ctx.sessionManager.updateSession(sessionId, state);
    if (nativeSessionId) {
      // Marker-backed, so reclaim: a heuristic holder of this
      // id is stripped and the id re-routes here.
      ctx.sessionManager.setNativeSessionId(sessionId, nativeSessionId, {
        reclaim: true,
      });
    }
  }
}
