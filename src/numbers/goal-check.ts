import type { CheckResult } from "@/requests/checkers"
import { describePeriod, formatValue, parseNumberId } from "./model"
import type { NumberStore } from "./store"

// --- The `number` check of a goal (#1826) ---
//
// {kind:"number", number:"<id>", atLeast:1000} or {…, atMost:2}: met when
// the newest reading of the number crosses the threshold. A goal can close
// itself on a number this way. No reading (none yet, or the newest read
// failed) is unverifiable, never a 0.

export interface NumberCheck {
  kind: "number"
  number: string
  atLeast?: number
  atMost?: number
}

export function parseNumberCheck(raw: Record<string, unknown>): NumberCheck | string {
  const id = parseNumberId(raw.number ?? raw.id)
  if (typeof id !== "string") return `check.number: ${id.error}`
  const has = (k: string) => raw[k] !== undefined && raw[k] !== null && raw[k] !== ""
  if (has("atLeast") === has("atMost")) return "a number check needs one of atLeast or atMost: the threshold its reading must cross"
  const key = has("atLeast") ? "atLeast" : "atMost"
  const value = Number(raw[key])
  if (!Number.isFinite(value)) return `check.${key} must be a number`
  return { kind: "number", number: id, [key]: value }
}

export function readNumberCheck(v: any): NumberCheck | null {
  if (!v || typeof v !== "object" || v.kind !== "number") return null
  const spec = parseNumberCheck(v)
  return typeof spec === "string" ? null : spec
}

export function describeNumberCheck(c: NumberCheck): string {
  return c.atLeast !== undefined ? `number ${c.number} reads ≥ ${formatValue(c.atLeast)}` : `number ${c.number} reads ≤ ${formatValue(c.atMost!)}`
}

/** The newest reading against the threshold. Never throws. */
export function checkNumber(c: NumberCheck, store: NumberStore | undefined): CheckResult {
  if (!store) return { verdict: "unverifiable", detail: "this node keeps no numbers" }
  const n = store.get(c.number)
  if (!n) return { verdict: "unverifiable", detail: `no number "${c.number}"` }
  const latest = store.readings(c.number, 1)[0]
  if (!latest || latest.value === null) {
    return { verdict: "unverifiable", detail: `${c.number}: no reading${latest?.error ? ` (${latest.error})` : ""}` }
  }
  const met = c.atLeast !== undefined ? latest.value >= c.atLeast : latest.value <= c.atMost!
  const detail = `${n.name}: ${formatValue(latest.value, n.unit)} for ${describePeriod({ start: latest.periodStart, end: latest.periodEnd })}`
  return { verdict: met ? "met" : "not_met", detail }
}
