import { z } from "zod"
import { callPromotionLlm, type PromotionLlmOptions } from "@/wiki/promote"
import { buildExtractionPrompt, type ClusterSample } from "./prompts"

// --- Distillation ---
// One LLM round-trip per extraction run: all ready clusters in one prompt,
// balanced-JSON parse (same defensive posture as wiki promote), then a
// deterministic black-box lint. A draft that leaks system vocabulary gets
// ONE correction round; if it still leaks, it is dropped — a leaking draft
// is never written.

export const minedProcedureSchema = z.object({
  cluster: z.string(),
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "id must be lower-kebab"),
  title: z.string().min(1),
  trigger: z.string().min(1),
  inputs: z.array(z.string()).default([]),
  expected: z.string().default(""),
  kpis: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  steps: z.array(z.string()).min(2).max(10),
  notes: z.string().default(""),
})

export type MinedProcedure = z.infer<typeof minedProcedureSchema>

export interface DistillResult {
  procedures: MinedProcedure[]
  skipped: Array<{ cluster: string; reason: string }>
  warnings: string[]
}

/** System vocabulary that must never appear in user-perspective procedure
 *  text. Word-boundary matched, case-insensitive. Common English verbs that
 *  double as tool names (read, write, edit) are deliberately NOT here. */
const BANNED = new RegExp(
  "\\b(" +
    [
      "bash", "zsh", "grep", "curl", "sed", "awk", "regex", "terminal", "shell",
      "script", "cli", "mcp", "api", "json", "yaml", "sql", "sqlite", "http", "localhost",
      "llm", "claude", "anthropic", "gpt", "chatgpt", "agent", "assistant", "bot",
      "model", "session", "prompt", "token", "daemon", "webhook", "endpoint",
      "database", "workflow", "stdout", "stderr", "subprocess",
    ].join("|") +
    ")\\b",
  "i",
)

/** Returns violations like `steps[2]: "grep"` — empty means clean. */
export function lintBlackBox(p: MinedProcedure): string[] {
  const violations: string[] = []
  const check = (label: string, text: string) => {
    const m = text.match(BANNED)
    if (m) violations.push(`${label}: "${m[0]}"`)
  }
  check("id", p.id)
  check("title", p.title)
  check("trigger", p.trigger)
  check("expected", p.expected)
  check("notes", p.notes)
  p.steps.forEach((s, i) => check(`steps[${i}]`, s))
  p.inputs.forEach((s, i) => check(`inputs[${i}]`, s))
  if (!/^when /i.test(p.trigger.trim())) violations.push(`trigger must start with "When "`)
  return violations
}

/** Balanced-JSON extraction + schema validation. Procedures referencing a
 *  cluster key we didn't offer are hallucinations — dropped. */
export function parseExtractionResponse(
  text: string,
  offeredKeys: Set<string>,
): DistillResult | { error: string } {
  const start = text.indexOf("{")
  if (start === -1) return { error: "no JSON object in response" }
  let depth = 0
  let end = -1
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escaped) { escaped = false; continue }
    if (ch === "\\") { escaped = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === "{") depth++
    else if (ch === "}") { depth--; if (depth === 0) { end = i + 1; break } }
  }
  if (end === -1) return { error: "unbalanced JSON in response" }

  let parsed: any
  try {
    parsed = JSON.parse(text.slice(start, end))
  } catch (e: any) {
    return { error: `JSON parse error: ${e.message}` }
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.procedures)) {
    return { error: "response JSON missing procedures array" }
  }

  const warnings: string[] = []
  const procedures: MinedProcedure[] = []
  for (const raw of parsed.procedures) {
    const result = minedProcedureSchema.safeParse(raw)
    if (!result.success) {
      warnings.push(`procedure dropped (schema): ${result.error.issues[0]?.message ?? "invalid"}`)
      continue
    }
    if (!offeredKeys.has(result.data.cluster)) {
      warnings.push(`procedure "${result.data.id}" references unknown cluster "${result.data.cluster}" — dropped`)
      continue
    }
    procedures.push(result.data)
  }

  const skipped: Array<{ cluster: string; reason: string }> = []
  for (const s of Array.isArray(parsed.skipped) ? parsed.skipped : []) {
    if (typeof s?.cluster !== "string" || !offeredKeys.has(s.cluster)) continue
    skipped.push({ cluster: s.cluster, reason: typeof s.reason === "string" ? s.reason : "" })
  }
  return { procedures, skipped, warnings }
}

export async function distillClusters(
  samples: ClusterSample[],
  llm: PromotionLlmOptions,
  log: (msg: string) => void = () => {},
): Promise<DistillResult> {
  const offeredKeys = new Set(samples.map((s) => s.candidate.key))
  const prompt = buildExtractionPrompt(samples)
  const chatId = llm.chatId ?? "procedure-miner"

  const reply = await callPromotionLlm(prompt, { ...llm, chatId })
  let result = parseExtractionResponse(reply, offeredKeys)

  // One correction round covering both failure modes: unparseable reply, or
  // parseable but leaking system vocabulary.
  let feedback: string | null = null
  if ("error" in result) {
    feedback = result.error
  } else {
    const leaks = result.procedures
      .map((p) => ({ p, violations: lintBlackBox(p) }))
      .filter((x) => x.violations.length > 0)
    if (leaks.length > 0) {
      feedback = leaks
        .map((x) => `procedure "${x.p.id}" uses forbidden system vocabulary — ${x.violations.join("; ")}. Rewrite in plain activity language.`)
        .join("\n")
    }
  }

  if (feedback !== null) {
    log(`retrying distillation: ${feedback.slice(0, 200)}`)
    const retryReply = await callPromotionLlm(prompt, { ...llm, chatId }, feedback)
    result = parseExtractionResponse(retryReply, offeredKeys)
  }
  if ("error" in result) {
    return { procedures: [], skipped: [], warnings: [`distillation failed: ${result.error}`] }
  }

  // Final gate: drop anything still leaking. Never write a leaking draft.
  const clean: MinedProcedure[] = []
  const warnings = [...result.warnings]
  for (const p of result.procedures) {
    const violations = lintBlackBox(p)
    if (violations.length > 0) {
      warnings.push(`procedure "${p.id}" still leaks system vocabulary after retry — dropped (${violations.join("; ")})`)
      continue
    }
    clean.push(p)
  }
  return { procedures: clean, skipped: result.skipped, warnings }
}
