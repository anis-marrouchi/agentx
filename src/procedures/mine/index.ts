import type Database from "better-sqlite3"
import type { PromotionLlmOptions } from "@/wiki/promote"
import type { SessionStore } from "@/agents/sessions"
import { ProcedureStore } from "../store"
import {
  markCandidate,
  readCandidates,
  readyCandidates,
  upsertEpisode,
  writeCandidates,
  type Candidate,
  type CandidateLedger,
} from "../candidates"
import { loadEpisodes, loadEpisodesByTaskIds, type ActivityEpisode, type LoadEpisodesOptions } from "./load"
import { clusterEpisodes, clusterKey, nearMisses } from "./cluster"
import { distillClusters, type MinedProcedure } from "./distill"
import type { ClusterSample } from "./prompts"

export type { ActivityEpisode } from "./load"
export { clusterEpisodes, clusterKey, intentShape, actionSkeleton, nearMisses } from "./cluster"
export { distillClusters, lintBlackBox, parseExtractionResponse, minedProcedureSchema, type MinedProcedure } from "./distill"
export { buildExtractionPrompt, activityOutline } from "./prompts"
export { loadEpisodes }

// --- runExtraction ---
// The full mining pipeline: load episodes → cluster → count recurrences in
// the candidate ledger → distill ready candidates via LLM → write procedure
// drafts. Dry-run does everything except the LLM call and any writes (the
// ledger is only persisted on --commit, so re-running a dry run is free and
// idempotent by construction).

export interface ExtractionOptions {
  /** Procedures dir (default .agentx/procedures relative to cwd). */
  proceduresDir?: string
  since?: number
  agentId?: string
  /** Optional transcript join for richer user-language samples. */
  sessions?: SessionStore
  minOccurrences?: number
  /** Max clusters distilled per run. */
  max?: number
  commit?: boolean
  /** Required when commit=true. */
  llm?: PromotionLlmOptions
  log?: (msg: string) => void
}

export interface ExtractionReport {
  dryRun: boolean
  episodes: number
  clusters: number
  /** Candidates at/above the recurrence threshold this run. */
  ready: Candidate[]
  /** Near-miss groups (same intent, different skeleton) for tuning. */
  nearMisses: Array<{ intent: string; keys: string[] }>
  drafted: Array<{ id: string; cluster: string; count: number }>
  skipped: Array<{ cluster: string; reason: string }>
  warnings: string[]
}

export const DEFAULT_MIN_OCCURRENCES = 3
export const DEFAULT_MAX_CLUSTERS = 5

export async function runExtraction(
  db: Database.Database,
  opts: ExtractionOptions = {},
): Promise<ExtractionReport> {
  const log = opts.log ?? (() => {})
  const commit = opts.commit === true
  const minOccurrences = Math.max(2, opts.minOccurrences ?? DEFAULT_MIN_OCCURRENCES)
  const max = Math.max(1, opts.max ?? DEFAULT_MAX_CLUSTERS)
  const store = new ProcedureStore(opts.proceduresDir ? { baseDir: opts.proceduresDir } : {})
  const ledger = readCandidates(store.baseDir)

  // Watermark: skip traces already counted on a previous committed run.
  const watermark = ledger.minedThrough ? Date.parse(ledger.minedThrough) : undefined
  const since = Math.max(opts.since ?? 0, Number.isFinite(watermark ?? NaN) ? (watermark as number) : 0) || undefined

  const loadOpts: LoadEpisodesOptions = { since, agentId: opts.agentId, sessions: opts.sessions }
  const episodes = loadEpisodes(db, loadOpts)
  const clusters = clusterEpisodes(episodes)
  log(`${episodes.length} episode(s) since ${since ? new Date(since).toISOString() : "beginning"} → ${clusters.length} cluster(s)`)

  const byKey = new Map<string, ActivityEpisode[]>()
  let scannedThrough = ledger.minedThrough
  for (const cluster of clusters) {
    byKey.set(cluster.key, cluster.episodes)
    for (const ep of cluster.episodes) {
      const ts = new Date(ep.startedAt).toISOString()
      upsertEpisode(ledger, cluster.key, ep.taskId, ts, ep.userMessage.slice(0, 200))
      if (!scannedThrough || ts > scannedThrough) scannedThrough = ts
    }
  }

  const ready = readyCandidates(ledger, minOccurrences).slice(0, max)
  const report: ExtractionReport = {
    dryRun: !commit,
    episodes: episodes.length,
    clusters: clusters.length,
    ready,
    nearMisses: nearMisses(clusters),
    drafted: [],
    skipped: [],
    warnings: [],
  }

  if (!commit) return report

  if (ready.length > 0) {
    if (!opts.llm?.viaAgent && !opts.llm?.model) {
      report.warnings.push(`${ready.length} candidate(s) ready but no LLM configured (--via or --model) — counts saved, no drafts written`)
    } else {
      const samples: ClusterSample[] = ready.map((candidate) => {
        // Episodes from this run when available; otherwise reload the
        // candidate's recorded occurrences by trace id — counts often cross
        // the threshold on a run whose window no longer contains them.
        let eps = byKey.get(candidate.key) ?? []
        if (eps.length === 0) {
          eps = loadEpisodesByTaskIds(db, candidate.taskIds.slice(-5), opts.sessions)
        }
        return { candidate, episodes: eps }
      }).filter((s) => s.episodes.length > 0)
      if (samples.length < ready.length) {
        report.warnings.push(`${ready.length - samples.length} ready candidate(s) had no loadable episodes (traces pruned?) — skipped`)
      }
      if (samples.length > 0) {
        const result = await distillClusters(samples, opts.llm, log)
        report.warnings.push(...result.warnings)
        report.skipped = result.skipped
        for (const mined of result.procedures) {
          const candidate = ready.find((c) => c.key === mined.cluster)
          const outcome = writeDraft(store, mined, candidate)
          if (outcome.error) {
            report.warnings.push(`draft "${mined.id}" not written: ${outcome.error}`)
            continue
          }
          markCandidate(ledger, mined.cluster, "drafted", mined.id)
          report.drafted.push({ id: mined.id, cluster: mined.cluster, count: candidate?.count ?? 0 })
          log(`draft written: ${mined.id} (${candidate?.count ?? 0} occurrences)`)
        }
      }
    }
  }

  ledger.minedThrough = scannedThrough
  writeCandidates(store.baseDir, ledger)
  return report
}

function writeDraft(store: ProcedureStore, mined: MinedProcedure, candidate?: Candidate): { error?: string } {
  if (store.get(mined.id)) return { error: "an active procedure with this id already exists" }
  if (store.getDraft(mined.id)) return { error: "a draft with this id already exists" }
  if (store.isRejected(mined.id)) return { error: "a previous draft with this id was rejected" }
  const bodyParts = [
    "## Steps",
    ...mined.steps.map((s, i) => `${i + 1}. ${s}`),
  ]
  if (mined.notes.trim()) bodyParts.push("", "## Notes", mined.notes.trim())
  try {
    store.addDraft(
      {
        id: mined.id,
        title: mined.title,
        trigger: mined.trigger,
        inputs: mined.inputs,
        expected: mined.expected || undefined,
        kpis: mined.kpis,
        tags: mined.tags,
        related: [],
        evidence: candidate?.taskIds.slice(0, 20) ?? [],
        source: `mined:${mined.cluster}`,
        status: "draft",
      },
      bodyParts.join("\n"),
    )
    return {}
  } catch (e: any) {
    return { error: e.message }
  }
}
