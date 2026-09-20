import type { GuardInput } from "./types"

// --- Is this operation capable of destroying something? ---
//
// Purely syntactic, deliberately. This function decides WHICH operations
// are eligible for a second opinion, and it must give the same answer for
// the same input forever — no model, no network, no clock, no config.
//
// It is intentionally over-inclusive. A false positive here costs one
// extra model call on an operation that was already going to run; a false
// negative means a destructive command is never looked at twice. The whole
// list is "things that could plausibly lose data", not "things that
// definitely will".
//
// This is the load-bearing half of the guarantee that the guard stays
// deterministic: the risk seat is only ever consulted about operations
// this function already flagged, and the seat can only make the outcome
// stricter. Everything else runs exactly as it did before.

// CONTENT patterns: destructive regardless of quoting, because the quotes
// are how the payload is DELIVERED. `psql -c 'DELETE FROM users'` is a
// deletion; the single quotes are shell plumbing, not a disclaimer. These
// match the raw command, which knowingly accepts a false positive on
// something like `grep "rm -rf" src/` — one needless dialog is the correct
// side to err on.
const DESTRUCTIVE_CONTENT = new RegExp(
  [
    // filesystem
    String.raw`\brm\s`, String.raw`\brmdir\b`, String.raw`\bunlink\b`,
    String.raw`\bshred\b`, String.raw`\btruncate\b`, String.raw`\bmkfs`,
    String.raw`\bdd\b[^|]*\bof=`,
    // moves and overwrites that are meaningful as content
    String.raw`\bmv\s`, String.raw`\bcp\s+(-\w*f|\S+\s+-\w*f)`,
    // version control history and working tree
    String.raw`git\s+(reset\s+--hard|clean\s+-\w*[fd]|checkout\s+--\s|restore\b)`,
    String.raw`git\s+push\b[^|]*(--force\b|-f\b|\+)`,
    String.raw`git\s+branch\s+-\w*D`, String.raw`git\s+(tag\s+-d|remote\s+remove)`,
    // databases
    String.raw`(?:^|\W)(drop|truncate)\s+(table|database|schema|index|collection)`,
    String.raw`(?:^|\W)delete\s+from\b`, String.raw`(?:^|\W)update\s+\w+\s+set\b`,
    String.raw`\bdb\.\w+\.(drop|remove|deleteMany|deleteOne)\b`,
    String.raw`\bflushall\b`, String.raw`\bflushdb\b`,
    // package / container / infra teardown
    String.raw`docker\s+(rm|rmi|volume\s+rm|system\s+prune|compose\s+down\b[^|]*-v)`,
    String.raw`kubectl\s+delete\b`, String.raw`helm\s+(delete|uninstall)\b`,
    String.raw`terraform\s+(destroy|apply\b[^|]*-auto-approve)`,
    String.raw`\b(systemctl|launchctl)\s+(disable|unload|remove)\b`,
    // remote and cloud object stores
    String.raw`\baws\s+s3\s+(rm|rb)\b`, String.raw`\bgsutil\s+rm\b`,
    String.raw`\bdoctl\s+\w+\s+delete\b`, String.raw`\bgh\s+repo\s+delete\b`,
    String.raw`\bglab\s+\w+\s+delete\b`,
    // process destruction
    String.raw`\b(kill|pkill|killall)\b`,
    // the obvious ones
    String.raw`\bsudo\b`, String.raw`\bchmod\s+-R\b`, String.raw`\bchown\s+-R\b`,
  ].join("|"),
  "i",
)

/** Tools that write by definition — no command to inspect, the tool name
 *  is the whole signal. */
const MUTATING_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"])

// SYNTAX patterns: only destructive when the SHELL sees them. A `>` inside
// a commit message is prose; the same character outside quotes truncates a
// file. These match only after literals are stripped, which is what stopped
// enforce mode from blocking `git commit` on a heredoc containing "->".
const DESTRUCTIVE_SYNTAX = new RegExp(
  [
    String.raw`[^>|]>[^>|&]`,      // redirect that clobbers
    String.raw`\btee\b(?!\s+-a)`, // tee without append
  ].join("|"),
  "i",
)

/**
 * Remove quoted text and heredoc bodies before SYNTAX matching.
 *
 * Shell syntax and shell DATA are not distinguishable in a raw command
 * string, and matching the raw string means a `>` inside a commit message
 * reads exactly like a redirect that clobbers a file. That is not
 * hypothetical: enabling enforce mode immediately blocked a `git commit`
 * whose heredoc body contained "->", with the reason "matched destructive
 * pattern: m>".
 *
 * Over-inclusive is the correct bias for this classifier, but a rule that
 * fires on prose is not over-inclusive, it is wrong — and a guard that
 * blocks ordinary work is a guard someone turns off, which costs more
 * safety than it ever bought.
 *
 * Deliberately crude: it blanks the CONTENTS of quotes and heredocs while
 * preserving their delimiters, so `rm -rf "$HOME/x"` still matches on the
 * `rm` and a redirect written outside quotes still matches on the `>`.
 * Escaping edge cases resolve toward keeping text, i.e. toward matching.
 */
export function stripLiterals(command: string): string {
  let out = command

  // Heredoc bodies first: they can contain anything, including quotes that
  // would otherwise unbalance the scan below.
  out = out.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\s*\2\s*$/gm,
    (m) => m.split("\n")[0] + "\n")
  // An unterminated heredoc (still being written) — drop to end of string.
  out = out.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*$/,
    (m) => m.split("\n")[0] + "\n")

  // Quoted spans, contents blanked, delimiters kept.
  out = out.replace(/'([^'\\]|\\.)*'/g, "''")
  out = out.replace(/"([^"\\]|\\.)*"/g, '""')
  return out
}

export interface MutationCheck {
  mutating: boolean
  /** Which signal fired, for the audit trail and the confirmation dialog. */
  reason: string | null
}

/**
 * True when this operation could destroy or overwrite something.
 *
 * Over-inclusive on purpose — see the note above. Never consults anything
 * outside its arguments, so the same input always produces the same answer.
 */
export function classifyMutation(input: GuardInput): MutationCheck {
  if (MUTATING_TOOLS.has(input.tool)) {
    return { mutating: true, reason: `${input.tool} writes to ${input.filePath ?? "a file"}` }
  }
  const command = input.command ?? ""
  if (!command) return { mutating: false, reason: null }

  // Content first: quoting does not make a DROP TABLE safe.
  const content = DESTRUCTIVE_CONTENT.exec(command)
  if (content) {
    return { mutating: true, reason: `matched destructive pattern: ${content[0].trim().slice(0, 40)}` }
  }
  // Then syntax, against a command with its literals blanked — a redirect
  // only redirects when the shell is the one reading it.
  const syntax = DESTRUCTIVE_SYNTAX.exec(stripLiterals(command))
  if (syntax) {
    return { mutating: true, reason: `matched destructive shell syntax: ${syntax[0].trim().slice(0, 40)}` }
  }
  return { mutating: false, reason: null }
}
