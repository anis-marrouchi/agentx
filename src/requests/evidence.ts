// --- Evidence on a proof (#1049) ---
//
// What a done signal or a promise's proof carries:
//
//   test    a test run: passed and failed counts
//   output  what the task produced
//   link    an http(s) address
//
// Parsed here; requests/promise.ts turns it into a proof.

export type EvidenceType = "test" | "output" | "link"
export const EVIDENCE_TYPES: readonly EvidenceType[] = ["test", "output", "link"]

export type Evidence =
  | { type: "test"; passed: number; failed: number; command?: string; output?: string }
  | { type: "output"; text: string }
  | { type: "link"; url: string }

const OUTPUT_MAX = 2000
const URL_MAX = 1000
const COMMAND_MAX = 200
const TEST_OUTPUT_MAX = 500

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")
const count = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null)
const isUrl = (s: string) => /^https?:\/\/\S+$/i.test(s)

/** Reads the `evidence` of a done signal. A plain string is a link when it
 *  is an http(s) address, else an output. Null: no evidence given. A string
 *  result is why the evidence could not be read. */
export function parseEvidence(raw: unknown): Evidence | null | string {
  if (raw === undefined || raw === null) return null
  if (typeof raw === "string") {
    const s = raw.trim()
    if (!s) return null
    if (!isUrl(s)) return { type: "output", text: s.slice(0, OUTPUT_MAX) }
    // A cut link points somewhere else: refused, as in the object form.
    return s.length > URL_MAX ? `url is longer than ${URL_MAX} characters` : { type: "link", url: s }
  }
  if (typeof raw !== "object" || Array.isArray(raw)) return "evidence must be a string or an object with a type"
  const o = raw as Record<string, unknown>
  switch (o.type) {
    case "test": {
      const passed = count(o.passed)
      const failed = count(o.failed)
      if (passed === null || failed === null) return "test evidence needs passed and failed as whole numbers"
      const command = str(o.command).slice(0, COMMAND_MAX)
      const output = str(o.output).slice(0, TEST_OUTPUT_MAX)
      return { type: "test", passed, failed, ...(command ? { command } : {}), ...(output ? { output } : {}) }
    }
    case "output": {
      const text = str(o.text)
      if (!text) return "output evidence needs text"
      return { type: "output", text: text.slice(0, OUTPUT_MAX) }
    }
    case "link": {
      const url = str(o.url)
      if (!isUrl(url)) return "link evidence needs an http(s) url"
      if (url.length > URL_MAX) return `url is longer than ${URL_MAX} characters`
      return { type: "link", url }
    }
    default:
      return `evidence type must be one of ${EVIDENCE_TYPES.join(", ")}`
  }
}
