import { getEventBus } from "@/events/bus"
import type { AgentXEvents } from "@/events/bus"
import type { ChannelAdapter } from "@/channels/types"
import type { DaemonConfig, AgentDef } from "@/daemon/config"
import type { AgentXPluginContext } from "./types"

// --- Plugin context builder ---
//
// One context per plugin. The builder owns the per-plugin disposal list:
// every subscription registered via ctx.on() is captured here, so the
// loader can tear the plugin down without the plugin's own teardown()
// having to track its subscribers. addChannel() captures registered
// adapters in the same record — the daemon reads `channels` to fold
// them into startChannels().

export interface PluginContextHandle {
  ctx: AgentXPluginContext
  /** Channels the plugin contributed via ctx.addChannel(). */
  channels: ChannelAdapter[]
  /** Run all auto-disposers (bus subscribers attached via ctx.on()). */
  disposeSubscriptions: () => void
}

export interface BuildContextArgs {
  packageName: string
  agents: ReadonlyMap<string, AgentDef>
  config: DaemonConfig
  log: (...args: unknown[]) => void
  /** Optional collision check — when an addChannel() name already exists,
   *  we skip and warn rather than overwrite. The daemon supplies the
   *  predicate so the loader doesn't depend on MessageRouter's internals. */
  isChannelNameTaken?: (name: string) => boolean
}

export function buildPluginContext(args: BuildContextArgs): PluginContextHandle {
  const channels: ChannelAdapter[] = []
  const disposers: Array<() => void> = []
  const bus = getEventBus()
  const prefix = `[plugin:${args.packageName}]`

  const ctx: AgentXPluginContext = {
    log: (...rest) => args.log(prefix, ...rest),
    on(evt, fn) {
      // Wrap so listener errors don't crash the bus's other subscribers
      // (per the documented "handlers must be fast & defensive" guidance
      // in docs/architecture/plugins.md). We still rethrow nothing —
      // EventEmitter would otherwise propagate, breaking sibling
      // subscribers. The plugin's own bug is logged with its prefix.
      const wrapped = (payload: AgentXEvents[typeof evt]) => {
        try {
          fn(payload)
        } catch (e: any) {
          args.log(prefix, `subscriber for "${String(evt)}" threw:`, e?.stack ?? e)
        }
      }
      bus.on(evt, wrapped)
      const dispose = () => bus.off(evt, wrapped)
      disposers.push(dispose)
      return dispose
    },
    addChannel(adapter) {
      if (!adapter || typeof adapter.name !== "string" || !adapter.name) {
        args.log(prefix, `addChannel: adapter is missing a string name; skipped`)
        return
      }
      if (args.isChannelNameTaken?.(adapter.name)) {
        args.log(prefix, `addChannel: name "${adapter.name}" already in use; skipped`)
        return
      }
      // Also defend against intra-plugin duplicates.
      if (channels.some((c) => c.name === adapter.name)) {
        args.log(prefix, `addChannel: name "${adapter.name}" already added by this plugin; skipped`)
        return
      }
      channels.push(adapter)
    },
    agents: args.agents,
    config: args.config,
  }

  return {
    ctx,
    channels,
    disposeSubscriptions: () => {
      for (const d of disposers) {
        try { d() } catch { /* idempotent */ }
      }
      disposers.length = 0
    },
  }
}
