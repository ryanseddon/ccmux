import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { renderOpenCodePlugin, getPluginSourceForTests } from "./plugin-script";

let tempRoot: string;

beforeEach(() => {
  tempRoot = join(
    tmpdir(),
    `ccmux-render-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(tempRoot, { recursive: true });
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("renderOpenCodePlugin", () => {
  const render = (version: string) => renderOpenCodePlugin({ version });

  it("keeps runtime path resolution portable", () => {
    const out = render("1.0.0");
    expect(out).toContain("process.env.CCMUX_HOME");
    expect(out).toContain('join(homedir(), ".config", "ccmux")');
    expect(out).not.toMatch(/\/(Users|home)\//);
  });

  it("substitutes the version in both the sentinel comment and the constant", () => {
    const out = render("2.4.1");
    expect(out.split("\n")[0]).toBe("// ccmux-plugin v2.4.1");
    expect(out).toContain('version: "2.4.1"');
    expect(out).not.toContain("__CCMUX_VERSION__");
  });

  it("keeps the sentinel header as the first line for install/uninstall checks", () => {
    const out = render("9.9.9");
    const firstLine = out.split("\n", 1)[0];
    expect(firstLine).toMatch(/^\/\/ ccmux-plugin v\d+\.\d+\.\d+/);
  });

  it("is idempotent: rendering twice with the same input gives the same output", () => {
    const a = render("1.0.0");
    const b = render("1.0.0");
    expect(a).toBe(b);
  });

  it("rendered output can be imported and executed as a real module", async () => {
    const out = render("1.0.0");
    const pluginPath = join(tempRoot, "rendered.mjs");
    writeFileSync(pluginPath, out);
    const mod = await import(pluginPath);
    expect(typeof mod.makePlugin).toBe("function");
    expect(typeof mod.default).toBe("function");
    expect(mod.default.version).toBe("1.0.0");
  });

  it("does not accidentally substitute bare tokens that are part of another word", () => {
    // The sentinels are prefixed with `__` which is unlikely to appear
    // mid-identifier, but assert the rendered output contains no stray
    // CCMUX_VERSION / CCMUX_MARKERS_DIR fragments at all.
    const out = render("1.0.0");
    expect(out.includes("CCMUX_VERSION")).toBe(false);
  });
});

describe("getPluginSourceForTests", () => {
  it("returns raw authored source with only the version sentinel", () => {
    const src = getPluginSourceForTests();
    expect(src).toContain('"__CCMUX_VERSION__"');
    expect(src).toContain("// ccmux-plugin v__CCMUX_VERSION__");
    expect(src).not.toContain("__CCMUX_MARKERS_DIR__");
  });
});
