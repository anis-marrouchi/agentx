import { z } from "zod"

// --- Routine autonomy levels: the rule sets ---
//
// A routine (cron job or workflow agent step) may run below its agent's full
// power:
//
//   report  — read-only. No file writes, no mutating shell, no outward-posting
//             tools. The only output is the final answer, which the scheduler
//             delivers.
//   propose — may edit files, commit, push a feature branch, open an MR/PR or
//             a draft. Never merge, deploy, delete, force-push, or touch
//             production.
//   act     — unchanged: whatever the agent may normally do.
//
// This module is PURE: (level, tool call) -> allow | block. It is evaluated
// by the daemon for every tool call of a restricted task (see
// autonomy-enforce.ts for the wiring). Deterministic by construction, like
// the rest of the guard.
//
// Shape of the two restricted levels differs on purpose:
//   - report is an ALLOWLIST. A read-only posture cannot be expressed as
//     "everything except the dangerous things" — `python -c`, `node x.js`
//     or a `curl -d` are all writes nobody would list. Unknown => blocked.
//   - propose is a DENYLIST over a working agent. Its job is to stop the
//     irreversible, outward steps (merge/deploy/delete/force-push), not to
//     make the agent useless. A determined agent can evade a denylist by
//     indirection (write a script, then run it); propose is a guardrail for
//     honest routines, report is the hard boundary.

export const autonomyLevelSchema = z.enum(["report", "propose", "act"])
export type AutonomyLevel = z.infer<typeof autonomyLevelSchema>

/** True for the levels that need per-task enforcement. */
export function isRestricted(level: AutonomyLevel | undefined | null): level is "report" | "propose" {
  return level === "report" || level === "propose"
}

export interface AutonomyInput {
  tool: string
  command?: string
  filePath?: string
}

export interface AutonomyDecision {
  allowed: boolean
  /** Stable id, e.g. "autonomy.report.write". Null when allowed. */
  ruleId: string | null
  reason: string | null
}

const ALLOW: AutonomyDecision = { allowed: true, ruleId: null, reason: null }
const block = (level: string, id: string, reason: string): AutonomyDecision => ({
  allowed: false,
  ruleId: `autonomy.${level}.${id}`,
  reason,
})

// ---------------------------------------------------------------- tools

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"])

/** Native tools that never change anything outside the conversation. */
const REPORT_SAFE_TOOLS = new Set([
  "Read", "Glob", "Grep", "LS", "NotebookRead", "WebFetch", "WebSearch",
  "TodoWrite", "TodoRead", "Task", "Agent", "Skill", "ToolSearch",
  "BashOutput", "KillShell", "ExitPlanMode", "EnterPlanMode",
  "ListMcpResourcesTool", "ReadMcpResourceTool",
])

/** Split a tool name into lowercase words: `mcp__gitlab__create_merge_request`
 *  -> [mcp, gitlab, create, merge, request]; camelCase splits too. */
export function toolWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
}

/** The action words of an MCP tool name (server prefix dropped), with the
 *  nouns "merge request" / "pull request" folded so `create_merge_request`
 *  reads as create-an-MR, not as a merge. */
export function mcpActionWords(name: string): string[] {
  return toolWords(name)
    .slice(2)
    .join(" ")
    .replace(/\b(merge|pull)\s+requests?\b/g, "mergerequest")
    .split(" ")
    .filter(Boolean)
}

const READ_VERBS = new Set([
  "get", "list", "search", "read", "view", "fetch", "query", "find", "show", "describe",
  "status", "diff", "inspect", "lookup", "count", "stats", "browse", "whoami", "download",
])
/** Irreversible or outward-facing verbs. Blocked in propose, and in report. */
const DESTRUCTIVE_VERBS = new Set([
  "merge", "delete", "remove", "destroy", "drop", "deploy", "publish", "release", "approve",
  "archive", "revoke", "purge", "close", "transfer", "force", "rollback", "restart", "erase",
  "unprotect", "truncate", "wipe", "kill", "terminate", "unpublish", "promote",
])
/** Any state change at all. Blocked in report. */
const MUTATING_VERBS = new Set([
  ...DESTRUCTIVE_VERBS,
  "create", "update", "post", "send", "write", "edit", "add", "set", "comment", "reply",
  "push", "run", "execute", "exec", "trigger", "upload", "move", "rename", "cancel", "retry",
  "assign", "label", "react", "invite", "notify", "schedule", "start", "stop", "submit", "save",
  "patch", "put", "insert", "upsert", "apply", "install", "import", "mark", "toggle", "enable",
  "disable", "open", "commit", "sync", "reset", "store", "remember", "forget", "broadcast",
  "message", "call", "dispatch", "enqueue", "resolve", "unassign", "lock", "unlock", "pin",
])

