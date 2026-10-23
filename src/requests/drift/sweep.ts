import { checkProject, proofNote, type Drift, type DriftCheckDeps, type DriftSettings } from "./check"
import { WRITE_TRIES, type DriftStore } from "./store"
import type { BacklogPatch, SyncBackResult } from "@/business/backlog-sync"

// --- Status follows the work: the daemon's check (#1138 step F) ---
//
// Every `checkEveryMinutes`, for each project under requests.statusDrift:
//
//   1. Find the drifts (check.ts). Read only.
//   2. Shadow (always): a drift not seen before is logged, and told to the
//      owner once, one line each, in one notice per check. A notice that
//      could not be sent is told again at the next check.
//   3. Write (only with `write` on and the project in `writeProjects`): an
//      issue whose work is live gets the Done label, loses its other status
//      labels, and gets a note quoting the proof. Once per drift; a failed
//      write is tried again up to WRITE_TRIES times. Nothing else is ever
//      written: no issue is closed, no other kind of drift is acted on.

export interface DriftSweepDeps extends DriftCheckDeps {
  settings: DriftSettings
  store: DriftStore
  /** Tell the owner. Rejects when nothing reached them. */
  tell?: (title: string, message: string) => Promise<void>
  /** Write one issue on its home. */
  writeIssue?: (issue: { provider: Drift["provider"]; project: string; number: number; url: string }, patch: BacklogPatch) => Promise<SyncBackResult>
  log: (msg: string) => void
}

export interface DriftSweepResult {
  projects: number
  drifts: number
  /** Drifts not seen before, told to the owner this check. */
  told: number
  written: number
  errors: string[]
}

/** The row key of a drift: the issue, the kind, the merges behind it. A
 *  new merge on the same issue is a new drift. */
export const driftKey = (d: Drift) =>
  `${d.provider}:${d.issue.toLowerCase()}:${d.kind}:${d.changes.map((c) => c.commit ?? c.ref).sort().join(",")}`

export async function runDriftSweep(deps: DriftSweepDeps): Promise<DriftSweepResult> {
  const { settings, store, log } = deps
  const now = deps.now ?? Date.now()
  const result: DriftSweepResult = { projects: 0, drifts: 0, told: 0, written: 0, errors: [] }
  if (!settings.enabled) return result

  const fresh: Array<{ key: string; drift: Drift }> = []
  for (const project of settings.projects) {
    result.projects++
    const checked = await checkProject(project, { ...deps, now })
    result.errors.push(...checked.errors)
    for (const e of checked.errors) log(`[status-drift] ${e}`)
    for (const d of checked.drifts) {
      result.drifts++
      const key = driftKey(d)
      const row = store.see(key, d.issue, d.kind, d.line, now)
      if (row.toldAt === null) {
        log(`[status-drift] ${d.line}`)
        fresh.push({ key, drift: d })
      }
      // Gated on the issue's own project, which a merge in a writable
      // project may not share.
      const writable = settings.write && d.kind === "live-not-done" && settings.writeProjects.some((p) => p.toLowerCase() === d.project.toLowerCase())
      if (writable && deps.writeIssue && row.writtenAt === null && row.writeTries < WRITE_TRIES) {
        if (await writeDone(d, key, deps, now)) result.written++
      }
    }
  }

  if (fresh.length) {
    // Marked first: a notice that hangs must not be sent twice.
    for (const f of fresh) store.told(f.key, now)
    if (deps.tell) {
      const n = fresh.length
      try {
        await deps.tell(`Status drift: ${n} issue${n === 1 ? "" : "s"} not where the work is`, fresh.map((f) => f.drift.line).join("\n"))
        result.told = n
      } catch (e: any) {
        for (const f of fresh) store.told(f.key, null)
        log(`[status-drift] couldn't tell the owner, will try again: ${e?.message ?? e}`)
      }
    } else {
      result.told = fresh.length
    }
  }

  try {
    store.prune(now)
  } catch (e: any) {
    log(`[status-drift] retention failed: ${e?.message ?? e}`)
  }
  return result
}

/** Longest wait for one issue write: a forge that hangs must not stop
 *  the next checks. */
export const WRITE_TIMEOUT_MS = 60_000

/** The Done label to write: scoped ("Status::Done") when the issue's
 *  status labels are scoped, else the first one. */
export function doneLabelFor(d: Pick<Drift, "statusLabels">, done: string[]): string | undefined {
  const scoped = d.statusLabels.some((l) => l.includes("::"))
  return done.find((l) => l.includes("::") === scoped) ?? done[0]
}

async function writeDone(d: Drift, key: string, deps: DriftSweepDeps, now: number): Promise<boolean> {
  const done = doneLabelFor(d, deps.settings.labels.done)
  if (!done) return false
  const patch: BacklogPatch = {
    addLabels: [done],
    removeLabels: d.statusLabels.filter((l) => l.toLowerCase() !== done.toLowerCase()),
    note: proofNote(d, done),
  }
  try {
    let timer: ReturnType<typeof setTimeout> | undefined
    const res = await Promise.race([
      deps.writeIssue!({ provider: d.provider, project: d.project, number: d.number, url: d.issueUrl }, patch),
      new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), WRITE_TIMEOUT_MS) }),
    ]).finally(() => clearTimeout(timer))
    if (res === "timeout") {
      // The request may still land: not tried again, so no second note.
      deps.store.writeUnknown(key, `no answer in ${WRITE_TIMEOUT_MS / 1000} s, not tried again`)
      deps.log(`[status-drift] ${d.issue}: no answer in ${WRITE_TIMEOUT_MS / 1000} s moving it to ${done}; not tried again, check it by hand`)
      return false
    }
    // The label moved (the issue's own update went through): written,
    // even when the note failed. Trying again would leave a second note
    // on a success. A note alone is not a move.
    const labelled = res.attempts.some((a) => /^(PUT|PATCH) issue$/.test(a.kind) && a.ok)
    if (labelled) {
      deps.store.written(key, now)
      if (!res.ok) deps.log(`[status-drift] ${d.issue}: label moved, its note failed: ${JSON.stringify(res.attempts)}`)
      deps.log(`[status-drift] ${d.issue} moved to ${done}${patch.removeLabels!.length ? ` (removed ${patch.removeLabels!.join(", ")})` : ""}`)
      return true
    }
    deps.store.writeFailed(key, res.error ?? "the write failed")
    deps.log(`[status-drift] ${d.issue}: could not move it to ${done}: ${res.error ?? JSON.stringify(res.attempts)}`)
  } catch (e: any) {
    deps.store.writeFailed(key, String(e?.message ?? e))
    deps.log(`[status-drift] ${d.issue}: could not move it to ${done}: ${e?.message ?? e}`)
  }
  return false
}
