import rawPluginSource from "../../../plugins/opencode/v2-plugin.js" with { type: "text" };

const pluginSource = rawPluginSource as unknown as string;

interface RenderOpenCodeV2PluginOptions {
  version: string;
}

export function renderOpenCodeV2Plugin(
  opts: RenderOpenCodeV2PluginOptions,
): string {
  return pluginSource
    .replaceAll('"__CCMUX_VERSION__"', JSON.stringify(opts.version))
    .replaceAll("__CCMUX_VERSION__", opts.version);
}

export function getV2PluginSourceForTests(): string {
  return pluginSource;
}
