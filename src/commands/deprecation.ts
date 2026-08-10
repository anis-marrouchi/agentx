import chalk from "chalk"

// --- Deprecation notices ---
//
// A surface is deprecated when the evidence says nobody uses it AND something
// better exists. Both halves matter: dropping a capability because it is
// unpopular is how tools get worse. Replacing one because it lost to a better
// host is how they get simpler.
//
// See docs/architecture/surface-reduction.md for the fleet usage data behind
// each entry here.
//
// The notice is a warning, never a block. The command still runs — an operator
// mid-incident should never be stopped by a message about roadmaps.

export interface Deprecation {
  /** What is going away. */
  what: string
  /** Why, in one line an operator can evaluate. Cite evidence, not opinion. */
  why: string
  /** What to do instead, as a runnable command where possible. */
  instead: string
  /** Extra context worth one more line. */
  note?: string
}

export function deprecationNotice(d: Deprecation): void {
  console.error()
  console.error(chalk.yellow(`  ⚠ ${d.what} is deprecated.`))
  console.error(chalk.dim(`    ${d.why}`))
  console.error()
  console.error(`    Use ${chalk.cyan(d.instead)} instead.`)
  if (d.note) console.error(chalk.dim(`    ${d.note}`))
  console.error()
}

/** `agentx chat` and `agentx tui` — the two terminal chat surfaces. Both went
 *  unused on every node in the fleet after 2026-07-03. They lost to Claude
 *  Code, and attach mode is the answer: rather than a third attempt at a chat
 *  client, let the client people already prefer wear the agent identity. */
export const CHAT_SURFACE_DEPRECATION: Omit<Deprecation, "what"> = {
  why: "No recorded use on any node since 2026-07-03.",
  instead: "agentx attach <agent>",
  note: "Wears the identity in the Claude Code session you already have open — see docs/reference/attach.md",
}
