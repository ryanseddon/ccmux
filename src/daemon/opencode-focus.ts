import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { OPENCODE_FOCUS_DIR } from "../lib/config";

export interface OpenCodeFocusTarget {
  uiInstanceId: string;
  sessionId: string;
}

interface FocusOptions {
  focusDir?: string;
  timeoutMs?: number;
  pollMs?: number;
  requestId?: string;
}

const FOCUS_FILE_RE = /^[^.]+\.(?:request|ack)\.json(?:\.tmp\..+)?$/;
export const STALE_FOCUS_FILE_MS = 5 * 60_000;

export async function cleanupStaleOpenCodeFocusFiles(
  focusDir = OPENCODE_FOCUS_DIR,
  now = Date.now(),
): Promise<void> {
  const files = await readdir(focusDir).catch((error) => {
    if (isENOENT(error)) return [];
    throw error;
  });
  await Promise.all(
    files.filter((file) => FOCUS_FILE_RE.test(file)).map(async (file) => {
      const path = join(focusDir, file);
      try {
        if (now - (await stat(path)).mtimeMs > STALE_FOCUS_FILE_MS) {
          await unlink(path);
        }
      } catch (error) {
        ignoreENOENT(error);
      }
    }),
  );
}

export async function requestOpenCodeFocus(
  target: OpenCodeFocusTarget,
  options: FocusOptions = {},
): Promise<boolean> {
  const focusDir = options.focusDir ?? OPENCODE_FOCUS_DIR;
  const timeoutMs = options.timeoutMs ?? 1500;
  const pollMs = options.pollMs ?? 25;
  const requestId = options.requestId ?? crypto.randomUUID();
  const requestPath = join(focusDir, `${requestId}.request.json`);
  const ackPath = join(focusDir, `${requestId}.ack.json`);
  const tmp = `${requestPath}.tmp.${process.pid}.${Date.now()}`;
  const request = {
    request_id: requestId,
    ui_instance_id: target.uiInstanceId,
    session_id: target.sessionId,
  };

  await mkdir(focusDir, { recursive: true });
  await cleanupStaleOpenCodeFocusFiles(focusDir);
  await writeFile(tmp, JSON.stringify(request), { flag: "wx" });
  await rename(tmp, requestPath);

  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const ack = JSON.parse(await readFile(ackPath, "utf8")) as Record<
          string,
          unknown
        >;
        if (
          (ack.success === true || ack.success === false) &&
          ack.request_id === requestId &&
          ack.ui_instance_id === target.uiInstanceId &&
          ack.session_id === target.sessionId
        ) {
          return ack.success;
        }
        return false;
      } catch (error) {
        if (!(error instanceof SyntaxError) && !isENOENT(error)) return false;
      }
      await Bun.sleep(pollMs);
    }
    return false;
  } finally {
    await Promise.all([
      unlink(requestPath).catch(ignoreENOENT),
      unlink(ackPath).catch(ignoreENOENT),
      unlink(tmp).catch(ignoreENOENT),
    ]);
  }
}

function isENOENT(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function ignoreENOENT(error: unknown): void {
  if (!isENOENT(error)) throw error;
}
