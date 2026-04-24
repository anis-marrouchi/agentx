// --- Prompt-size drift tracker ---
//
// Passive per-agent/channel monitor for the bytes AgentX controls before
// dispatch (historyContext + systemPromptAppend + task.message). Exposes:
//
//   recordPromptSize(key, bytes, parts)   — called from the dispatch path
//   getPromptSizeReport()                 — snapshot for /health or ops
//   warnIfPromptGrowing(key, bytes)       — returns a warning string when
//                                            the current sample is >= 1.5x
//                                            the baseline for its key
//
// Baseline is an EWMA (exponential weighted moving average) over the last
// ~20 samples per key. First few samples just seed the baseline; we only
// start flagging growth once enough samples have accumulated.
//
// This is NOT wired to an alerting backend — it emits via the daemon log.
// Route downstream as you need (journal-watch, tail+grep, etc).

export interface PromptSizeParts {
  history: number
  sysPrompt: number
  message: number
}

export interface PromptSizeSample {
  key: string
  timestamp: number
  total: number
  parts: PromptSizeParts
}

export interface PromptSizeStats {
  key: string
  samples: number
  /** EWMA of total bytes. */
  baseline: number
  /** Most recent total bytes. */
  current: number
  /** Highest observed bytes since process start. */
  peak: number
  lastAt: number
}

const ALPHA = 0.2            // EWMA smoothing — current sample weight
const WARN_MULTIPLIER = 1.5  // flag when current >= 1.5x baseline
const MIN_SAMPLES = 5        // don't warn before this many samples
const RING_SIZE = 100        // per-key most-recent-samples kept in memory

const stats = new Map<string, PromptSizeStats & { ring: PromptSizeSample[] }>()

/** Build a key for the tracker. Scoped per agent+channel+chatId because size
 *  varies meaningfully across channels (a gitlab issue reply has a different
 *  prompt shape than a telegram DM). */
export function promptSizeKey(agentId: string, channel: string, chatId?: string): string {
  return chatId ? `${agentId}:${channel}:${chatId}` : `${agentId}:${channel}`
}

/** Record a sample. Idempotent; callers may invoke on every dispatch. */
export function recordPromptSize(key: string, total: number, parts: PromptSizeParts, now: number = Date.now()): void {
  let s = stats.get(key)
  if (!s) {
    s = {
      key,
      samples: 0,
      baseline: total,   // seed with first sample so the first warn comparison is a no-op
      current: total,
      peak: total,
      lastAt: now,
      ring: [],
    }
    stats.set(key, s)
  }
  s.samples += 1
  s.baseline = ALPHA * total + (1 - ALPHA) * s.baseline
  s.current = total
  s.peak = Math.max(s.peak, total)
  s.lastAt = now
  s.ring.push({ key, timestamp: now, total, parts })
  if (s.ring.length > RING_SIZE) s.ring.shift()
}

/** Returns a warning string if the latest sample is >= 1.5x baseline and we
 *  have enough history to trust the baseline; otherwise null. */
export function warnIfPromptGrowing(key: string): string | null {
  const s = stats.get(key)
  if (!s) return null
  if (s.samples < MIN_SAMPLES) return null
  const threshold = s.baseline * WARN_MULTIPLIER
  if (s.current < threshold) return null
  const ratio = s.current / s.baseline
  return `prompt-size drift for ${key}: ${s.current} bytes is ${ratio.toFixed(2)}x baseline (${Math.round(s.baseline)} bytes over ${s.samples} samples, peak ${s.peak})`
}

/** Snapshot of all tracked keys — suitable for a /health or /metrics endpoint. */
export function getPromptSizeReport(): Array<Omit<PromptSizeStats, "key"> & { key: string }> {
  return Array.from(stats.values()).map(({ ring, ...rest }) => rest)
}

/** Test / diagnostic reset. */
export function clearPromptSizeStats(): void { stats.clear() }
