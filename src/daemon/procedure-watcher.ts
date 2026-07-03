import type Database from "better-sqlite3"
import { getEventBus, type AgentXEvents } from "@/events/bus"
import { runExtraction } from "@/procedures/mine"
import type { DaemonConfig } from "./config"

// --- Procedure watcher — the "on task event" extraction trigger ---
// Gated on procedures.extraction.onTaskCompletion. After a successful task,
// run the CHEAP mining stages (load since watermark → cluster → persist
// recurrence counts — no LLM) so pattern counts stay fresh between scheduled
// runs. When a candidate crosses the threshold and an LLM route (`via`) is
// configured, kick one full extraction for it. Debounced so a burst of task
// completions costs one scan, and re-entrancy guarded so scans never overlap.

const DEBOUNCE_MS = 30 * 60 * 1000

export function attachProcedureWatcher(
  db: Database.Database,
  config: DaemonConfig,
  log: (msg: string) => void,
): () => void {
  const settings = config.procedures?.extraction
  if (!config.procedures?.enabled || !settings?.enabled || !settings.onTaskCompletion) {
    return () => {}
  }

  const bus = getEventBus()
  let lastRunAt = 0
  let running = false

  const onCompleted = (p: AgentXEvents["task:completed"]) => {
    if (p.error) return
    const now = Date.now()
    if (running || now - lastRunAt < DEBOUNCE_MS) return
    running = true
    lastRunAt = now
    void (async () => {
      try {
        // One committed pass. With no candidate at threshold this is pure
        // counting (no LLM call ever fires); when one IS ready and `via` is
        // configured, the same pass distills it while the triggering
        // episodes are still inside the watermark window.
        const report = await runExtraction(db, {
          proceduresDir: config.procedures.dir,
          since: now - settings.sinceDays * 86_400_000,
          minOccurrences: settings.minOccurrences,
          max: settings.maxClusters,
          commit: true,
          llm: settings.via ? { viaAgent: settings.via, chatId: "procedure-miner" } : undefined,
          log: (m) => log(`[procedures] ${m}`),
        })
        if (report.ready.length > 0) {
          log(`[procedures] ${report.ready.length} pattern(s) at threshold: ${report.ready.map((c) => `${c.key} ×${c.count}`).join(", ")}`)
        }
        for (const d of report.drafted) {
          log(`[procedures] draft mined from live activity: ${d.id} — review with \`agentx procedure list --drafts\``)
        }
        if (report.ready.length > 0 && !settings.via) {
          log(`[procedures] no extraction.via agent configured — run \`agentx procedure extract --commit --via <agent>\` to draft`)
        }
      } catch (e: any) {
        log(`[procedures] watcher scan failed: ${e.message}`)
      } finally {
        running = false
      }
    })()
  }

  bus.on("task:completed", onCompleted)
  log(`  Procedures: on-task pattern counting enabled (threshold ${settings.minOccurrences})`)
  return () => bus.off("task:completed", onCompleted)
}