// ---------------------------------------------------------------- shell view

/**
 * The part of a shell command the shell will actually EXECUTE, flattened so
 * every command position can be inspected:
 *   - single-quoted text is blanked (truly literal),
 *   - double-quoted text is blanked unless it contains `$(`/backticks, in
 *     which case the substitution is executed and must stay visible,
 *   - heredoc bodies are blanked unless the delimiter is unquoted and the
 *     body substitutes commands.
 * Returns `null` for input too irregular to judge (unbalanced quotes), which
 * callers treat as "block" in report mode.
 */
export function shellView(command: string): string | null {
  // Heredocs: blank the body unless the delimiter is unquoted AND the body
  // substitutes commands (then the shell executes it — keep it visible).
  const text = command.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1([\s\S]*?)^\s*\2\s*$/gm,
    (m, quote: string, _d: string, body: string) =>
      !quote && /\$\(|`/.test(body) ? m : m.split("\n")[0] + "\n")
  let out = ""
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === "\\") { out += text.slice(i, i + 2); i += 2; continue }
    if (c === "'") {
      const end = text.indexOf("'", i + 1)
      if (end < 0) return null
      out += "''"
      i = end + 1
      continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1
      if (j >= text.length) return null
      const inner = text.slice(i + 1, j)
      out += /\$\(|`/.test(inner) ? ` ${inner} ` : '""'
      i = j + 1
      continue
    }
    out += c
    i++
  }
  return out
}

