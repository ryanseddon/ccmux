import rawPluginSource from "../../../plugins/opencode/v2-plugin.js" with { type: "text" };

const pluginSource = rawPluginSource as unknown as string;

interface RenderOpenCodeV2PluginOptions {
  markersDir: string;
  focusDir: string;
  version: string;
}

export function renderOpenCodeV2Plugin(
  opts: RenderOpenCodeV2PluginOptions,
): string {
  return pluginSource
    .replaceAll('"__CCMUX_MARKERS_DIR__"', JSON.stringify(opts.markersDir))
    .replaceAll('"__CCMUX_FOCUS_DIR__"', JSON.stringify(opts.focusDir))
    .replaceAll('"__CCMUX_VERSION__"', JSON.stringify(opts.version))
    .replaceAll("__CCMUX_VERSION__", opts.version);
}

export function getV2PluginSourceForTests(): string {
  return pluginSource;
}
