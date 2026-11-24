// --- Hub chat: the "Worked for …" fold (#2101 PR 2, R14) ---
//
// Claude Code shows an answer as the work folded under "Worked for 1m 12s",
// one line per file read, edit or command, then the answer itself. The
// Hub chat does the same from two sources:
//
//   - while the run goes: its live output (/api/task/stream). The daemon's
//     formatter (registry.ts makeStreamEventFormatter) writes one marker
//     per line: "→ Tool(input)" a tool call, "← …" its result ("← [error]"
//     a failed one), "💭 …" a thought, "· …" or ". codex …" init and done,
//     "[error] …" a refusal (dispatch hold, budget). cfParseLive keeps the
//     tool calls and the error lines and drops the rest; the text after
//     the last tool call is the answer so far.
//   - once it is done: the run's steps from GET /api/assistant/thread's
//     `runs` (assistant-runs.ts), kept 90 days.
//
// Shipped to the browser through injectFns: each function is
// self-contained or calls only another function of this file.

export interface CfStep {
  tool: string
  input: string
  error: boolean
  result?: string
}
export interface CfLive {
  steps: CfStep[]
  /** "[error] …" lines: shown as a notice, never folded away. */
  errors: string[]
  /** The text after the last tool call: the answer as it is written. */
  answer: string
}

/** A string field of a tool call's input, read from its JSON even when
 *  the daemon cut it short (…[+120 chars]). */
export function cfField(input: string, keys: string[]): string {
  for (const k of keys) {
    const m = new RegExp('"' + k + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)').exec(String(input || ""))
    if (m) return m[1].replace(/\\n/g, "\n").replace(/\\(["\\/])/g, "$1").trim()
  }
  return ""
}

/** The last part of a path. */
export function cfBase(p: string): string {
  const parts = String(p || "").split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ""
}

/** One step as one line: "Read wall.ts", "Edited index.ts", "Ran npm test". */
export function cfStepLine(tool: string, input: string): string {
  const t = String(tool || "tool")
  const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s)
  const file = cfBase(cfField(input, ["file_path", "notebook_path", "path"]))
  if (t === "Read") return "Read " + (file || "a file")
  if (t === "Edit" || t === "MultiEdit" || t === "NotebookEdit") return "Edited " + (file || "a file")
  if (t === "Write") return "Wrote " + (file || "a file")
  if (t === "Bash") return "Ran " + (cut(cfField(input, ["command"]).split(/\s*\n/)[0], 90) || "a command")
  if (t === "Grep") return "Searched for " + (cut(cfField(input, ["pattern"]), 60) || "text")
  if (t === "Glob") return "Listed " + (cut(cfField(input, ["pattern"]), 60) || "files")
  if (t === "WebFetch") return "Fetched " + (cut(cfField(input, ["url"]).replace(/^https?:\/\//, ""), 70) || "a page")
  if (t === "WebSearch") return "Searched the web for " + (cut(cfField(input, ["query"]), 60) || "something")
  if (t === "Task" || t === "Agent") return "Asked a helper: " + (cut(cfField(input, ["description"]), 60) || "a task")
  if (t === "TodoWrite") return "Updated the to-do list"
  const mcp = /^mcp__(.+?)__(.+)$/.exec(t)
  if (mcp) return "Used " + mcp[2].replace(/_/g, " ") + " (" + mcp[1].replace(/_/g, " ") + ")"
  return "Used " + t
}

/** "12s", "1m 12s", "1h 3m". */
export function cfDuration(ms: number | null | undefined): string {
  const s = Math.max(0, Math.round(Number(ms) / 1000) || 0)
  if (s < 60) return s + "s"
  if (s < 3600) return Math.floor(s / 60) + "m " + (s % 60) + "s"
  return Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m"
}

/** The live output of a run, read line by line (see the head of this file). */
export function cfParseLive(text: string): CfLive {
  const out: CfLive = { steps: [], errors: [], answer: "" }
  let since: string[] = []
  for (const line of String(text || "").split("\n")) {
    const tool = /^→ ([^(\s]+)\((.*)\)?$/.exec(line)
    if (tool) {
      out.steps.push({ tool: tool[1], input: tool[2].replace(/\)$/, ""), error: false })
      since = []
      continue
    }
    const codex = /^> codex (\S+)(?: (.*))?$/.exec(line)
    if (codex) {
      const cmd = codex[1] === "command_execution"
      out.steps.push({ tool: cmd ? "Bash" : "codex " + codex[1], input: cmd ? JSON.stringify({ command: codex[2] || "" }) : codex[2] || "", error: false })
      since = []
      continue
    }
    if (line.startsWith("← ")) {
      const step = out.steps[out.steps.length - 1]
      if (step) {
        step.error = line.startsWith("← [error] ")
        const result = line.slice(step.error ? 10 : 2).replace(/\u2028/g, "\n")
        if (result) step.result = result
      }
      continue
    }
    if (/^\[error\] /.test(line)) { out.errors.push(line.slice(8).split(" ↵ ").join("\n").trim()); continue }
    // Results, thoughts, init and done lines, the finish marker: not shown.
    if (/^(← |💭|· |\. codex|< codex |\[task finished\])/.test(line)) continue
    since.push(line)
  }
  out.answer = since.join("\n").replace(/^\n+/, "").replace(/\s+$/, "")
  return out
}

/** The fold. `key` names it so a reader's open fold stays open across
 *  repaints (`open`); `live` while the run goes ("Working for 42s"). */
export function cfFoldHtml(o: { key: string; steps: CfStep[]; ms: number | null; live?: boolean; open?: boolean }): string {
  const esc = (s: unknown) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c])
  const steps = o.steps || []
  if (!steps.length && !o.live) return ""
  const n = steps.length
  const time = o.ms != null ? cfDuration(o.ms) : ""
  const head = (o.live ? "Working" + (time ? " for " + time : "…") : "Worked" + (time ? " for " + time : "")) +
    (n ? " · " + n + (n === 1 ? " step" : " steps") : "")
  const failed = steps.filter((s) => s.error).length
  const last = o.live && n ? '<span class="hc__foldnow">' + esc(cfStepLine(steps[n - 1].tool, steps[n - 1].input)) + "</span>" : ""
  const lines = steps.map((s) => '<li class="hc__step' + (s.error ? " is-err" : "") + '">' + esc(cfStepLine(s.tool, s.input)) + (s.error ? " <b>failed</b>" : "") +
    (s.result ? "<pre>" + esc(s.result) + "</pre>" : "") + "</li>").join("")
  return '<details class="hc__fold' + (o.live ? " is-live" : "") + '" data-hc-fold="' + esc(o.key) + '"' + (o.open ? " open" : "") + ">" +
    "<summary>" + esc(head) + (failed ? ' <span class="hc__foldbad">' + failed + " failed</span>" : "") + last + "</summary>" +
    (n ? '<ol class="hc__steps">' + lines + "</ol>" : "") + "</details>"
}
