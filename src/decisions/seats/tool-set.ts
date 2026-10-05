import { choice } from "../questions"
import type { AnswersFor, ChoiceAnswer, StateValue } from "../types"

// Which built-in Claude Code tools a fresh session needs.
//
// The built-in tool descriptions are about 14k tokens of a ~27k-token first
// turn (#615), and every later call of the session re-reads them. A session
// that only reads and answers does not need Edit, Write or Bash; a lean
// session can already be started with a shorter list (`--tools`,
// session.lean.tools). This seat asks, per fresh session, which of three
// ordered bundles the task needs.
//
// Bundles, not single tools, on purpose. A Choice over three ordered sets
// keeps a stable meaning as Claude Code adds tools, and leaves fewer ways
// to forget one tool a task turns out to need. Anything outside the first
// two bundles (web, subagents, notebooks, new tools) is "full".
//
// Direction of failure: a bundle that is too small makes the agent fail in
// the middle of its task, which costs far more than the tokens saved. So
// the policy picks a smaller bundle only when the chance of needing more is
// below MISS_RISK, and anything uncertain, failed or missing is "full".
//
// Ground truth is free: every streamed run records which tools it called.
// After the run, the smallest bundle that covers those calls is the label
// (labelForTools), so the shadow rows grade themselves.
//
// Only shadow is implemented. "active" would also need a safety net that
// restarts a turn with every tool when the agent reaches for a missing one;
// until that exists the caller treats "active" as shadow.

export const TOOL_SET_SEAT = "tool-set"

export const TOOL_BUNDLES = ["answer", "code", "full"] as const
export type ToolBundle = (typeof TOOL_BUNDLES)[number]

/** Built-in tools in each bundle. "full" means no `--tools` list at all. */
export const BUNDLE_TOOLS: Record<Exclude<ToolBundle, "full">, readonly string[]> = {
  answer: ["Read", "Grep", "Glob"],
  code: ["Read", "Grep", "Glob", "Edit", "MultiEdit", "Write", "Bash"],
}

/** A smaller bundle is picked only when the chance that the task needs more
 *  than it is below this. */
export const MISS_RISK = 0.1

export interface ToolSetInput {
  /** The task, in the words it arrived in. */
  message: string
  agent: string
  channel?: string | null
  /** The agent's own instructions, clipped: they say what kind of work it
   *  does ("reviews pull requests", "answers billing questions"). */
  agentPrompt?: string | null
}

export function toolSetState(input: ToolSetInput): StateValue {
  return {
    task: clip(input.message, 2000),
    agent: input.agent,
    channel: input.channel ?? null,
    ...(input.agentPrompt ? { agentInstructions: clip(input.agentPrompt, 600) } : {}),
  }
}

export const toolSetQuestions = {
  bundle: choice(
    {
      answer:
        "Read-only: the task can be done by reading, searching and listing files and then replying. It changes no file and runs no command (no tests, no git, no scripts).",
      code:
        "Change files or run commands in the workspace: edit or write files, run tests, builds, git or shell commands. Still all inside the workspace, with no web access, no sub-agents and no notebooks.",
      full:
        "Needs more than that, or it is not clear: fetching or searching the web, starting sub-agents, notebooks, or anything the other two do not clearly cover.",
    },
    "Which set of built-in tools does an agent need to do this task completely? Pick the smallest set that is clearly enough.",
  ),
}

export type ToolSetAnswers = AnswersFor<typeof toolSetQuestions>

/** The bundle the policy would start the session with: the smallest one
 *  whose chance of being too small is below `risk`. Missing or malformed
 *  answers give "full". */
export function bundleFor(answers: ToolSetAnswers | Record<string, unknown> | null | undefined, risk = MISS_RISK): ToolBundle {
  const a = (answers as Record<string, unknown> | null | undefined)?.bundle as ChoiceAnswer | undefined
  const p = a?.probabilities as Record<string, number> | undefined
  if (!p) return "full"
  const pa = num(p.answer), pc = num(p.code), pf = num(p.full)
  if (pa === null || pc === null || pf === null) return "full"
  if (pc + pf < risk) return "answer"
  if (pf < risk) return "code"
  return "full"
}

/** The smallest bundle that covers the built-in tools a run called. MCP
 *  tools (`mcp__…`) are not governed by the bundle and are ignored. */
export function labelForTools(toolNames: Iterable<string>): ToolBundle {
  const builtIn = [...toolNames].filter((n) => !n.startsWith("mcp__"))
  if (builtIn.every((n) => BUNDLE_TOOLS.answer.includes(n))) return "answer"
  if (builtIn.every((n) => BUNDLE_TOOLS.code.includes(n))) return "code"
  return "full"
}

/** True when starting with `picked` would have left out a tool the run used. */
export function isMiss(picked: ToolBundle, needed: ToolBundle): boolean {
  return TOOL_BUNDLES.indexOf(picked) < TOOL_BUNDLES.indexOf(needed)
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}
