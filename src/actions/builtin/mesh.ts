import { z } from "zod"
import { getMesh } from "@/a2a/mesh-instance"
import type { BuiltinAction } from "./types"

// --- mesh.delegate ---
//
// Send a task to a remote agentx peer (mesh node) and return the
// peer's response text. Same wire as the legacy POST /mesh/task HTTP
// route, but typed and callable directly from agents and workflows
// without a Bash shell-out — exactly the "mesh.delegate (peer call,
// no shell required)" line item from improvement plan #6.
//
// Why this matters even though POST /mesh/task already exists:
//   - Workflows can pipe the response into a typed downstream node.
//   - Agent-side, the call is one /api/actions/builtin POST instead
//     of "shell out, parse JSON, hope you wrote the curl right".
//   - The action interface advertises peer-name + agent-name shape
//     so authoring tools can validate before dispatch.

const meshDelegateInput = z.object({
  /** Mesh peer name as configured in mesh.peers[].name. */
  peer: z.string().min(1),
  /** Optional remote agent id; falls back to first agent on the peer. */
  agent: z.string().optional(),
  message: z.string().min(1),
  /** Per-call timeout. Default 90s; capped by the registry's 60s
   *  ceiling unless the action declares a larger timeoutMs. */
  timeoutMs: z.number().int().min(1).max(600_000).default(90_000),
  /** Identity of the agent making the delegated call. Forwarded to
   *  the receiving daemon for route-trace + (eventually) capability
   *  validation. Optional during the log-warn rollout. */
  senderAgentId: z.string().optional(),
  /** Force a fresh session on the receiving agent. Defaults to TRUE
   *  for cross-agent delegation — without this, a triage agent's
   *  delegation reuses whatever conversation the worker pool last
   *  served, leaking the previous visitor's context (run-3 / run-4
   *  benchmark finding). Pass `false` only when you genuinely want
   *  the worker to keep state across delegations. */
  freshSession: z.boolean().default(true),
})
type MeshDelegateInput = z.infer<typeof meshDelegateInput>

const meshDelegateOutput = z.object({
  peer: z.string(),
  agent: z.string().nullable(),
  response: z.string(),
})
type MeshDelegateOutput = z.infer<typeof meshDelegateOutput>

export const meshDelegate: BuiltinAction<MeshDelegateInput, MeshDelegateOutput> = {
  name: "mesh.delegate",
  description: "Send a task to a remote mesh peer's agent and return the response text",
  inputSchema: meshDelegateInput,
  outputSchema: meshDelegateOutput,
  // Allow the action's max well above the registry default so a
  // long peer task isn't capped at 60s.
  timeoutMs: 600_000,
  handler: async (input) => {
    const mesh = getMesh()
    if (!mesh) {
      throw new Error("mesh not enabled on this daemon (config.mesh.enabled = false)")
    }
    const response = await mesh.sendTask(input.peer, input.message, input.agent, {
      timeoutMs: input.timeoutMs,
      senderAgentId: input.senderAgentId,
      freshSession: input.freshSession,
    })
    return {
      peer: input.peer,
      agent: input.agent ?? null,
      response,
    }
  },
}
