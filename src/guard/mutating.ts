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

const DESTRUCTIVE_COMMAND = new RegExp(
  [
    // filesystem
    String.raw`\brm\s`, String.raw`\brmdir\b`, String.raw`\bunlink\b`,
    String.raw`\bshred\b`, String.raw`\btruncate\b`, String.raw`\bmkfs`,
    String.raw`\bdd\b[^|]*\bof=`,
    // moves and overwrites: mv clobbers, cp -f clobbers, > truncates
    String.raw`\bmv\s`, String.raw`\bcp\s+(-\w*f|\S+\s+-\w*f)`,
    String.raw`[^>|]>[^>|&]`, String.raw`\btee\b(?!\s+-a)`,
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

  const hit = DESTRUCTIVE_COMMAND.exec(command)
  if (hit) {
    return { mutating: true, reason: `matched destructive pattern: ${hit[0].trim().slice(0, 40)}` }
  }
  return { mutating: false, reason: null }
}
