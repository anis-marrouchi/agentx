import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs"
import { homedir } from "os"
import { dirname, join, resolve } from "path"

// --- The daemon's folder, found from any folder ---
//
// The daemon keeps its state under the folder it was started in (agentx.json
// and .agentx/). A CLI command that reads that state from another folder
// sees nothing: `agentx approvals list` from ~ printed "nothing waiting"
// while cards waited. The daemon writes its folder to ~/.agentx/daemon-root
// at start, so commands can find it from anywhere.

export const daemonRootFile = (home = homedir()) => join(home, ".agentx", "daemon-root")

/** Called by the daemon at start. */
export function writeDaemonRoot(root: string, home = homedir()): void {
  const file = daemonRootFile(home)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, resolve(root) + "\n")
}

const hasConfig = (dir: string) => existsSync(join(dir, "agentx.json")) || existsSync(join(dir, ".agentx", "config.json"))

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory() } catch { return false }
}

/**
 * The folder whose .agentx a command should read: AGENTX_ROOT when set; the
 * current folder when it holds a daemon config (an install, or a second
 * daemon); else the folder the daemon last started in; else the current
 * folder, as before.
 */
export function resolveDaemonRoot(opts: { cwd?: string; env?: NodeJS.ProcessEnv; home?: string } = {}): string {
  const cwd = resolve(opts.cwd ?? process.cwd())
  const env = opts.env ?? process.env
  if (env.AGENTX_ROOT?.trim()) return resolve(env.AGENTX_ROOT.trim())
  if (hasConfig(cwd)) return cwd
  let pointed = ""
  try { pointed = readFileSync(daemonRootFile(opts.home), "utf-8").trim() } catch { /* no daemon started yet */ }
  return pointed && isDir(pointed) ? pointed : cwd
}
