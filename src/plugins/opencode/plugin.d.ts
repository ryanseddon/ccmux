/**
 * Type surface for the authored JS plugin. The real implementation lives
 * in `plugin.js`; this file is solely for TypeScript callers (tests,
 * the renderer). Kept intentionally loose: the plugin talks to
 * OpenCode's runtime whose types are not in our dependency graph.
 */

export interface MakePluginOptions {
  markersDir?: string;
  version: string;
  now?: () => number;
}

export interface OpencodeBusEvent {
  type: string;
  properties: unknown;
}

export interface OpencodePluginHooks {
  event: (input: { event: OpencodeBusEvent }) => Promise<void>;
}

export interface OpencodePluginInput {
  client: {
    session: {
      list: (opts?: { query?: { directory?: string } }) => Promise<{
        data?: Array<{ id: string; directory: string; title: string }>;
      }>;
      status: (opts?: { query?: { directory?: string } }) => Promise<{
        data?: Record<string, { type: "idle" | "busy" | "retry" } | undefined>;
      }>;
    };
  };
  directory?: string;
}

export type OpencodePlugin = ((
  input: OpencodePluginInput,
) => Promise<OpencodePluginHooks>) & { version: string };

export function makePlugin(opts: MakePluginOptions): OpencodePlugin;

declare const ccmuxPlugin: OpencodePlugin;
export default ccmuxPlugin;
