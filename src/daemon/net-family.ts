import net from "node:net"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

// --- Connect attempt timeout for dual-stack hosts (#930) ---
//
// Node 20+ turns on `autoSelectFamily` (happy eyeballs) for every outbound
// connection, fetch included, and gives each address only 250 ms to connect
// before moving to the next. On a host that resolves both A and AAAA but has
// no IPv6 route, the IPv6 attempt fails at once and the IPv4 attempt is then
// abandoned after 250 ms. A slow uplink whose TCP connect takes longer fails
// every request with ETIMEDOUT about 300 ms in, while curl from the same
// host succeeds. Raising the per-attempt timeout keeps happy eyeballs and
// lets a slow but working link connect.

/**
 * Raise Node's per-address connect attempt timeout to `ms`. Never lowers a
 * larger value already set (for example with
 * `--network-family-autoselection-attempt-timeout`). Returns the value in
 * effect afterwards, or undefined when this Node has no such setting.
 */
export function applyConnectAttemptTimeout(ms: number): number | undefined {
  const get = (net as any).getDefaultAutoSelectFamilyAttemptTimeout as (() => number) | undefined
  const set = (net as any).setDefaultAutoSelectFamilyAttemptTimeout as ((v: number) => void) | undefined
  if (typeof get !== "function" || typeof set !== "function") return undefined
  const current = get()
  if (ms > current) set(ms)
  return get()
}

export const DEFAULT_CONNECT_ATTEMPT_TIMEOUT_MS = 5000

/**
 * `node.connectAttemptTimeoutMs` read straight from the config file, for CLI
 * commands that call out on their own and never load the full daemon config.
 * Falls back to the default when there is no file or no valid value.
 */
export function readConnectAttemptTimeout(cwd: string = process.cwd(), configPath?: string): number {
  const candidates = configPath
    ? [resolve(cwd, configPath)]
    : [resolve(cwd, "agentx.json"), resolve(cwd, ".agentx/config.json")]
  for (const p of candidates) {
    if (!existsSync(p)) continue
    try {
      const v = JSON.parse(readFileSync(p, "utf-8"))?.node?.connectAttemptTimeoutMs
      if (Number.isInteger(v) && v >= 250 && v <= 60_000) return v
    } catch { /* an invalid file is reported by whatever loads it in full */ }
    break
  }
  return DEFAULT_CONNECT_ATTEMPT_TIMEOUT_MS
}

/**
 * The config path given on the command line (`--config <path>`,
 * `--config=<path>`, or `-c <path>` naming a `.json` file), read before
 * commander parses anything. `-c` alone also means `--cwd` for some
 * commands, which names a folder, hence the `.json` check.
 */
export function configPathFromArgv(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--") break
    if (a.startsWith("--config=")) return a.slice("--config=".length) || undefined
    const next = argv[i + 1]
    if (a === "--config" && next) return next
    if (a === "-c" && next?.endsWith(".json")) return next
  }
  return undefined
}
