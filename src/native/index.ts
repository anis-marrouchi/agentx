import { noneAdapter } from "./none"
import type { NativeAdapter } from "./types"

export * from "./types"
export { noneAdapter } from "./none"

export type NativeAdapterChoice = "auto" | "none"

/** Builds the adapter for one OS. Each OS adapter registers here when it
 *  lands (macOS in #1062 step 3); until then every platform gets none. */
export type NativeAdapterFactory = (cfg: { native?: { adapter?: NativeAdapterChoice } } & Record<string, unknown>) => NativeAdapter

const FACTORIES: Partial<Record<NodeJS.Platform, NativeAdapterFactory>> = {}

/** The adapter for this machine. `native.adapter: "none"` forces none on
 *  any OS; "auto" (the default) picks by platform. */
export function loadNativeAdapter(
  cfg: { native?: { adapter?: NativeAdapterChoice } } & Record<string, unknown> = {},
  opts: { platform?: NodeJS.Platform; factories?: Partial<Record<NodeJS.Platform, NativeAdapterFactory>> } = {},
): NativeAdapter {
  if (cfg.native?.adapter === "none") return noneAdapter("Turned off: native.adapter is \"none\".")
  const platform = opts.platform ?? process.platform
  const make = (opts.factories ?? FACTORIES)[platform]
  return make ? make(cfg) : noneAdapter(`AgentX has no native adapter for ${platform} yet.`)
}
