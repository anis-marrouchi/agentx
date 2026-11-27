// --- Old release folders after `agentx daemon upgrade` (#2495) ---
//
// Every upgrade adds a release folder and none ever went away: a node fell to
// 2.1 GiB free with 27 old ones. After a RESULT ok upgrade, the folders beside
// the new one with the same name prefix are pruned, keeping the live release,
// the one it switched from, and the newest others up to --keep-releases.
// A folder named by a launchd settings file or a running process is never
// deleted, checked again just before each delete. Neither is a folder a
// symlink in the node's bin folder (the global `agentx` CLI) resolves into;
// those links are first moved to the live release. A folder with a `.git`
// entry is a dev worktree, never a release: it is never a candidate.

import { spawnSync } from "child_process"
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync } from "fs"
import { homedir } from "os"
import { basename, dirname, join, relative, resolve, sep } from "path"

/** Releases kept by default: the live one and one rollback. */
export const DEFAULT_KEEP_RELEASES = 2

export interface ReleaseFolder {
  dir: string
  /** Change time, newest first wins a keep slot. */
  mtimeMs: number
}

export interface PruneChoice {
  keep: string[]
  /** Would be pruned but something names it: never deleted. */
  inUse: string[]
  prune: string[]
}

/** The name prefix release folders share: the name up to and including its
 *  last "-" (`agentx-release-af561ac8` → `agentx-release-`). Null when the
 *  name has none: then nothing beside it counts as a release. */
export function releasePrefix(dir: string): string | null {
  const name = basename(dir)
  const i = name.lastIndexOf("-")
  return i > 0 ? name.slice(0, i + 1) : null
}

/** Which release folders to keep and which to delete. The live and rollback
 *  folders are always kept and count toward `keep`; the newest others fill
 *  the slots left. A folder in use is kept whatever its age. */
export function choosePrune(o: {
  folders: ReadonlyArray<ReleaseFolder>
  live: string
  rollback: string
  keep: number
  inUse: (dir: string) => boolean
}): PruneChoice {
  const fixed = new Set([o.live, o.rollback])
  const keep = [...fixed]
  const others = o.folders.filter((f) => !fixed.has(f.dir)).sort((a, b) => b.mtimeMs - a.mtimeMs)
  const out: PruneChoice = { keep, inUse: [], prune: [] }
  for (const f of others) {
    if (keep.length < o.keep) keep.push(f.dir)
    else if (o.inUse(f.dir)) out.inUse.push(f.dir)
    else out.prune.push(f.dir)
  }
  return out
}

/** Release folders beside `live`: same parent, same name prefix, a real
 *  folder (not a link) holding dist/cli.js, without a `.git` entry (a dev
 *  worktree such as `agentx-2495` shares the `agentx-` prefix with its
 *  siblings and may hold work not committed). */
