import { lstatSync, mkdirSync, readdirSync, realpathSync, unlinkSync } from "fs"
import { join, resolve } from "path"

// --- The phone app outbox: <workspace>/.agentx/outbox/ ---
//
// Files an agent shows on the phone must be inside its workspace
// (app-files-api.ts). A file made elsewhere (/tmp) is copied here first and
// attached from here. The daemon makes the folder when a phone chat starts
// and removes what is older than a week, so the copies don't pile up.
//
// Only a real folder at exactly this place is ever cleaned: if `.agentx` or
// `outbox` is a link, or the workspace is missing, nothing is touched.

export const OUTBOX_DIR = ".agentx/outbox"
export const OUTBOX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** The outbox's real path, or null when it is missing or not where it should be. */
function outboxPath(workspace: string, cwd: string): string | null {
  try {
    const root = realpathSync(resolve(cwd, workspace))
    const dir = join(root, OUTBOX_DIR)
    return realpathSync(dir) === dir && lstatSync(dir).isDirectory() ? dir : null
  } catch {
    return null
  }
}

/** Creates the outbox if needed, then removes files older than `maxAgeMs`.
 *  Returns how many were removed. */
export function prepareOutbox(workspace: string, opts: { cwd?: string; now?: number; maxAgeMs?: number; create?: boolean } = {}): number {
  const cwd = opts.cwd ?? process.cwd()
  if (opts.create !== false) {
    try {
      const root = realpathSync(resolve(cwd, workspace))
      // Never make the folder through a linked `.agentx`.
      if (!lstatSync(join(root, ".agentx"), { throwIfNoEntry: false })?.isSymbolicLink()) {
        mkdirSync(join(root, OUTBOX_DIR), { recursive: true })
      }
    } catch { return 0 }
  }
  const dir = outboxPath(workspace, cwd)
  if (!dir) return 0
  return prune(dir, (opts.now ?? Date.now()) - (opts.maxAgeMs ?? OUTBOX_MAX_AGE_MS))
}

/** Old files and links go, links never followed. Folders stay. */
function prune(dir: string, before: number): number {
  let removed = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    try {
      if (entry.isDirectory()) removed += prune(path, before)
      else if (lstatSync(path).mtimeMs < before) {
        unlinkSync(path)
        removed++
      }
    } catch { /* gone already or not ours to remove: the next pass retries */ }
  }
  return removed
}
