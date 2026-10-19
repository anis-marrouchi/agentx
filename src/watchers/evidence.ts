// --- Evidence on done (#1049) ---
//
// A task whose type has an evidence rule (`watchers.evidence.<type>`) is
// done only when the done signal carries proof the rule accepts:
//
//   test    a test run: at least one test passed and none failed
//   output  what the task produced, at least `minOutputChars` long
//   link    an http(s) address, on one of `linkHosts` when they are set
//
// The task's type is `context.taskType` when the caller gave one, else the
// watcher's kind (dispatch, delegation, cron). A task with no rule for its
// type closes as before. A rule's task is never closed by its reply or by
// a delegation's answer: only a done with accepted evidence closes it.

export type EvidenceType = "test" | "output" | "link"
export const EVIDENCE_TYPES: readonly EvidenceType[] = ["test", "output", "link"]

export interface EvidenceRule {
  /** The kinds of proof that close a task of this type: any one of them. */
  accept: EvidenceType[]
  /** The shortest `output` text accepted. */
  minOutputChars: number
  /** Hosts a `link` must be on (a host or any subdomain of it). Empty: any. */
  linkHosts: string[]
}

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

/** The rule for a task's type, or null when none applies. */
export function evidenceRuleFor(
  rules: Record<string, EvidenceRule> | undefined,
  w: { taskType: string | null; kind: string },
): EvidenceRule | null {
  if (!rules) return null
  return (w.taskType ? rules[w.taskType] : undefined) ?? rules[w.kind] ?? null
}

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

function hostOk(url: string, hosts: string[]): boolean {
  if (!hosts.length) return true
  let host: string
  try { host = new URL(url).hostname.toLowerCase() } catch { return false }
  return hosts.some((h) => {
    const want = h.toLowerCase()
    return host === want || host.endsWith(`.${want}`)
  })
}

/** Null when the rule accepts the evidence, else why not. */
export function checkEvidence(rule: EvidenceRule, ev: Evidence | null): string | null {
  if (!ev) return `this task needs evidence: ${requirementText(rule)}`
  if (!rule.accept.includes(ev.type)) return `${ev.type} evidence does not count for this task: ${requirementText(rule)}`
  if (ev.type === "test") {
    if (ev.failed > 0) return `${ev.failed} test${ev.failed === 1 ? "" : "s"} failed`
    if (ev.passed < 1) return "no test passed"
  }
  if (ev.type === "output" && ev.text.length < rule.minOutputChars) {
    return `the output is shorter than ${rule.minOutputChars} characters`
  }
  if (ev.type === "link" && !hostOk(ev.url, rule.linkHosts)) {
    return `the link must be on ${rule.linkHosts.join(" or ")}`
  }
  return null
}

/** What a rule asks for, in a sentence the agent reads. */
export function requirementText(rule: EvidenceRule): string {
  const parts = rule.accept.map((t) => {
    if (t === "test") return `a passing test run ({"type":"test","passed":<n>,"failed":0,"command":"<command>"})`
    if (t === "output") return `the output, at least ${rule.minOutputChars} characters ({"type":"output","text":"<output>"})`
    const on = rule.linkHosts.length ? ` on ${rule.linkHosts.join(" or ")}` : ""
    return `a link${on} ({"type":"link","url":"<url>"})`
  })
  return parts.join(", or ")
}

/** The `evidence` value of a done the rule accepts, as JSON with
 *  placeholders: what the done command shows the agent. No rule: any
 *  string closes the task. */
export function evidenceExample(rule: EvidenceRule | null): string {
  const t = rule?.accept[0]
  if (t === "test") return `{"type":"test","passed":<n>,"failed":0,"command":"<command>"}`
  if (t === "output") return `{"type":"output","text":"<at least ${rule!.minOutputChars} characters of output>"}`
  if (t === "link") return `{"type":"link","url":"https://${rule!.linkHosts[0] ?? "<host>"}/<path>"}`
  return `"<proof>"`
}

/** One line for the watcher's reason. */
export function describeEvidence(ev: Evidence): string {
  if (ev.type === "test") return `tests: ${ev.passed} passed, ${ev.failed} failed${ev.command ? ` (${ev.command})` : ""}`
  if (ev.type === "link") return `link: ${ev.url}`
  return `output: ${ev.text}`
}