export function listReleaseFolders(live: string): ReleaseFolder[] {
  const prefix = releasePrefix(live)
  // Run from a dev worktree: not a release layout, touch nothing beside it.
  if (!prefix || existsSync(join(live, ".git"))) return []
  const parent = dirname(live)
  const out: ReleaseFolder[] = []
  for (const name of readdirSync(parent)) {
    if (!name.startsWith(prefix)) continue
    const dir = join(parent, name)
    try {
      if (!lstatSync(dir).isDirectory() || !existsSync(join(dir, "dist/cli.js")) || existsSync(join(dir, ".git"))) continue
      out.push({ dir, mtimeMs: statSync(dir).mtimeMs })
    } catch { /* gone or unreadable: not a candidate */ }
  }
  return out
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Whether `text` names `dir` as a path: followed by "/", a quote, "<",
 *  ":" or ";" (a PATH entry), white space or the end, not as the prefix of a
 *  longer folder name. */
export function textNamesDir(text: string, dir: string): boolean {
  return new RegExp(`${escapeRe(dir)}(?=[/<"':;\\s]|$)`, "m").test(text)
}

/** Folders whose symlinks can point into a release: the node's bin folder
 *  (`agentx.target -> <release>/dist/cli.js`) and the global package. */
export function linkDirs(binDir = dirname(process.execPath)): string[] {
  return [binDir, join(binDir, "..", "lib", "node_modules")]
}

/** Every symlink directly in `dirs`, with the absolute path it points to. */
export function listLinks(dirs: ReadonlyArray<string>): { link: string; target: string }[] {
  const out: { link: string; target: string }[] = []
  for (const d of dirs) {
    let names: string[]
    try { names = readdirSync(d) } catch { continue }
    for (const n of names) {
      const link = join(d, n)
      try {
        if (lstatSync(link).isSymbolicLink()) out.push({ link, target: resolve(d, readlinkSync(link)) })
      } catch { /* gone or unreadable: skip */ }
    }
  }
  return out
}

export interface MovedLink { link: string; from: string; to: string }

/** After an ok upgrade, move every link that points into another release
 *  folder beside `live` (same parent, same prefix) to the same path inside
 *  `live`, when that path exists there. The swap is a rename, so the link is
 *  never missing. A link that cannot move stays and keeps its folder in use. */
export function moveReleaseLinks(live: string, links: ReadonlyArray<{ link: string; target: string }>, log: (s: string) => void): MovedLink[] {
  const prefix = releasePrefix(live)
  // Run from a dev worktree: not a release layout, touch nothing beside it.
  if (!prefix || existsSync(join(live, ".git"))) return []
  const parent = dirname(live)
  const moved: MovedLink[] = []
  for (const { link, target } of links) {
    const rel = relative(parent, target)
    const [folder, ...rest] = rel.split(sep)
    if (rel.startsWith("..") || !folder.startsWith(prefix) || join(parent, folder) === live) continue
    if (existsSync(join(parent, folder, ".git"))) continue
    const to = join(live, ...rest)
    if (!existsSync(to)) { log(`link not moved, ${to} missing: ${link} -> ${target}`); continue }
    try {
      const tmp = `${link}.agentx-upgrade-${process.pid}`
      rmSync(tmp, { force: true })
      symlinkSync(to, tmp)
      renameSync(tmp, link)
      moved.push({ link, from: target, to })
      log(`link moved: ${link} -> ${to} (was ${target})`)
    } catch (e) {
      log(`link not moved: ${link}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return moved
}

/** What names folders right now: every launchd settings file in
 *  ~/Library/LaunchAgents (loaded or not), every symlink in the node's bin
 *  folder and global packages, and every running command line. */
export function inUseText(laDir = join(homedir(), "Library", "LaunchAgents"), links = listLinks(linkDirs())): string {
  const parts: string[] = links.map((l) => `${l.link} -> ${l.target}`)
  try {
    for (const f of readdirSync(laDir)) {
      if (!f.endsWith(".plist")) continue
      try { parts.push(readFileSync(join(laDir, f), "utf-8")) } catch { /* unreadable: skip */ }
    }
  } catch { /* no LaunchAgents folder */ }
  const ps = spawnSync("ps", ["-axww", "-o", "command="], { encoding: "utf-8", timeout: 30_000 })
  // Without a process list nothing can be shown unused: refuse every delete.
  if (ps.status !== 0 || typeof ps.stdout !== "string") throw new Error(`ps failed: ${ps.stderr || ps.error?.message || `exit ${ps.status}`}`)
  parts.push(ps.stdout)
  return parts.join("\n")
}

/** Size of a folder in bytes (du -sk), 0 when du fails. */
export function folderBytes(dir: string): number {
  const r = spawnSync("du", ["-sk", dir], { encoding: "utf-8", timeout: 120_000 })
  const kb = r.status === 0 ? Number(String(r.stdout).split(/\s/)[0]) : NaN
  return Number.isFinite(kb) ? kb * 1024 : 0
}

export interface PruneResult {
  keep: number
  pruned: { dir: string; bytes: number }[]
  keptInUse: string[]
  freedBytes: number
  /** Why pruning stopped or did not run. */
  error?: string
}

export interface PruneDeps {
  list: (live: string) => ReleaseFolder[]
  inUseText: () => string
  bytes: (dir: string) => number
  remove: (dir: string) => void
  log: (s: string) => void
}

const realDeps = (log: (s: string) => void): PruneDeps => ({
  list: listReleaseFolders, inUseText: () => inUseText(), bytes: folderBytes,
  remove: (dir) => rmSync(dir, { recursive: true, force: true }), log,
})

const gib = (b: number) => `${(b / 1024 ** 3).toFixed(2)} GiB`

/** Prune old release folders after a RESULT ok upgrade. Never throws: a
 *  failure stops pruning and is recorded, the upgrade stays ok. */
export function pruneReleases(o: { live: string; rollback: string; keep: number }, deps: PruneDeps | ((s: string) => void)): PruneResult {
  const d = typeof deps === "function" ? realDeps(deps) : deps
  const res: PruneResult = { keep: o.keep, pruned: [], keptInUse: [], freedBytes: 0 }
  try {
    const named = d.inUseText()
    const choice = choosePrune({ folders: d.list(o.live), live: o.live, rollback: o.rollback, keep: o.keep, inUse: (dir) => textNamesDir(named, dir) })
    res.keptInUse = choice.inUse
    for (const dir of choice.inUse) d.log(`release kept, in use: ${dir}`)
    for (const dir of choice.prune) {
      // Checked again just before the delete: a run may have started on it.
      if (textNamesDir(d.inUseText(), dir)) { res.keptInUse.push(dir); d.log(`release kept, in use: ${dir}`); continue }
      const bytes = d.bytes(dir)
      d.remove(dir)
      res.pruned.push({ dir, bytes })
      res.freedBytes += bytes
      d.log(`release deleted: ${dir} (${gib(bytes)})`)
    }
    d.log(`releases: kept ${choice.keep.length + res.keptInUse.length}, deleted ${res.pruned.length}, freed ${gib(res.freedBytes)}`)
  } catch (e) {
    res.error = e instanceof Error ? e.message : String(e)
    d.log(`release pruning stopped: ${res.error}`)
  }
  return res
}
