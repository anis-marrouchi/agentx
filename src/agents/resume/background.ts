// --- Background work a run started, and the work dirs it left behind (#1260) ---
//
// A run can start work that keeps going after the tool call returns: a
// background subagent, or a shell command with run_in_background. The daemon
// only knows the run itself, so a restart that cuts the run off kills that
// work too, mid-edit, and nothing says where it was. The registry feeds each
// tool call through backgroundWorkOf() while the run is live (the trace's
// copy of the input is clipped, so it can't be read back later); when a
// restart interrupts the run, the list is saved on its trace as one
// "background_work" step, and the resume note and the reports after boot
// name the jobs and their work dirs.
//
// Pure functions, unit tested.

export interface BackgroundWork {
  kind: "subagent" | "shell" | "job"
  /** Tool that started it, e.g. "Agent" or "Bash". */
  tool: string
  /** Its description, or the start of its command. */
  label: string
  /** Folders it worked in, as far as the call names them. */
  dirs: string[]
}

export const BACKGROUND_WORK_STEP = "background_work"
const MAX_JOBS = 20
const MAX_DIRS = 5
const MAX_LABEL_CHARS = 120

const SUBAGENT_TOOLS = new Set(["agent", "task"])
const SHELL_TOOLS = new Set(["bash", "shell", "powershell"])

/** The background work one tool call starts, or null when it runs in the
 *  foreground (the run waits for it, so the run's own end covers it). */
export function backgroundWorkOf(tool: string, input: unknown): BackgroundWork | null {
  if (!input || typeof input !== "object") return null
  const i = input as Record<string, unknown>
  if (i.run_in_background !== true) return null
  const name = tool.toLowerCase()
  const kind: BackgroundWork["kind"] = SUBAGENT_TOOLS.has(name) ? "subagent" : SHELL_TOOLS.has(name) ? "shell" : "job"
  const command = str(i.command)
  const prompt = str(i.prompt)
  const label = oneLine(str(i.description) || command || prompt || tool).slice(0, MAX_LABEL_CHARS)
  const dirs = uniq([str(i.cwd), str(i.workdir), ...workDirsIn(command), ...workDirsIn(prompt)].filter(Boolean)).slice(0, MAX_DIRS)
  return { kind, tool, label, dirs }
}

const PATH = String.raw`["'\`]?((?:~|/)[^\s"'\`;&|()<>]*)`
const DIR_PATTERNS = [
  new RegExp(String.raw`(?:^|[\s;&|(\`])cd\s+${PATH}`, "g"),
  new RegExp(String.raw`\bgit\s+-C\s+${PATH}`, "g"),
  new RegExp(String.raw`\bwork(?:ing)?[ -]?dir(?:ectory)?\b\s*(?:is|:|=)?\s*${PATH}`, "gi"),
]
/** `git clone <url> X` and `git worktree add X`: options first, then the
 *  args; these options take a value. */
const GIT_ARG_COMMANDS = [
  { re: /\bgit\s+clone\s+([^;&|\n`]*)/g, dirArg: 1, valued: new Set(["-b", "--branch", "-o", "--origin", "--depth", "--reference", "-c", "--config", "--filter", "-j", "--jobs"]) },
  { re: /\bgit\s+worktree\s+add\s+([^;&|\n`]*)/g, dirArg: 0, valued: new Set(["-b", "-B", "--reason"]) },
]

/** Folders a command or prompt says it works in: `cd X`, `git -C X`,
 *  `git clone <url> X`, `git worktree add X`, "work dir: X". */
