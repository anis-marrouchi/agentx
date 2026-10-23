import { macosAdapter, type MacosIo } from "./macos"
import { noneAdapter } from "./none"
import type { NativeAdapter } from "./types"

export * from "./types"
export { noneAdapter } from "./none"

export type NativeAdapterChoice = "auto" | "none"

export type NativeConfig = { native?: { adapter?: NativeAdapterChoice }; reminders?: { command?: string } }

/** Programs an adapter runs, so tests can stand in for them. */
export type NativeIo = MacosIo

/** Builds the adapter for one OS. Each OS adapter registers here. */
export type NativeAdapterFactory = (cfg: NativeConfig, io: NativeIo) => NativeAdapter

const FACTORIES: Partial<Record<NodeJS.Platform, NativeAdapterFactory>> = {
  darwin: macosAdapter,
}

/** The adapter for this machine. `native.adapter: "none"` forces none on
 *  any OS; "auto" (the default) picks by platform. */
export function loadNativeAdapter(
  cfg: NativeConfig = {},
  opts: { platform?: NodeJS.Platform; factories?: Partial<Record<NodeJS.Platform, NativeAdapterFactory>>; io?: NativeIo } = {},
): NativeAdapter {
  if (cfg.native?.adapter === "none") return noneAdapter("Turned off: native.adapter is \"none\".")
  const platform = opts.platform ?? process.platform
  const make = (opts.factories ?? FACTORIES)[platform]
  return make ? make(cfg, opts.io ?? {}) : noneAdapter(`AgentX has no native adapter for ${platform} yet.`)
}