/** Split a shell view into simple-command segments (words arrays). */
export function shellSegments(view: string): string[][] {
  return view
    .split(/\|\||&&|[;|&\n`()]|\$\(|<\(|>\(/)
    .map((s) => s.trim().split(/\s+/).filter(Boolean))
    .filter((w) => w.length > 0)
}

const SHELL_KEYWORDS_STRIP = new Set(["then", "do", "else", "elif", "if", "while", "until", "!", "{", "}", "time"])
const SHELL_KEYWORDS_SKIP = new Set(["done", "fi", "esac", "for", "case", "select", "in", ";;"])

/** Drop leading keywords and `VAR=value` assignments; return the command words. */
function commandWords(words: string[]): string[] {
  let i = 0
  while (i < words.length) {
    const w = words[i]
    if (SHELL_KEYWORDS_SKIP.has(w)) return []
    if (SHELL_KEYWORDS_STRIP.has(w) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { i++; continue }
    break
  }
  return words.slice(i)
}

/** `git [-C dir] [--flags] <sub> <rest...>` -> { sub, rest }. */
function gitSubcommand(args: string[]): { sub: string | undefined; rest: string[] } {
  let i = 0
  while (i < args.length && args[i].startsWith("-")) i += /^-(C|c)$|^--(git-dir|work-tree|namespace)$/.test(args[i]) ? 2 : 1
  return { sub: args[i], rest: args.slice(i + 1) }
}

/** Command name without its path: `/usr/bin/git` -> `git`. */
const baseName = (w: string) => w.replace(/^.*\//, "")

// ---------------------------------------------------------------- report

const REPORT_SHELL_COMMANDS = new Set([
  "ls", "pwd", "cd", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "fd", "tree",
  "stat", "file", "du", "df", "date", "whoami", "id", "hostname", "uname", "which", "type",
  "sort", "uniq", "cut", "tr", "diff", "cmp", "comm", "basename", "dirname", "realpath",
  "readlink", "jq", "column", "nl", "seq", "true", "false", "test", "[", "sleep", "ps",
  "uptime", "echo", "printf", "base64", "md5", "md5sum", "shasum", "sha256sum", "less", "more",
  "printenv", "dig", "nslookup", "host", "find", "git", "gh", "glab", "curl",
])

const GIT_READ = new Set([
  "status", "log", "diff", "show", "rev-parse", "ls-files", "ls-tree", "blame", "shortlog",
  "describe", "cat-file", "grep", "branch", "tag", "remote", "config", "reflog", "rev-list",
  "merge-base", "name-rev", "show-ref", "for-each-ref", "whatchanged",
])
const GH_READ_ACTIONS = new Set(["view", "list", "diff", "status", "checks", "ls"])

function reportShellWord(words: string[]): string | null {
  const [cmd, ...args] = words
  const base = cmd.replace(/^.*\//, "")
  if (!REPORT_SHELL_COMMANDS.has(base)) return `\`${base}\` is not a read-only command`
  const has = (re: RegExp) => args.some((a) => re.test(a))
  switch (base) {
    case "find":
      if (has(/^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/)) return "find with -exec/-delete"
      return null
    case "sort":
      if (has(/^(-o|--output)/)) return "sort -o writes a file"
      return null
    case "git": {
      if (has(/^(-c|--exec-path|--output)/)) return "git option that can execute or write"
      const { sub, rest } = gitSubcommand(args)
      if (!sub || !GIT_READ.has(sub)) return `git ${sub ?? ""} is not read-only`.trim()
      if (sub === "branch" && rest.some((a) => /^-(d|D|m|M|c|C|f|u)$|^--(delete|move|copy|force|set-upstream|unset-upstream|edit-description)/.test(a) || !a.startsWith("-"))) {
        return "git branch that changes branches"
      }
      if (sub === "tag" && rest.some((a) => !/^(-l|--list|-n\d*|--contains|--points-at|--sort=.*|--merged|--no-merged)$/.test(a))) {
        return "git tag that creates or deletes tags"
      }
      if (sub === "remote" && rest.length > 0 && !/^(-v|--verbose|show|get-url)$/.test(rest[0])) return "git remote that changes remotes"
      if (sub === "config" && !rest.some((a) => /^(--get|--get-all|--get-regexp|--list|-l)$/.test(a))) return "git config write"
      if (sub === "reflog" && rest.length > 0 && !/^(show|-)/.test(rest[0])) return "git reflog that expires or deletes"
      return null
    }
    case "gh":
    case "glab": {
      const [group, action] = args.filter((a) => !a.startsWith("-"))
      if (group === "search") return null
      if (group === "api") {
        const method = args.findIndex((a) => /^(-X|--method)$/.test(a))
        if (method >= 0 && !/^GET$/i.test(args[method + 1] ?? "")) return `${base} api with a non-GET method`
        if (has(/^-X(?!GET$)\w+|^--method=(?!GET$)/i)) return `${base} api with a non-GET method`
        if (has(/^(-f|-F|--field|--raw-field|--input)/)) return `${base} api with a request body`
        return null
      }
      if (!action || !GH_READ_ACTIONS.has(action)) return `${base} ${group ?? ""} ${action ?? ""} is not read-only`.replace(/\s+/g, " ").trim()
      return null
    }
    case "curl": {
      const m = args.findIndex((a) => /^(-X|--request)$/.test(a))
      if (m >= 0 && !/^(GET|HEAD|OPTIONS)$/i.test(args[m + 1] ?? "")) return "curl with a non-GET method"
      if (has(/^-X(?!GET$|HEAD$)\w+|^--request=(?!GET$|HEAD$)/i)) return "curl with a non-GET method"
      if (has(/^(-d|--data|--data-\w+|--json|-F|--form|-T|--upload-file|-o|--output|-O|--remote-name|-K|--config)/)) {
        return "curl that sends a body or writes a file"
      }
      return null
    }
    default:
      return null
  }
}

/** Redirects that write somewhere other than /dev/null or another fd. */
function hasWritingRedirect(view: string): boolean {
  const cleaned = view
    .replace(/\d*>>?\s*\/dev\/null/g, " ")
    .replace(/&>>?\s*\/dev\/null/g, " ")
    .replace(/\d*>&\s*\d+/g, " ")
  return /[>]/.test(cleaned)
}

function reportBash(command: string): AutonomyDecision {
  const view = shellView(command)
  if (view === null) return block("report", "shell", "command too irregular to verify as read-only")
  if (hasWritingRedirect(view)) return block("report", "shell", "output redirection writes a file")
  for (const seg of shellSegments(view)) {
    const words = commandWords(seg)
    if (words.length === 0) continue
    const why = reportShellWord(words)
    if (why) return block("report", "shell", why)
  }
  return ALLOW
}

function reportTool(input: AutonomyInput): AutonomyDecision {
  if (WRITE_TOOLS.has(input.tool)) return block("report", "write", `${input.tool} modifies files`)
  if (input.tool === "Bash") return reportBash(input.command ?? "")
  if (REPORT_SAFE_TOOLS.has(input.tool)) return ALLOW
  if (input.tool.startsWith("mcp__")) {
    const words = mcpActionWords(input.tool)
    const mutating = words.find((w) => MUTATING_VERBS.has(w))
    if (mutating) return block("report", "outward", `tool "${input.tool}" can change state (${mutating})`)
    if (words.some((w) => READ_VERBS.has(w))) return ALLOW
    return block("report", "outward", `tool "${input.tool}" is not recognisably read-only`)
  }
  return block("report", "tool", `tool "${input.tool}" is not on the read-only list`)
}

// ---------------------------------------------------------------- propose

interface ShellRule { id: string; re: RegExp; reason: string }

/** Content rules, matched against the RAW command: quoting is how these
 *  payloads are delivered (`psql -c 'DROP TABLE x'`), not a disclaimer. */
const PROPOSE_RAW_RULES: ShellRule[] = [
  { id: "merge", re: /merge_when_pipeline_succeeds|\bauto[_-]merge\b/i, reason: "auto-merging is an act-level action" },
  { id: "merge", re: /\b(curl|wget|http|gh\s+api|glab\s+api)\b[^\n]*\/merges?\b/i, reason: "calling a merge endpoint is an act-level action" },
  { id: "delete", re: /(?:^|\W)(drop|truncate)\s+(table|database|schema|index|collection)\b|(?:^|\W)delete\s+from\b|\bflushall\b|\bflushdb\b/i, reason: "destroying data is an act-level action" },
  { id: "delete", re: /(-X|--request)[\s=]*['"]?DELETE\b/i, reason: "HTTP DELETE is an act-level action" },
  { id: "delegate", re: /\b(curl|wget|http)\b[^\n]*(localhost|127\.0\.0\.1|\[::1\])[^\n]*\/(ask|task|send|chat|mesh|workflows?|crons?|reload|config)\b/i, reason: "calling the local daemon to dispatch work escapes this routine's limit" },
]

/** Command rules, matched against one simple command (quoted text blanked). */
const PROPOSE_COMMAND_RULES: ShellRule[] = [
  { id: "merge", re: /^(gh\s+pr\s+merge|glab\s+mr\s+merge)\b/i, reason: "merging is an act-level action" },
  { id: "delete", re: /^rm\s+(.*\s)?(-\w*[rR]\w*|--recursive)\b|^(shred|dropdb)\b|^find\b.*\s-delete\b/i, reason: "deleting is an act-level action" },
  { id: "delete", re: /^git\s+(clean\s+-\w*f|reset\s+--hard|branch\s+(-\w*[dD]\w*|--delete)|tag\s+(-d|--delete)|stash\s+(drop|clear)|remote\s+(remove|rm))\b/i, reason: "deleting is an act-level action" },
  { id: "delete", re: /^(gh|glab)\s+\S+\s+delete\b|^docker\s+(rm|rmi|volume\s+rm|system\s+prune)\b|^(kubectl\s+delete|aws\s+s3\s+(rm|rb)|gsutil\s+rm)\b|^doctl\s+.*\sdelete\b/i, reason: "deleting is an act-level action" },
  { id: "deploy", re: /^(kubectl\s+(apply|rollout|scale|set|patch|replace|create|edit)|helm\s+(install|upgrade|rollback|uninstall|delete)|terraform\s+(apply|destroy|import|taint)|pulumi\s+(up|destroy)|docker\s+push|netlify\s+deploy|fly(ctl)?\s+deploy|serverless\s+deploy|vercel\b.*--prod)\b/i, reason: "deploying is an act-level action" },
  { id: "deploy", re: /^((npm|pnpm|yarn|bun)(\s+run)?|make|just|task|rake)\s+(\S+:)?deploy\b|^((ba|z)?sh|node|python3?)\s+\S*deploy[^\s/]*$|^\S*\/deploy(\.\w+)?\b|^deploy(\.\w+)?\b/i, reason: "deploying is an act-level action" },
  { id: "deploy", re: /^((npm|pnpm|yarn|bun)\s+publish|cargo\s+publish|twine\s+upload|(gh|glab)\s+release\s+(create|upload|edit)|(npx\s+)?prisma\s+(migrate\s+(deploy|reset)|db\s+push))\b/i, reason: "publishing or migrating is an act-level action" },
  { id: "prod", re: /^(ssh|scp|sudo|doas|systemctl|launchctl|service|kill|pkill|killall|reboot|shutdown)\b|^rsync\b.*\s\S+:\S*/i, reason: "operating hosts and services is an act-level action" },
  { id: "delegate", re: /^(agentx|agentix)\s+(ask|send|task|exec|run|chat|mesh|cron|workflow|daemon|config)\b/i, reason: "handing work to another agent or reconfiguring the daemon escapes this routine's limit" },
]

const PROTECTED_BRANCH = /^(main|master|trunk|develop|development|prod|production|staging|stable|release([/-].*)?|HEAD|@)$/i
/** `git push` options that consume the next word. */
const PUSH_VALUE_OPTS = /^(-o|--push-option|--repo|--receive-pack|--exec)$/

/** A push may only name feature branches explicitly — no force, no delete,
 *  no mirror/tags, no protected destinations, no implicit "current branch". */
function proposeGitPush(rest: string[]): AutonomyDecision | null {
  const positional: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (PUSH_VALUE_OPTS.test(a)) { i++; continue }
    if (/^(--force.*|-d|--delete|--mirror|--all|--tags|--prune)$/.test(a) || /^-[a-zA-Z]*f/.test(a)) {
      return block("propose", "push", "force, delete, mirror and tag pushes are act-level actions")
    }
    if (!a.startsWith("-")) positional.push(a)
  }
  const refspecs = positional.slice(1)
  if (refspecs.length === 0) return block("propose", "push", "name the feature branch explicitly: git push <remote> <branch>")
  for (const ref of refspecs) {
    if (ref.startsWith("+") || ref.startsWith(":")) return block("propose", "push", `refspec "${ref}" force-pushes or deletes`)
    const name = (ref.includes(":") ? ref.slice(ref.indexOf(":") + 1) : ref).replace(/^refs\/heads\//, "")
    if (PROTECTED_BRANCH.test(name)) return block("propose", "push", `pushing to "${name}" is an act-level action; push a feature branch and open a merge request`)
  }
  return null
}

function proposeBash(command: string): AutonomyDecision {
  for (const rule of PROPOSE_RAW_RULES) {
    if (rule.re.test(command)) return block("propose", rule.id, rule.reason)
  }
  const view = shellView(command)
  if (view === null) return block("propose", "shell", "command too irregular to verify")
  for (const seg of shellSegments(view)) {
    const words = commandWords(seg)
    if (words.length === 0) continue
    const line = [baseName(words[0]), ...words.slice(1)].join(" ")
    for (const rule of PROPOSE_COMMAND_RULES) {
      if (rule.re.test(line)) return block("propose", rule.id, rule.reason)
    }
    if (baseName(words[0]) === "git") {
      const { sub, rest } = gitSubcommand(words.slice(1))
      if (sub === "push") {
        const hit = proposeGitPush(rest)
        if (hit) return hit
      }
    }
  }
  return ALLOW
}

function proposeTool(input: AutonomyInput): AutonomyDecision {
  if (input.tool === "Bash") return proposeBash(input.command ?? "")
  if (input.tool.startsWith("mcp__")) {
    const hit = mcpActionWords(input.tool).find((w) => DESTRUCTIVE_VERBS.has(w))
    if (hit) return block("propose", "outward", `tool "${input.tool}" performs an act-level action (${hit})`)
    if (isDelegation(mcpActionWords(input.tool))) {
      return block("propose", "delegate", `tool "${input.tool}" hands work to another agent, which would run at its own full autonomy`)
    }
  }
  return ALLOW
}

/** Handing the task to another agent escapes the limit: that agent's run
 *  is not restricted. */
function isDelegation(words: string[]): boolean {
  if (words.includes("delegate") || words.includes("handoff")) return true
  if (words.includes("agent") && words.some((w) => w === "send" || w === "ask" || w === "message" || w === "task")) return true
  return words.includes("task") && !words.some((w) => READ_VERBS.has(w))
}

// ---------------------------------------------------------------- entry

/** Judge one tool call against an autonomy level. `act` allows everything. */
export function evaluateAutonomy(level: AutonomyLevel, input: AutonomyInput): AutonomyDecision {
  if (level === "report") return reportTool(input)
  if (level === "propose") return proposeTool(input)
  return ALLOW
}

/** One-paragraph brief prepended to a restricted task, so the model knows
 *  the boundary up front instead of discovering it by being blocked. The
 *  enforcement does not depend on it. */
export function autonomyBrief(level: AutonomyLevel): string {
  if (level === "report") {
    return "[Autonomy: report] This routine runs read-only. Investigate and report; do not modify files, run mutating commands, or post anywhere. Your final answer is the deliverable. Blocked actions are enforced and logged; if something needs doing, describe it in the report instead."
  }
  if (level === "propose") {
    return "[Autonomy: propose] You may edit files, commit, push a named feature branch, and open a merge request or draft. You may not merge, deploy, delete, force-push, push to protected branches, or operate hosts. These limits are enforced and logged; leave act-level steps as clear recommendations."
  }
  return ""
}
