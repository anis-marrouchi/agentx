import { isRestricted } from "@/guard/autonomy"
import type { PersonLimits } from "@/people/people"

// --- What a mesh peer cannot enforce (#2104 B2) ---
//
// A restricted autonomy (report, propose) is enforced by the guard hook
// THIS daemon spawns, and a person's tool and skill limits by the per-run
// hook built from this node's people list (person ids are per machine).
// A peer receives a bare task and would run it at full power. Every path
// that sends a run to a peer instead of running it here asks this first:
// the registry's mesh fallback, and the router before it forwards a run to
// the node an issue was placed on.

export type MeshForwardBlock =
  | { kind: "autonomy"; error: string }
  | { kind: "limits"; error: string; name: string }

/** Why a run may not go to a mesh peer, or null when it may. */
export function meshForwardBlock(agentId: string, autonomy: string | undefined | null, limits: PersonLimits | null | undefined): MeshForwardBlock | null {
  if (isRestricted(autonomy as any)) {
    return { kind: "autonomy", error: `autonomy "${autonomy}" cannot be enforced on a mesh peer — agent "${agentId}" is not local` }
  }
  if (limits) {
    return { kind: "limits", name: limits.name, error: `${limits.name}'s tool and skill limits cannot be enforced on a mesh peer — agent "${agentId}" is not local` }
  }
  return null
}

/** The reply on an issue whose runs go to `node` when one of them may not
 *  go there (#2104 B2). */
export function placedRefusalText(node: string): string {
  return `This issue runs on ${node}, which can't apply your limits. Ask the owner to bring it back to this Mac.`
}

/** A task's context as a peer may receive it: without the paths that only
 *  mean something on this machine (a rule's runbook folder and files). */
export function meshContextOf(ctx: Record<string, unknown> | undefined | null): Record<string, unknown> | undefined {
  if (!ctx) return undefined
  const { runbookPath: _path, runbookFiles: _files, ...rest } = ctx
  return rest
}
