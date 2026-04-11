import { tokenize } from "../memory/bm25"

// --- Behavioral Drift Detection ---
//
// Detects silent behavioral shifts after compaction or session boundaries.
// Three signals, all zero-AI (pure signal processing):
//
// 1. Ghost lexicon decay — domain vocabulary disappearing after compaction
// 2. Tool-call sequence shift — Jaccard distance on tool usage patterns
// 3. Semantic drift — keyword overlap decline across session boundaries
//
// Inspired by CrewAI #5155 and agent-morrow/compression-monitor.

export interface BehavioralFingerprint {
  /** Domain vocabulary: word → frequency */
  lexicon: Map<string, number>
  /** Tool call sequence: tool names in order */
  toolCalls: string[]
  /** Top keywords by frequency (for quick comparison) */
  topKeywords: string[]
  /** Timestamp of fingerprint capture */
  capturedAt: string
  /** Number of messages in the sample */
  messageCount: number
}

export interface DriftReport {
  /** 0-1 score: 0 = no drift, 1 = complete drift */
  overallScore: number
  /** Ghost lexicon decay: percentage of domain words that disappeared */
  lexiconDecay: number
  /** Tool-call Jaccard distance: 0 = identical patterns, 1 = completely different */
  toolShift: number
  /** Keyword overlap decline: percentage of shared keywords lost */
  semanticDrift: number
  /** Domain words that disappeared */
  lostWords: string[]
  /** New tool calls that weren't in the baseline */
  newTools: string[]
  /** Missing tool calls that were in the baseline */
  missingTools: string[]
}

/**
 * Build a behavioral fingerprint from agent messages.
 * Call this BEFORE compaction to establish a baseline.
 */
export function buildFingerprint(
  messages: Array<{ role: string; content: string; name?: string }>,
  toolCalls?: string[],
): BehavioralFingerprint {
  const lexicon = new Map<string, number>()

  // Build vocabulary from agent responses
  for (const msg of messages) {
    if (msg.role !== "agent") continue
    const words = tokenize(msg.content)
    for (const word of words) {
      lexicon.set(word, (lexicon.get(word) || 0) + 1)
    }
  }

  // Top keywords by frequency (domain vocabulary)
  const topKeywords = [...lexicon.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50)
    .map(([word]) => word)

  return {
    lexicon,
    toolCalls: toolCalls || [],
    topKeywords,
    capturedAt: new Date().toISOString(),
    messageCount: messages.length,
  }
}

/**
 * Compare two fingerprints and produce a drift report.
 * Call this AFTER compaction with the new session's fingerprint.
 */
export function detectDrift(
  baseline: BehavioralFingerprint,
  current: BehavioralFingerprint,
): DriftReport {
  // 1. Ghost lexicon decay: how many baseline domain words are missing?
  const lexiconDecay = computeLexiconDecay(baseline, current)

  // 2. Tool-call sequence shift: Jaccard distance on tool usage
  const { distance: toolShift, newTools, missingTools } = computeToolShift(baseline, current)

  // 3. Semantic drift: keyword overlap decline
  const semanticDrift = computeSemanticDrift(baseline, current)

  // Overall score: weighted average (lexicon decay matters most)
  const overallScore = Math.min(1, (lexiconDecay * 0.4) + (toolShift * 0.3) + (semanticDrift * 0.3))

  // Lost domain words
  const lostWords = baseline.topKeywords.filter(
    word => !current.lexicon.has(word) || (current.lexicon.get(word) || 0) === 0,
  ).slice(0, 10)

  return {
    overallScore: Math.round(overallScore * 100) / 100,
    lexiconDecay: Math.round(lexiconDecay * 100) / 100,
    toolShift: Math.round(toolShift * 100) / 100,
    semanticDrift: Math.round(semanticDrift * 100) / 100,
    lostWords,
    newTools,
    missingTools,
  }
}

/**
 * Ghost lexicon decay: percentage of baseline's top domain words
 * that disappeared from the current fingerprint.
 */
function computeLexiconDecay(
  baseline: BehavioralFingerprint,
  current: BehavioralFingerprint,
): number {
  if (baseline.topKeywords.length === 0) return 0

  let missing = 0
  for (const word of baseline.topKeywords) {
    if (!current.lexicon.has(word)) missing++
  }

  return missing / baseline.topKeywords.length
}

/**
 * Tool-call sequence shift: Jaccard distance between tool usage sets.
 * J(A,B) = |A ∩ B| / |A ∪ B|, distance = 1 - J
 */
function computeToolShift(
  baseline: BehavioralFingerprint,
  current: BehavioralFingerprint,
): { distance: number; newTools: string[]; missingTools: string[] } {
  const baseSet = new Set(baseline.toolCalls)
  const currSet = new Set(current.toolCalls)

  if (baseSet.size === 0 && currSet.size === 0) {
    return { distance: 0, newTools: [], missingTools: [] }
  }

  const intersection = [...baseSet].filter(t => currSet.has(t))
  const union = new Set([...baseSet, ...currSet])
  const jaccard = intersection.length / union.size
  const distance = 1 - jaccard

  const newTools = [...currSet].filter(t => !baseSet.has(t))
  const missingTools = [...baseSet].filter(t => !currSet.has(t))

  return { distance, newTools, missingTools }
}

/**
 * Semantic drift: keyword overlap decline.
 * Compares top keywords between baseline and current.
 */
function computeSemanticDrift(
  baseline: BehavioralFingerprint,
  current: BehavioralFingerprint,
): number {
  if (baseline.topKeywords.length === 0) return 0

  const currentSet = new Set(current.topKeywords)
  let overlap = 0

  for (const word of baseline.topKeywords) {
    if (currentSet.has(word)) overlap++
  }

  // Drift = 1 - overlap ratio
  return 1 - (overlap / baseline.topKeywords.length)
}

// --- Per-agent fingerprint persistence ---

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs"
import { resolve } from "path"

const DRIFT_DIR = ".agentx/drift"

/**
 * Save a behavioral fingerprint for an agent (pre-compaction baseline).
 */
export function saveFingerprint(
  agentId: string,
  fingerprint: BehavioralFingerprint,
  baseDir: string = process.cwd(),
): void {
  const dir = resolve(baseDir, DRIFT_DIR)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const serialized = {
    ...fingerprint,
    lexicon: Object.fromEntries(fingerprint.lexicon),
  }

  writeFileSync(
    resolve(dir, `${agentId}.json`),
    JSON.stringify(serialized, null, 2),
  )
}

/**
 * Load the saved fingerprint for an agent.
 */
export function loadFingerprint(
  agentId: string,
  baseDir: string = process.cwd(),
): BehavioralFingerprint | null {
  const file = resolve(baseDir, DRIFT_DIR, `${agentId}.json`)
  if (!existsSync(file)) return null

  try {
    const data = JSON.parse(readFileSync(file, "utf-8"))
    return {
      ...data,
      lexicon: new Map(Object.entries(data.lexicon)),
    }
  } catch {
    return null
  }
}
