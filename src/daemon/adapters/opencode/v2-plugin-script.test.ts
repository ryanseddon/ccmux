import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import {
  getV2PluginSourceForTests,
  renderOpenCodeV2Plugin,
} from "./v2-plugin-script";

const root = join(process.cwd(), ".ryan", "tmp", `v2-plugin-${process.pid}`);

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("renderOpenCodeV2Plugin", () => {
  it("renders all install-time values and keeps the V2 sentinel first", () => {
    const output = renderOpenCodeV2Plugin({
      markersDir: '/markers/with"quote',
      focusDir: "/focus",
      version: "3.2.1",
    });
    expect(output.split("\n")[0]).toBe("// ccmux-v2-plugin v3.2.1");
    expect(output).toContain(
      `markersDir: ${JSON.stringify('/markers/with"quote')}`,
    );
    expect(output).toContain('focusDir: "/focus"');
    expect(output).not.toContain("__CCMUX_");
  });

  it("authors the TUI plugin against Plugin.define and tab APIs", () => {
    const source = getV2PluginSourceForTests();
    expect(source).toContain('from "@opencode-ai/plugin/tui"');
    expect(source).toContain("Plugin.define");
    expect(source).toContain("context.ui.tabs.list()");
    expect(source).toContain("context.ui.tabs.focus(");
    expect(source).not.toContain("handledRequests");
  });

  it("reconciles only open tabs, focuses exact requests, acks, and disposes", async () => {
    const markersDir = join(root, "markers");
    const focusDir = join(root, "focus");
    const modulePath = join(root, "plugin.mjs");
    const rendered = renderOpenCodeV2Plugin({
      markersDir,
      focusDir,
      version: "1.0.0",
    }).replace(
      'import { Plugin } from "@opencode-ai/plugin/tui";',
      "const Plugin = { define: (value) => value };",
    );
    writeFileSync(modulePath, rendered);
    const { makePlugin } = await import(modulePath);

    let tabs = [
      { sessionID: "one", title: "One", active: true },
      { sessionID: "two/slash", title: "Two", active: false },
    ];
    const focused: string[] = [];
    let focusSucceeds = true;
    const sessions = new Map([
      [
        "one",
        { id: "one", title: "Stored One", location: { directory: "/one" } },
      ],
      ["two/slash", { id: "two/slash", location: { directory: "/two" } }],
    ]);
    const plugin = makePlugin({
      markersDir,
      focusDir,
      version: "1",
      pollMs: 5,
    });
    const cleanup = await plugin.setup({
      ui: {
        tabs: {
          list: () => tabs,
          focus: (id: string) => {
            if (!tabs.some((tab) => tab.sessionID === id)) return false;
            focused.push(id);
            tabs = tabs.map((tab) => ({
              ...tab,
              active: tab.sessionID === id,
            }));
            return focusSucceeds;
          },
        },
      },
      data: {
        listen: () => () => {},
        session: {
          get: (id: string) => sessions.get(id),
          status: (id: string) => (id === "two/slash" ? "running" : "idle"),
          pending: { list: () => [] },
          message: {
            list: (id: string) =>
              id === "one"
                ? [
                    {
                      type: "user",
                      text: " exact prompt ",
                      time: { created: 1 },
                    },
                  ]
                : [],
          },
          permission: {
            list: (id: string) =>
              id === "one" ? [{ action: "bash", resources: ["ls"] }] : [],
          },
          form: { list: () => [] },
        },
      },
    });

    const files = readdirSync(markersDir).sort();
    expect(files).toHaveLength(2);
    expect(files.some((file) => file.includes("two%2Fslash"))).toBe(true);
    const onePath = join(
      markersDir,
      files.find((file) => file.includes("-one.json"))!,
    );
    const oneBody = readFileSync(onePath, "utf8");
    const one = JSON.parse(oneBody);
    expect(one).toMatchObject({
      ui_instance_id: String(process.pid),
      session_id: "one",
      focused: true,
      directory: "/one",
      title: "One",
      state: "waiting_permission",
      pending_tool: "bash",
      permission_context: "ls",
      last_prompt: "exact prompt",
    });
    await Bun.sleep(15);
    expect(readFileSync(onePath, "utf8")).toBe(oneBody);

    const requestID = "request-1";
    writeFileSync(
      join(focusDir, `${requestID}.request.json`),
      JSON.stringify({
        request_id: requestID,
        ui_instance_id: String(process.pid),
        session_id: "two/slash",
      }),
    );
    await Bun.sleep(30);
    expect(focused).toEqual(["two/slash"]);
    expect(
      JSON.parse(readFileSync(join(focusDir, `${requestID}.ack.json`), "utf8")),
    ).toEqual({
      request_id: requestID,
      ui_instance_id: String(process.pid),
      session_id: "two/slash",
      success: true,
    });
    expect(
      existsSync(join(focusDir, `${requestID}.request.json`)),
    ).toBe(false);

    const missingID = "request-missing";
    writeFileSync(
      join(focusDir, `${missingID}.request.json`),
      JSON.stringify({
        request_id: missingID,
        ui_instance_id: String(process.pid),
        session_id: "not-open",
      }),
    );
    await Bun.sleep(20);
    expect(
      JSON.parse(readFileSync(join(focusDir, `${missingID}.ack.json`), "utf8")),
    ).toMatchObject({
      request_id: missingID,
      session_id: "not-open",
      success: false,
    });
    expect(
      existsSync(join(focusDir, `${missingID}.request.json`)),
    ).toBe(false);

    focusSucceeds = false;
    const failedID = "request-failed";
    writeFileSync(
      join(focusDir, `${failedID}.request.json`),
      JSON.stringify({
        request_id: failedID,
        ui_instance_id: String(process.pid),
        session_id: "one",
      }),
    );
    await Bun.sleep(20);
    expect(
      JSON.parse(readFileSync(join(focusDir, `${failedID}.ack.json`), "utf8")),
    ).toMatchObject({ success: false });
    expect(existsSync(join(focusDir, `${failedID}.request.json`))).toBe(false);

    tabs = tabs.filter((tab) => tab.sessionID !== "one");
    await Bun.sleep(20);
    expect(readdirSync(markersDir)).toHaveLength(1);
    await cleanup();
    expect(existsSync(markersDir)).toBe(true);
    expect(readdirSync(markersDir)).toHaveLength(0);
  });
});
