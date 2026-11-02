import { createCard, readCard, saveCard, type CardSettings, type DecisionCard } from "@/approvals/cards"
import { mcpWriteNeedingConfirm, type McpPolicyFields } from "./mcp-policy"

// --- A write tool waits for one Approvals card (#1736) ---
//
// A call to a tool that writes, on an MCP server with an `allowTools` list
// (mcp-policy.ts decides which), raises one card and waits for the answer.
// Yes runs the call. No, no answer before the wait ends, a card that
// could not be raised, or any error: the call does not run.
//
// Both tiers use this: the daemon's /guard/check (claude-code tier, whose
// hook waits for the answer) and the in-process MCP pool (orchestrator).
// The card's answer IS the result, so the agent gets no separate result
// turn for it (approvals/sweep.ts skips origin "mcp-write").

/** How long a call waits for the owner. The claude-code hook's own limits
 *  sit above this (workspace-setup.ts), so the daemon answers first. */
export const MCP_CONFIRM_WAIT_S = 180

export interface McpConfirmDeps {
  /** The daemon's folder: cards live under <root>/.agentx/approvals. */
  root: string
  agentId: string
  settings?: CardSettings
  waitMs?: number
  pollMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Told once the card is saved (logs, the Wall). */
  onCard?: (card: DecisionCard) => void
}

const CONTEXT_MAX = 600

/** The call's input as shown on the card: compact JSON, cut to fit. */
function inputPreview(input: unknown): string {
  let text: string
  try { text = JSON.stringify(input ?? {}) } catch { text = String(input) }
  text = text.replace(/\s+/g, " ").trim()
  const head = "Input: "
  const room = CONTEXT_MAX - head.length
  return head + (text.length > room ? text.slice(0, room - 1) + "…" : text)
}

function cut(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s
}

function refusal(server: string, tool: string, why: string): string {
  return `[agentx-mcp] "${tool}" on MCP server "${server}" writes data and was not run: ${why}. ` +
    `Do not retry it or work around it. Say what you were trying to do and wait for instructions.`
}

/** A decided card's answer: null (run) on yes, else the refusal. */
function verdictOf(card: DecisionCard, server: string, tool: string): string | null {
  return card.verdict === "yes" ? null : refusal(server, tool, `the owner said no on card ${card.id}`)
}

/**
 * Ask before a write tool runs. Resolves to null when the call may run
 * (not a gated write, or the owner said yes), else the refusal the agent
 * reads. Never throws.
 */
export async function mcpWriteDenial(
  toolName: string,
  input: unknown,
  servers: Record<string, McpPolicyFields> | undefined,
  deps: McpConfirmDeps,
): Promise<string | null> {
  const target = mcpWriteNeedingConfirm(toolName, servers)
  if (!target) return null
  const { server, tool } = target
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const waitMs = deps.waitMs ?? MCP_CONFIRM_WAIT_S * 1000
  const pollMs = deps.pollMs ?? 1000
  const minutes = Math.max(1, Math.round(waitMs / 60_000))

  try {
    const start = now()
    const made = createCard(deps.root, {
      title: cut(`${deps.agentId} wants to write with ${server}: ${tool}`, 120),
      ask: cut(`Let ${deps.agentId} run the "${tool}" tool on ${server}? It changes data in that service.`, 300),
      recommend: `Yes only if you asked for this. No, or no answer within ${minutes} min, and it does not run.`,
      context: inputPreview(input),
      if_silent: "discard",
      expires: new Date(start + waitMs).toISOString(),
      raised_by: deps.agentId,
    }, { now: start, settings: deps.settings, origin: { kind: "mcp-write", server, tool } })
    if (!made.ok) return refusal(server, tool, `the confirmation card could not be raised (${made.error})`)
    const id = made.card.id
    try { deps.onCard?.(made.card) } catch { /* a listener never decides */ }

    while (true) {
      const card = readCard(deps.root, id)
      if (!card) return refusal(server, tool, "the confirmation card is gone")
      if (card.status === "decided") return verdictOf(card, server, tool)
      if (card.status !== "pending") return refusal(server, tool, `card ${id} was not answered in time`)
      if (now() - start >= waitMs) {
        // Close it, so a late yes cannot look like it ran the call. An
        // answer can land while the wait runs out, so read the card again
        // right before closing it, and once more after: a yes saved on
        // either side of our save is the owner's answer, not lost (#1737).
        const latest = readCard(deps.root, id)
        if (!latest) return refusal(server, tool, "the confirmation card is gone")
        if (latest.status === "decided") return verdictOf(latest, server, tool)
        if (latest.status !== "pending") return refusal(server, tool, `card ${id} was not answered in time`)
        saveCard(deps.root, {
          ...latest,
          status: "expired",
          outcome: "discard",
          decided_by: "expiry",
          decided_at: new Date(now()).toISOString(),
        })
        const after = readCard(deps.root, id)
        if (after?.status === "decided") return verdictOf(after, server, tool)
        return refusal(server, tool, `card ${id} was not answered within ${minutes} min`)
      }
      await sleep(pollMs)
    }
  } catch (e: any) {
    // A failure to ask is not a yes.
    return refusal(server, tool, `the confirmation step failed (${e?.message ?? e})`)
  }
}