export function workDirsIn(text: string): string[] {
  if (!text) return []
  const out: string[] = []
  for (const re of DIR_PATTERNS) {
    for (const m of text.matchAll(re)) out.push(m[1])
  }
  for (const cmd of GIT_ARG_COMMANDS) {
    for (const m of text.matchAll(cmd.re)) {
      const args: string[] = []
      const tokens = m[1].trim().split(/\s+/)
      for (let n = 0; n < tokens.length; n++) {
        const t = tokens[n]
        if (t.startsWith("-")) {
          if (cmd.valued.has(t)) n++
          continue
        }
        args.push(t.replace(/^["'`]|["'`]$/g, ""))
      }
      const dir = args[cmd.dirArg]
      if (dir && /^(?:~|\/)/.test(dir)) out.push(dir)
    }
  }
  return uniq(out.map((d) => d.replace(/[.,:]+$/, "").replace(/(.)\/+$/, "$1")).filter((d) => d !== "~" && d !== "/"))
}

/** Add the background work one stream-json event starts to a run's list,
 *  bounded. Mirrors the tool_use walk of the trace step capture. */
export function noteBackgroundWork(list: BackgroundWork[], event: any): void {
  if (event?.type !== "assistant" || !Array.isArray(event.message?.content)) return
  for (const block of event.message.content) {
    if (block?.type !== "tool_use" || typeof block.name !== "string") continue
    const job = backgroundWorkOf(block.name, block.input)
    if (job && list.length < MAX_JOBS) list.push(job)
  }
}

/** Every work dir the jobs name, once each. */
export function backgroundDirs(jobs: BackgroundWork[]): string[] {
  return uniq(jobs.flatMap((j) => j.dirs))
}

/** The jobs as one log line, e.g. for the shutdown log. */
export function describeBackgroundWork(jobs: BackgroundWork[]): string {
  const names = jobs.map((j) => `${j.kind} "${j.label.slice(0, 60)}"`).join(", ")
  const dirs = backgroundDirs(jobs)
  return `${jobs.length} background job(s): ${names}${dirs.length ? `; work dirs: ${dirs.join(", ")}` : ""}`
}

/** Stored as a trace step's input; read back with decodeBackgroundWork. */
export function encodeBackgroundWork(jobs: BackgroundWork[]): string {
  return JSON.stringify(jobs.slice(0, MAX_JOBS))
}

export function decodeBackgroundWork(raw: string | null | undefined): BackgroundWork[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((j) => j && typeof j.label === "string" && typeof j.tool === "string")
      .map((j) => ({
        kind: j.kind === "subagent" || j.kind === "shell" ? j.kind : "job",
        tool: j.tool,
        label: j.label,
        dirs: Array.isArray(j.dirs) ? j.dirs.filter((d: unknown) => typeof d === "string") : [],
      }))
  } catch {
    return []
  }
}

/** Lines for a resumed run's note: what the restart stopped, and what to
 *  check before starting over. Empty when it had no background work. */
export function backgroundNoteLines(jobs: BackgroundWork[]): string[] {
  if (jobs.length === 0) return []
  const lines = [`You had started background work, and the restart stopped it (${jobs.length}):`]
  jobs.forEach((j, n) => {
    lines.push(`${n + 1}. ${j.kind} (${j.tool}): ${j.label}${j.dirs.length ? ` — in ${j.dirs.join(", ")}` : ""}`)
  })
  const dirs = backgroundDirs(jobs)
  lines.push(
    dirs.length
      ? `It may have stopped mid-edit. Check ${dirs.length === 1 ? "that work dir" : "those work dirs"} first (git status, git log): ` +
        "keep and finish the work left there, commit and push it, rather than starting over. Start again any job that hadn't finished."
      : "It may have stopped mid-edit. Check what it changed before starting it again.",
  )
  return lines
}

/** A short clause for a report: "It had 2 background job(s) going; work
 *  left in /a, /b." Empty when it had none. */
export function backgroundReportClause(jobs: BackgroundWork[]): string {
  if (jobs.length === 0) return ""
  const dirs = backgroundDirs(jobs)
  return `It had ${jobs.length} background job(s) going, stopped by the restart${dirs.length ? `; work left in ${dirs.join(", ")}` : ""}.`
}

function str(v: unknown): string {
  return typeof v === "string" ? v : ""
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)]
}
