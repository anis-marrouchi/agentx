import { z } from "zod"

/** The run that calls agent.call or mesh.delegate (#2145): its running
 *  task id, agent and node. The daemon route fills it in from the caller's
 *  proven turn (parentRunForBuiltin); a value a caller sends is dropped. */
export const parentRunSchema = z.object({
  taskId: z.string().min(1).max(80),
  agentId: z.string().min(1).max(80),
  node: z.string().max(80).optional(),
})

/** Built-ins whose callee run gets the caller's run as its parent. */
export const PARENT_RUN_BUILTINS = new Set(["agent.call", "mesh.delegate"])

/** The body agent.call or mesh.delegate runs with: any parentRun the
 *  caller sent dropped, the proven caller's run put in its place. Other
 *  built-ins' bodies are left as they are. `turn` is resolveCallerTurn's
 *  answer. */
export function withParentRun(
  name: string,
  body: unknown,
  turn: { agentId: string; taskId?: string } | null,
  nodeId?: string,
): unknown {
  if (!PARENT_RUN_BUILTINS.has(name) || !body || typeof body !== "object" || Array.isArray(body)) return body
  const { parentRun: _dropped, ...rest } = body as Record<string, unknown>
  if (!turn?.taskId) return rest
  return { ...rest, parentRun: { taskId: turn.taskId, agentId: turn.agentId, ...(nodeId ? { node: nodeId } : {}) } }
}
