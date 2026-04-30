import type { LoadedPlugin } from "./types"
import type { DaemonConfig } from "@/daemon/config"

// --- Plugin loader (stub) ---
//
// The full loader lands in commit 2 (Move B.2) along with the context
// builder. This stub returns an empty array so commit 1's daemon-config
// schema change can ship safely — `plugins: []` (the default) is a
// no-op, and `plugins: ["foo"]` no-ops too until the real loader is
// wired in. Lets us land the type contract independently.

export async function loadPlugins(_config: DaemonConfig, _ctx: unknown): Promise<LoadedPlugin[]> {
  return []
}
