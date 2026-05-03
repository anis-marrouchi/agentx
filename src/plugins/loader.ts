import {
  agentXPluginManifestSchema,
  type AgentXPlugin,
  type LoadedPlugin,
} from "./types"
import { buildPluginContext } from "./context"
import type { DaemonConfig, AgentDef } from "@/daemon/config"

// --- Plugin loader ---
//
// Move B.2. Iterates `config.plugins[]` (npm package names), dynamic-
// imports each, validates the manifest with Zod, builds a per-plugin
// context, and calls plugin.setup(ctx) within a 15 s race so a hung
// setup can never block daemon boot.
//
// Discovery is explicit: only listed packages load. No node_modules
// scan, no `file:` paths in v1 — operators must `pnpm install` the
// package and add its name to agentx.json. The plan trades a small
// install step for a meaningful security boundary (auto-loading
// strangers from node_modules is a footgun).
//
// Failure modes are isolated: an import error, manifest mismatch, or
// setup() throw is logged with the package name and the loader moves
// on. The daemon never aborts because of a plugin.

export interface LoadPluginsArgs {
  config: DaemonConfig
  agents: ReadonlyMap<string, AgentDef>
  log: (...args: unknown[]) => void
  /** Used by ctx.addChannel() to refuse name collisions with built-ins. */
  isChannelNameTaken?: (name: string) => boolean
  /** The daemon's own version (read from package.json). When the plugin
   *  declares an `agentxRange` the loader gates major.minor parity. */
  daemonVersion?: string
  /** Test seam — supply a custom dynamic import so fixtures can use
   *  relative paths or pre-injected modules without touching node_modules. */
  importer?: (packageName: string) => Promise<unknown>
  /** Test seam — override the per-setup timeout (default 15 000 ms). */
  setupTimeoutMs?: number
}

const DEFAULT_SETUP_TIMEOUT_MS = 15_000

export async function loadPlugins(args: LoadPluginsArgs): Promise<LoadedPlugin[]> {
  const names = args.config.plugins ?? []
  if (names.length === 0) return []

  const importer = args.importer ?? ((name: string) => import(name))
  const timeoutMs = args.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS
  const out: LoadedPlugin[] = []

  for (const packageName of names) {
    let mod: unknown
    try {
      mod = await importer(packageName)
    } catch (e: any) {
      args.log(`[plugins] import failed for "${packageName}": ${e?.message ?? e}`)
      continue
    }

    // Normalise ESM/CJS interop. CJS packages compiled with esbuild often
    // expose the real default at `default.default`; pure ESM exposes it at
    // `default`; some hand-rolled CJS attaches the manifest directly to
    // module.exports.
    const candidate = pickDefault(mod)
    if (!isPlugin(candidate)) {
      args.log(`[plugins] "${packageName}" did not export a default AgentXPlugin (no manifest/setup pair found)`)
      continue
    }
    const plugin = candidate

    const parsed = agentXPluginManifestSchema.safeParse(plugin.manifest)
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => i.message).join("; ")
      args.log(`[plugins] "${packageName}" manifest invalid: ${issues}`)
      continue
    }

    // Optional version gate. Major.minor parity is the v1 contract; we
    // intentionally skip patch/prerelease parity to keep the gate stable
    // through alpha cycles.
    if (parsed.data.agentxRange && args.daemonVersion) {
      if (!majorMinorMatches(parsed.data.agentxRange, args.daemonVersion)) {
        args.log(`[plugins] "${packageName}" requires agentx ${parsed.data.agentxRange}, daemon is ${args.daemonVersion}; skipped`)
        continue
      }
    }

    const handle = buildPluginContext({
      packageName,
      agents: args.agents,
      config: args.config,
      log: args.log,
      isChannelNameTaken: args.isChannelNameTaken,
    })

    let setupOk = false
    try {
      await raceWithTimeout(
        Promise.resolve(plugin.setup(handle.ctx)),
        timeoutMs,
        `setup() exceeded ${timeoutMs}ms`,
      )
      setupOk = true
    } catch (e: any) {
      args.log(`[plugins] "${packageName}" setup() failed: ${e?.message ?? e}`)
      // Tear down anything the plugin managed to register before throwing.
      handle.disposeSubscriptions()
      continue
    }

    if (!setupOk) continue

    args.log(`[plugins] loaded ${parsed.data.name} v${parsed.data.version}`)

    out.push({
      manifest: parsed.data,
      packageName,
      channels: handle.channels,
      dispose: async () => {
        try {
          if (typeof plugin.teardown === "function") await plugin.teardown()
        } catch (e: any) {
          args.log(`[plugins] "${packageName}" teardown() threw: ${e?.message ?? e}`)
        } finally {
          handle.disposeSubscriptions()
        }
      },
    })
  }

  return out
}

function pickDefault(mod: unknown): unknown {
  if (mod == null) return mod
  if (typeof mod !== "object") return mod
  const m = mod as Record<string, unknown>
  // Pure ESM: `import x from 'pkg'` → x is the default export.
  // Dynamic import always returns the namespace; the default is at `.default`.
  // CJS through esbuild sometimes produces `default.default`.
  if (m.default && typeof m.default === "object") {
    const d = m.default as Record<string, unknown>
    if (d.manifest && typeof d.setup === "function") return d
    if (d.default && typeof d.default === "object") {
      const dd = d.default as Record<string, unknown>
      if (dd.manifest && typeof dd.setup === "function") return dd
    }
  }
  if (m.manifest && typeof m.setup === "function") return m
  return m.default ?? m
}

function isPlugin(c: unknown): c is AgentXPlugin {
  return (
    !!c &&
    typeof c === "object" &&
    "manifest" in (c as object) &&
    "setup" in (c as object) &&
    typeof (c as { setup: unknown }).setup === "function"
  )
}

function majorMinorMatches(range: string, daemonVersion: string): boolean {
  // Strip "^" / "~" / "=" / "v" prefixes; we only care about major.minor.
  const a = range.replace(/^[\^~=v]+/, "").split(".")
  const b = daemonVersion.replace(/^v/, "").split(".")
  return a[0] === b[0] && (a[1] ?? "") === (b[1] ?? "")
}

function raceWithTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(msg)), ms)
    p.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}
