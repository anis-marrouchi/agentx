// --- Native modules of a release folder, checked with the daemon's own Node ---
//
// A release folder is often staged with a different Node than the one launchd
// runs the daemon with (a shell whose PATH finds Homebrew Node first, or a
// node_modules copied from an older folder). better-sqlite3 then loads in the
// shell but not in the daemon: every openDb fails, /health still says ok, and
// chat, schedules and the Hub break quietly (#2227, 11-24 → 11-25).
//
// `agentx daemon upgrade` calls ensureNativeModules before it switches: load
// better-sqlite3 with the daemon's Node; if that fails, fetch the matching
// prebuilt binary (prebuild-install, falling back to node-gyp) with that Node;
// if it still fails, refuse the upgrade so nothing changes.

import { spawnSync } from "child_process"
import { existsSync, realpathSync } from "fs"
import { dirname, resolve } from "path"

export interface NativeCheck {
  ok: boolean
  /** "loaded", "rebuilt", or why it failed. */
  detail: string
}

const PROBE = "const D=require('better-sqlite3');new D(':memory:').close();process.stdout.write(process.versions.modules)"

function probe(dir: string, node: string): { ok: boolean; out: string } {
  const r = spawnSync(node, ["-e", PROBE], { cwd: dir, encoding: "utf-8", timeout: 60_000 })
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim()
  return { ok: r.status === 0, out }
}

function lastLine(s: string): string {
  const m = s.match(/NODE_MODULE_VERSION \d+\. This version of Node\.js requires\s+NODE_MODULE_VERSION \d+/)
  return (m ? m[0] : s.split("\n").filter(Boolean).pop() ?? "").replace(/\s+/g, " ").slice(0, 300)
}

/** Make the release's better-sqlite3 load under `node` (the daemon's Node). */
export function ensureNativeModules(dir: string, node: string, log: (s: string) => void = () => {}): NativeCheck {
  const link = resolve(dir, "node_modules/better-sqlite3")
  if (!existsSync(link)) return { ok: true, detail: "no better-sqlite3 in this release" }
  const first = probe(dir, node)
  if (first.ok) return { ok: true, detail: `loaded (modules ${first.out})` }
  log(`better-sqlite3 does not load with ${node}: ${lastLine(first.out)}; rebuilding it for that Node`)

  const pkg = realpathSync(link)
  const env = { ...process.env, PATH: `${dirname(node)}:${process.env.PATH ?? "/usr/bin:/bin"}` }
  const tries: string[][] = []
  const prebuild = [resolve(pkg, "../prebuild-install/bin.js"), resolve(pkg, "node_modules/prebuild-install/bin.js")].find(existsSync)
  if (prebuild) tries.push([prebuild])
  const gyp = [resolve(dirname(node), "../lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js")].find(existsSync)
  if (gyp) tries.push([gyp, "rebuild", "--release"])
  for (const args of tries) {
    const r = spawnSync(node, args, { cwd: pkg, env, encoding: "utf-8", timeout: 10 * 60_000 })
    if (r.status !== 0) { log(`${args[0]} failed: ${lastLine(`${r.stdout ?? ""}${r.stderr ?? ""}`)}`); continue }
    const again = probe(dir, node)
    if (again.ok) return { ok: true, detail: `rebuilt (modules ${again.out})` }
  }
  return { ok: false, detail: `better-sqlite3 does not load with the daemon's Node ${node} (${lastLine(first.out)}) and could not be rebuilt; run there: PATH=${dirname(node)}:$PATH pnpm rebuild better-sqlite3` }
}
