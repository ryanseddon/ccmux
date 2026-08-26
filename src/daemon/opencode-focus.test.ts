import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import {
  cleanupStaleOpenCodeFocusFiles,
  requestOpenCodeFocus,
  STALE_FOCUS_FILE_MS,
} from "./opencode-focus";

const root = join(process.cwd(), ".ryan", "tmp", `focus-${process.pid}`);

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("requestOpenCodeFocus", () => {
  it("writes a unique atomic request, accepts an exact ack, then cleans both", async () => {
    const pending = requestOpenCodeFocus(
      { uiInstanceId: "42", sessionId: "ses-a" },
      { focusDir: root, requestId: "unique", timeoutMs: 500, pollMs: 5 },
    );
    const requestPath = join(root, "unique.request.json");
    for (let i = 0; i < 20 && !existsSync(requestPath); i++) await Bun.sleep(5);
    expect(JSON.parse(readFileSync(requestPath, "utf8"))).toEqual({
      request_id: "unique",
      ui_instance_id: "42",
      session_id: "ses-a",
    });
    writeFileSync(
      join(root, "unique.ack.json"),
      JSON.stringify({
        request_id: "unique",
        ui_instance_id: "42",
        session_id: "ses-a",
        success: true,
      }),
    );
    expect(await pending).toBe(true);
    expect(existsSync(requestPath)).toBe(false);
    expect(existsSync(join(root, "unique.ack.json"))).toBe(false);
  });

  it("rejects a mismatched ack and cleans up", async () => {
    const pending = requestOpenCodeFocus(
      { uiInstanceId: "42", sessionId: "ses-a" },
      { focusDir: root, requestId: "wrong", timeoutMs: 500, pollMs: 5 },
    );
    const requestPath = join(root, "wrong.request.json");
    for (let i = 0; i < 20 && !existsSync(requestPath); i++) await Bun.sleep(5);
    writeFileSync(
      join(root, "wrong.ack.json"),
      JSON.stringify({
        request_id: "wrong",
        ui_instance_id: "other",
        session_id: "ses-a",
        success: true,
      }),
    );
    expect(await pending).toBe(false);
    expect(existsSync(requestPath)).toBe(false);
  });

  it("accepts an exact negative ack immediately", async () => {
    const started = Date.now();
    const pending = requestOpenCodeFocus(
      { uiInstanceId: "42", sessionId: "missing" },
      { focusDir: root, requestId: "negative", timeoutMs: 500, pollMs: 5 },
    );
    const requestPath = join(root, "negative.request.json");
    for (let i = 0; i < 20 && !existsSync(requestPath); i++) await Bun.sleep(5);
    writeFileSync(
      join(root, "negative.ack.json"),
      JSON.stringify({
        request_id: "negative",
        ui_instance_id: "42",
        session_id: "missing",
        success: false,
      }),
    );
    expect(await pending).toBe(false);
    expect(Date.now() - started).toBeLessThan(300);
  });

  it("rejects non-boolean success in an otherwise exact ack", async () => {
    const pending = requestOpenCodeFocus(
      { uiInstanceId: "42", sessionId: "ses-a" },
      { focusDir: root, requestId: "loose", timeoutMs: 500, pollMs: 5 },
    );
    const requestPath = join(root, "loose.request.json");
    for (let i = 0; i < 20 && !existsSync(requestPath); i++) await Bun.sleep(5);
    writeFileSync(
      join(root, "loose.ack.json"),
      JSON.stringify({
        request_id: "loose",
        ui_instance_id: "42",
        session_id: "ses-a",
        success: "true",
      }),
    );
    expect(await pending).toBe(false);
  });

  it("times out without optimistic success and removes its request", async () => {
    expect(
      await requestOpenCodeFocus(
        { uiInstanceId: "42", sessionId: "missing" },
        { focusDir: root, requestId: "timeout", timeoutMs: 20, pollMs: 5 },
      ),
    ).toBe(false);
    expect(existsSync(join(root, "timeout.request.json"))).toBe(false);
  });

  it("removes stale focus request, ack, and temp files only", async () => {
    const stale = [
      "old.request.json",
      "old.ack.json",
      "old.request.json.tmp.1.2",
    ];
    for (const file of [...stale, "fresh.request.json", "unrelated.json"]) {
      const path = join(root, file);
      writeFileSync(path, "{}");
      if (stale.includes(file)) {
        const old = new Date(Date.now() - STALE_FOCUS_FILE_MS - 1_000);
        utimesSync(path, old, old);
      }
    }

    await cleanupStaleOpenCodeFocusFiles(root);

    for (const file of stale) expect(existsSync(join(root, file))).toBe(false);
    expect(existsSync(join(root, "fresh.request.json"))).toBe(true);
    expect(existsSync(join(root, "unrelated.json"))).toBe(true);
  });
});
