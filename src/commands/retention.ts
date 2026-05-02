import { Command } from "commander"
import chalk from "chalk"
import { readdirSync, statSync, unlinkSync, rmSync, existsSync } from "fs"
import { resolve, join } from "path"

// --- agentx retention — prune old session/drift files ---
//
// Closes the "no operator-facing cleanup" gap from the audit. Long-
// lived daemons accumulate per-day session JSONs and drift snapshots;
// neither gets pruned automatically. This subcommand walks each
// allow-listed directory and removes files older than --days.

interface PruneTarget {
  /** Root path under .agentx/ to walk. */
  dir: string
  /** Description shown in the dry-run + summary output. */
  label: string
  /** When true, recurse into subdirs (sessions are flat; some workspaces nest). */
  recursive?: boolean
}

const TARGETS: PruneTarget[] = [
  { dir: ".agentx/sessions", label: "Per-day session JSON" },
  { dir: ".agentx/drift", label: "Drift snapshots", recursive: true },
  { dir: ".agentx/router", label: "Router-decision logs", recursive: true },
  { dir: ".agentx/patterns", label: "Self-improving pattern store", recursive: true },
]

function walkFiles(dir: string, recursive: boolean): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isFile()) out.push(full)
    else if (entry.isDirectory() && recursive) out.push(...walkFiles(full, true))
  }
  return out
}

export const retention = new Command()
  .name("retention")
  .description("prune old workspace state (sessions, drift, router traces, pattern store)")

retention
  .command("show", { isDefault: true })
  .description("show how much each retention target currently weighs")
  .action(() => {
    console.log()
    let total = 0
    for (const t of TARGETS) {
      const root = resolve(process.cwd(), t.dir)
      const files = walkFiles(root, !!t.recursive)
      let bytes = 0
      let oldest: number | null = null
      for (const f of files) {
        try {
          const s = statSync(f)
          bytes += s.size
          if (oldest === null || s.mtimeMs < oldest) oldest = s.mtimeMs
        } catch { /* skip */ }
      }
      total += bytes
      const oldestAge = oldest !== null ? `${Math.round((Date.now() - oldest) / 86_400_000)}d` : "—"
      console.log(`  ${chalk.cyan(t.dir.padEnd(22))} ${String(files.length).padStart(5)} files  ${formatBytes(bytes).padStart(10)}  oldest=${oldestAge}`)
    }
    console.log(chalk.dim(`  ${"".padEnd(22)} ${"".padStart(5)}        ${formatBytes(total).padStart(10)} total`))
    console.log()
    console.log(chalk.dim("  Run `agentx retention prune --days 30` to delete files older than 30 days."))
    console.log()
  })

retention
  .command("prune")
  .description("delete files older than --days from each retention target")
  .option("--days <n>", "max age in days; everything older is deleted", "30")
  .option("--dry-run", "list candidates, don't delete")
  .option("--target <name>", "limit to one target dir (e.g. .agentx/sessions)")
  .action((opts) => {
    const days = parseInt(opts.days, 10)
    if (!Number.isFinite(days) || days < 1) {
      console.log(chalk.red("  --days must be a positive integer"))
      process.exit(1)
    }
    const cutoff = Date.now() - days * 86_400_000
    const filterTarget = opts.target as string | undefined
    let totalRemoved = 0
    let totalBytes = 0
    console.log()
    console.log(chalk.bold(`  Pruning files older than ${days}d (${new Date(cutoff).toISOString().slice(0, 10)})${opts.dryRun ? chalk.yellow(" — DRY RUN") : ""}`))
    console.log()
    for (const t of TARGETS) {
      if (filterTarget && t.dir !== filterTarget) continue
      const root = resolve(process.cwd(), t.dir)
      const files = walkFiles(root, !!t.recursive)
      let removed = 0
      let bytes = 0
      for (const f of files) {
        try {
          const s = statSync(f)
          if (s.mtimeMs < cutoff) {
            bytes += s.size
            removed++
            if (!opts.dryRun) {
              try { unlinkSync(f) } catch { /* */ }
            }
          }
        } catch { /* skip */ }
      }
      // Best-effort cleanup of empty subdirs (recursive targets only).
      if (t.recursive && !opts.dryRun) {
        try { pruneEmptyDirs(root) } catch { /* */ }
      }
      const action = opts.dryRun ? "would remove" : "removed"
      console.log(`  ${chalk.cyan(t.dir.padEnd(22))} ${action} ${String(removed).padStart(5)} files (${formatBytes(bytes)})`)
      totalRemoved += removed
      totalBytes += bytes
    }
    console.log()
    console.log(chalk.green(`  ✓ ${opts.dryRun ? "(dry-run)" : ""} ${totalRemoved} files, ${formatBytes(totalBytes)} ${opts.dryRun ? "would be reclaimed" : "reclaimed"}`))
    console.log()
  })

function pruneEmptyDirs(root: string): void {
  if (!existsSync(root)) return
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const full = join(root, entry.name)
    pruneEmptyDirs(full)
    try {
      const remaining = readdirSync(full)
      if (remaining.length === 0) rmSync(full, { recursive: false })
    } catch { /* skip */ }
  }
}

function formatBytes(b: number): string {
  if (b < 1024) return b + "B"
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + "K"
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + "M"
  return (b / 1024 / 1024 / 1024).toFixed(2) + "G"
}
