import { z } from "zod"
import type { ChannelAdapter } from "@/channels/types"
import type { AgentXEvents } from "@/events/bus"
import type { DaemonConfig, AgentDef } from "@/daemon/config"

// --- Move B — Plugin contract ---
//
// Third-party JS/TS packages can register channel adapters and bus
// subscribers at daemon boot. A plugin is an npm package whose default
// export matches `AgentXPlugin`; operators list it in `agentx.json`'s
// `plugins: []` array and `pnpm install` the package.
//
// The contract is minimal and stable on purpose:
//   - `manifest` declares identity + an optional version range to gate
//     against the daemon's major.minor.
//   - `setup(ctx)` is called once during daemon construction; the plugin
//     wires what it needs through the context's narrow API and returns.
//   - `teardown()` runs on `daemon.stop()`; subscribers attached via
//     ctx.on() are removed automatically, so teardown is only needed for
//     resources the plugin owns directly (timers, sockets, native
//     handles).
//
// The bus is the canonical extension point. Plugins observe what's
// happening (message:matched, task:completed, session:rotated, …) and
// react. Plugins that need to PRODUCE inbound messages do so via
// addChannel() — the registered ChannelAdapter participates in routing
// alongside built-in channels.
//
// Boundaries the contract deliberately does NOT cross in v1:
//   - No registry mutation. Plugins can't add agents at runtime;
//     agentx.json remains the source of truth.
//   - No MCP server registration. MCP is per-agent file sync today.
//   - No sandbox. Plugins run in-process with full daemon access; only
//     install plugins you trust.
//   - No hot-reload. Restart-required.

/** Plugin identification + the version range it claims compatibility
 *  with. The loader compares `agentxRange` against the daemon's
 *  major.minor and skips on mismatch. Optional — omit for "any". */
export interface AgentXPluginManifest {
  name: string
  version: string
  /** Semver-style range. When omitted, plugin loads against any agentx
   *  version. The check is a major.minor match for v1; full semver-range
   *  parsing can come later if the ecosystem demands it. */
  agentxRange?: string
}

/** Zod schema for the manifest. Loader uses safeParse so a malformed
 *  manifest produces a clear error instead of a TypeError. */
export const agentXPluginManifestSchema = z.object({
  name: z.string().min(1, "manifest.name is required"),
  version: z.string().min(1, "manifest.version is required"),
  agentxRange: z.string().optional(),
})

/** Narrow surface the loader hands to plugin.setup(). Plugins should
 *  capture only what they need; the context is closed-over and not
 *  re-emitted, so a plugin's reach is bounded by what's listed here. */
export interface AgentXPluginContext {
  /** Prefixed log helper — output is namespaced with the plugin name. */
  log: (...args: unknown[]) => void
  /** Read-only subscribe. Returned disposer is also tracked by the loader
   *  so plugin teardown removes every subscription automatically. */
  on<E extends keyof AgentXEvents>(
    evt: E,
    fn: (payload: AgentXEvents[E]) => void,
  ): () => void
  /** Register a channel adapter. The router picks it up at startChannels()
   *  alongside built-in adapters. The loader rejects names that collide
   *  with an existing channel and logs a warning. */
  addChannel(adapter: ChannelAdapter): void
  /** Read-only snapshot of the daemon's agent registry at load time.
   *  Plugins can iterate to discover capabilities; mutations are not
   *  supported in v1. */
  agents: ReadonlyMap<string, AgentDef>
  /** Read-only daemon config. Useful for plugins that need to gate on
   *  an env-driven setting (e.g. `config.mesh.enabled`). */
  config: Readonly<DaemonConfig>
}

/** The plugin shape itself — what every npm package must default-export.
 *  setup() may be sync or async; the loader awaits it with a 15s timeout
 *  so a misbehaving setup can never block daemon boot indefinitely. */
export interface AgentXPlugin {
  manifest: AgentXPluginManifest
  setup(ctx: AgentXPluginContext): void | Promise<void>
  teardown?(): void | Promise<void>
}

/** Tracked record of a plugin that successfully loaded. The loader
 *  returns these so the daemon can run teardown in stop() and surface
 *  them to `agentx plugin list`. */
export interface LoadedPlugin {
  manifest: AgentXPluginManifest
  /** The npm package name as it appeared in agentx.json's `plugins: []`. */
  packageName: string
  /** Channels this plugin contributed via ctx.addChannel(). Captured so
   *  the daemon can include them in startChannels() and surface them in
   *  the dashboard's channel list. */
  channels: ChannelAdapter[]
  /** Aggregate disposer that calls plugin.teardown() AND removes all bus
   *  subscriptions the plugin attached via ctx.on(). */
  dispose: () => Promise<void>
}
