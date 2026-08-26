export interface V2PluginOptions {
  markersDir: string;
  focusDir: string;
  version: string;
  now?: () => number;
  pollMs?: number;
}

export function makePlugin(options: V2PluginOptions): {
  id: string;
  setup(context: unknown): Promise<(() => Promise<void>) | void>;
};

declare const plugin: ReturnType<typeof makePlugin>;
export default plugin;
