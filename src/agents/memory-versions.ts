import { createHash } from "crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs"
import { basename, dirname, resolve } from "path"

// --- Version history and write safety for AgentMemory files ---
//
// Every overwrite or delete of a memory file first copies the current file
// into `_versions/<file stem>/<timestamp>.md` next to it, so any change can
// be rolled back. Writes go through a temp file and a rename, so a reader
// never sees half a file. An etag (content hash) lets callers make
// conditional writes: two agents editing the same memory can no longer
// silently overwrite each other.

/** Old versions kept per memory. The oldest are pruned past this. */
export const MAX_VERSIONS = 20

export class MemoryConflictError extends Error {
  constructor(readonly currentEtag: string | null) {
    super(currentEtag
      ? "memory changed since you read it (etag mismatch)"
      : "memory does not exist (etag mismatch)")
    this.name = "MemoryConflictError"
  }
}

/** Conditions for a write, mirroring HTTP If-Match / If-None-Match. */
export interface WriteCondition {
  /** Write only when the current file has this etag. */
  ifMatch?: string
  /** "*": write only when no memory exists yet (create, never overwrite). */
  ifNoneMatch?: "*"
}

export function etagOf(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16)
}

/** Throws MemoryConflictError when `current` (file content, or null when
 *  absent) doesn't satisfy `cond`. No condition always passes. */
export function checkCondition(current: string | null, cond: WriteCondition | undefined): void {
  if (!cond) return
  const etag = current === null ? null : etagOf(current)
  if (cond.ifNoneMatch === "*" && etag !== null) throw new MemoryConflictError(etag)
  if (cond.ifMatch !== undefined && cond.ifMatch !== etag) throw new MemoryConflictError(etag)
}

export function atomicWrite(path: string, content: string): void {
  const tmp = resolve(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`)
  writeFileSync(tmp, content)
  renameSync(tmp, path)
}

function versionsDir(memoryFile: string): string {
  return resolve(dirname(memoryFile), "_versions", basename(memoryFile, ".md"))
}

/** Copy the current file into its history before it is replaced or
 *  removed. No-op when the file doesn't exist yet. */
export function snapshot(memoryFile: string, current: string | null): void {
  if (current === null) return
  const dir = versionsDir(memoryFile)
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  let path = resolve(dir, `${stamp}.md`)
  for (let n = 1; existsSync(path); n++) path = resolve(dir, `${stamp}-${n}.md`)
  writeFileSync(path, current)
  prune(dir)
}

function prune(dir: string): void {
  const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort()
  for (const f of files.slice(0, Math.max(0, files.length - MAX_VERSIONS))) {
    try { unlinkSync(resolve(dir, f)) } catch { /* already gone */ }
  }
}

export interface StoredVersion {
  /** File stem, e.g. 2026-09-26T07-30-00-123Z. Pass to restore. */
  id: string
  content: string
}

/** Stored versions of a memory file, newest first. */
export function readVersions(memoryFile: string): StoredVersion[] {
  const dir = versionsDir(memoryFile)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .reverse()
    .map((f) => ({ id: f.slice(0, -3), content: readFileSync(resolve(dir, f), "utf-8") }))
}
