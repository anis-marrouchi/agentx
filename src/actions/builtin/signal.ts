import { z } from "zod"
import { getSignalService } from "@/agents/signals/instance"
import type { BuiltinAction } from "./types"

// --- signal.resume (#857) ---
//
// Resume a task a stop signal paused, from a workflow step: the task runs
// again in its own chat with its resume plan prepended. The step acts for
// the owner who wrote the workflow; `by` names it in the event and plan.

const signalResumeInput = z.object({
  /** The stopped task's id (`agentx signal list`). */
  id: z.string().min(1),
  reason: z.string().max(500).optional(),
  /** Who to name as the resumer. Default "workflow". */
  by: z.string().min(1).max(100).default("workflow"),
})
type SignalResumeInput = z.infer<typeof signalResumeInput>

const signalResumeOutput = z.object({
  ok: z.boolean(),
  id: z.string(),
  agentId: z.string().nullable(),
  error: z.string().optional(),
})
type SignalResumeOutput = z.infer<typeof signalResumeOutput>

export const signalResume: BuiltinAction<SignalResumeInput, SignalResumeOutput> = {
  name: "signal.resume",
  description: "Resume a task a stop signal paused, from its resume plan, in the same chat",
  inputSchema: signalResumeInput,
  outputSchema: signalResumeOutput,
  handler: async (input) => {
    const service = getSignalService()
    if (!service) return { ok: false, id: input.id, agentId: null, error: "signals are not running in this process" }
    const r = await service.resume({ kind: "owner", name: input.by }, input.id, input.reason)
    if (!r.ok) return { ok: false, id: input.id, agentId: service.get(input.id)?.agentId ?? null, error: r.error }
    return { ok: true, id: r.record.id, agentId: r.record.agentId }
  },
}
