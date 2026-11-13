import { createHash, randomBytes } from "crypto"

// --- Step proof (#1849) ---
//
// A workflow `action.run` step has no task and no turn, so it cannot prove
// which agent it acts for when it calls the daemon back. The daemon mints a
// token for the step while it runs: random, held only in this process (by
// its SHA-256), never written to the run context, log, output or disk
// (masked in what the step prints, #1852), and revoked when the step ends.
// A shell action gets it in its environment, which other processes of the
// same OS user can read while the step runs: a limit the docs state, since
// that user can read the daemon's own files and memory anyway. The step carries it as the `X-AgentX-Step`
// header. Only `POST /approvals/:id/resolve` accepts it, and only from
// loopback: it proves that agent closes its own card, nothing else.

/** The header a step sends its proof in. Fixed: CX callers use it. */
export const STEP_PROOF_HEADER = "x-agentx-step"
/** The env var a shell action reads its proof from. Fixed: CX callers use it. */
export const STEP_PROOF_ENV = "AGENTX_STEP_PROOF"
/** The value an http action names in a header to send its proof. */
export const STEP_PROOF_TEMPLATE = "agentx_step_proof"
/** Slack past the action's own timeout before a token expires anyway. */
export const STEP_PROOF_GRACE_MS = 30_000

/** What stands in for the token in captured step output. */
export const STEP_PROOF_MASK = "[step proof hidden]"

/** Captured step output with the token taken out (#1852): a script that
 *  prints its environment must not write the proof into the run log. A
 *  token the output cap cut short at the very end goes too. */
export function maskStepProof(text: string, token: string | undefined | null): string {
  if (!token || !text) return text
  let out = text.includes(token) ? text.split(token).join(STEP_PROOF_MASK) : text
  for (let k = token.length - 1; k >= Math.min(8, token.length - 1) && k > 0; k--) {
    if (out.endsWith(token.slice(0, k))) { out = out.slice(0, -k) + STEP_PROOF_MASK; break }
  }
  return out
}

export interface StepProofEntry {
  runId: string
  nodeId: string
  workflowId: string
  /** The agent the step acts for: run.meta.startedBy ?? workflow.ownerAgent. */
  agentId: string
  expiresAt: number
}

export interface MintedStepProof {
  token: string
  /** Ends the proof. Safe to call more than once. */
  revoke: () => void
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex")

export class StepProofs {
  private readonly live = new Map<string, StepProofEntry>()

  constructor(private readonly now: () => number = Date.now) {}

  mint(entry: Omit<StepProofEntry, "expiresAt">, ttlMs: number): MintedStepProof {
    this.sweep()
    const token = randomBytes(32).toString("base64url")
    const key = hash(token)
    this.live.set(key, { ...entry, expiresAt: this.now() + Math.max(0, ttlMs) })
    return { token, revoke: () => { this.live.delete(key) } }
  }

  /** The live entry a token names, or null (unknown, revoked or expired). */
  check(token: string | undefined | null): StepProofEntry | null {
    if (typeof token !== "string" || !token) return null
    const key = hash(token)
    const entry = this.live.get(key)
    if (!entry) return null
    if (entry.expiresAt <= this.now()) {
      this.live.delete(key)
      return null
    }
    return entry
  }

  get size(): number {
    return this.live.size
  }

  private sweep(): void {
    const t = this.now()
    for (const [k, e] of this.live) if (e.expiresAt <= t) this.live.delete(k)
  }
}

/** The minting rule the daemon uses: a step acts for the run's starter,
 *  else the workflow's owner (the agent a card from the run is raised in
 *  the name of). No agent of this node: no proof. */
export function stepProofMinter(
  proofs: StepProofs,
  hasAgent: (agentId: string) => boolean,
): (step: { workflow: { id: string; ownerAgent?: string }; run: { id: string; meta?: { startedBy?: string } }; node: { id: string } }, ttlMs: number) => MintedStepProof | null {
  return ({ workflow, run, node }, ttlMs) => {
    const agentId = run.meta?.startedBy ?? workflow.ownerAgent
    if (!agentId || !hasAgent(agentId)) return null
    return proofs.mint({ runId: run.id, nodeId: node.id, workflowId: workflow.id, agentId }, ttlMs)
  }
}

/** The step a request proves: its X-AgentX-Step header names a live proof
 *  and it comes from this machine. Null otherwise. */
export function provenStep(
  proofs: StepProofs,
  req: { headers: Record<string, string | string[] | undefined>; fromLoopback: boolean },
): { agentId: string; runId: string; nodeId: string } | null {
  const v = req.headers[STEP_PROOF_HEADER]
  const token = Array.isArray(v) ? v[0] : v
  if (!token || !req.fromLoopback) return null
  const e = proofs.check(token)
  return e ? { agentId: e.agentId, runId: e.runId, nodeId: e.nodeId } : null
}
