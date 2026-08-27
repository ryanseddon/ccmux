// ccmux-v2-plugin v__CCMUX_VERSION__
import {
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Plugin } from "@opencode-ai/plugin/tui";

export function makePlugin({
  markersDir = join(
    process.env.CCMUX_HOME || join(homedir(), ".config", "ccmux"),
    "session-pids",
  ),
  focusDir = join(
    process.env.CCMUX_HOME || join(homedir(), ".config", "ccmux"),
    "opencode-focus",
  ),
  version,
  now = Date.now,
  pollMs = 250,
}) {
  const uiInstanceId = String(process.pid);
  const markerPaths = new Map();
  const markerSnapshots = new Map();
  let context;
  let refreshing = Promise.resolve();
  let polling = Promise.resolve();

  function markerPath(sessionID) {
    return join(
      markersDir,
      `opencode-v2-${uiInstanceId}-${encodeURIComponent(sessionID)}.json`,
    );
  }

  async function atomicWrite(path, body) {
    const tmp = `${path}.tmp.${process.pid}.${now()}.${Math.random().toString(16).slice(2)}`;
    await writeFile(tmp, body);
    await rename(tmp, path);
  }

  function latestPrompt(sessionID) {
    const pending = context.data.session.pending.list(sessionID);
    const messages = context.data.session.message.list(sessionID);
    const users = [...messages, ...pending]
      .filter(
        (item) =>
          item.type === "user" &&
          typeof (item.text ?? item.payload?.text) === "string",
      )
      .sort(
        (a, b) =>
          (a.time?.created ?? a.timeCreated ?? 0) -
          (b.time?.created ?? b.timeCreated ?? 0),
      );
    return (users.at(-1)?.text ?? users.at(-1)?.payload?.text)
      ?.trim()
      .slice(0, 1024);
  }

  function markerFor(tab) {
    const session = context.data.session.get(tab.sessionID);
    if (!session) return null;
    const permission = context.data.session.permission.list(tab.sessionID)?.[0];
    const form = context.data.session.form.list(
      tab.sessionID,
      session.location,
    )?.[0];
    const state = permission
      ? "waiting_permission"
      : form
        ? "waiting_question"
        : context.data.session.status(tab.sessionID) === "running"
          ? "working"
          : "idle";
    return {
      agent_type: "opencode",
      pid: process.pid,
      ui_instance_id: uiInstanceId,
      session_id: tab.sessionID,
      state,
      directory: session.location.directory,
      title: tab.title ?? session.title,
      focused: tab.active,
      pending_tool: permission?.action ?? null,
      permission_context: permission?.resources?.[0] ?? form?.title ?? null,
      last_prompt: latestPrompt(tab.sessionID),
    };
  }

  async function refresh() {
    const open = new Set();
    for (const tab of context.ui.tabs.list()) {
      const marker = markerFor(tab);
      if (!marker) continue;
      const path = markerPath(tab.sessionID);
      const snapshot = JSON.stringify(marker);
      open.add(tab.sessionID);
      markerPaths.set(tab.sessionID, path);
      if (markerSnapshots.get(tab.sessionID) === snapshot) continue;
      const timestamp = now() / 1000;
      await atomicWrite(
        path,
        JSON.stringify({ ...marker, timestamp, state_timestamp: timestamp }),
      );
      markerSnapshots.set(tab.sessionID, snapshot);
    }
    for (const [sessionID, path] of markerPaths) {
      if (open.has(sessionID)) continue;
      markerPaths.delete(sessionID);
      markerSnapshots.delete(sessionID);
      await unlink(path).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
  }

  function queueRefresh() {
    refreshing = refreshing.then(refresh).catch((error) => {
      console.error("[ccmux-v2-plugin] marker refresh failed", error);
    });
    return refreshing;
  }

  async function pollFocusRequests() {
    const files = await readdir(focusDir).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    for (const file of files) {
      if (!file.endsWith(".request.json")) continue;
      const path = join(focusDir, file);
      try {
        const request = JSON.parse(await readFile(path, "utf8"));
        if (
          request.ui_instance_id !== uiInstanceId ||
          typeof request.session_id !== "string" ||
          typeof request.request_id !== "string" ||
          file !== `${request.request_id}.request.json`
        )
          continue;
        const exists = context.ui.tabs
          .list()
          .some((tab) => tab.sessionID === request.session_id);
        let success = false;
        if (exists) {
          try {
            success = context.ui.tabs.focus(request.session_id) === true;
          } catch {}
        }
        await atomicWrite(
          join(focusDir, `${request.request_id}.ack.json`),
          JSON.stringify({
            request_id: request.request_id,
            ui_instance_id: uiInstanceId,
            session_id: request.session_id,
            success,
          }),
        );
        await unlink(path).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
        if (success) await queueRefresh();
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        console.error(`[ccmux-v2-plugin] focus request ${file} failed`, error);
      }
    }
  }

  return Plugin.define({
    id: "ccmux-v2",
    setup: async (ctx) => {
      context = ctx;
      await Promise.all([
        mkdir(markersDir, { recursive: true }),
        mkdir(focusDir, { recursive: true }),
      ]);
      await queueRefresh();
      const unsubscribe = ctx.data.listen(() => void queueRefresh());
      const interval = setInterval(() => {
        void queueRefresh();
        polling = polling.then(pollFocusRequests).catch((error) => {
          console.error("[ccmux-v2-plugin] focus poll failed", error);
        });
      }, pollMs);
      return async () => {
        unsubscribe();
        clearInterval(interval);
        await polling;
        await refreshing;
        await Promise.all(
          [...markerPaths.values()].map((path) =>
            unlink(path).catch((error) => {
              if (error?.code !== "ENOENT") throw error;
            }),
          ),
        );
        markerPaths.clear();
        markerSnapshots.clear();
      };
    },
  });
}

export default makePlugin({
  version: "__CCMUX_VERSION__",
});
