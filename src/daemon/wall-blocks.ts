import { OWED_TO_OWNER } from "@/requests/store"
import type { WallProjects } from "./wall-projects"

// --- Who blocks a Wall post, and from which project (#1193) ---
//
// A blocked post names what it waits on only when a record says so:
//   handoff  an open delegation link to another agent,
//   plan     the active plan step belongs to another agent,
//   owner    it waits on the owner (a question or needs attention),
//   person   a promise owed to someone outside the fleet.
// A post that is only quiet (no hand-off, no other agent's step) has no
// blocker: nothing is guessed. For an agent blocker, its project comes
// from the same mapping as the overview (#1190, ./wall-projects), and
// `crossProject` says it differs from the post's own project. Read-only.

export type WallBlockSource = "handoff" | "plan" | "owner" | "person"

export interface WallBlocker {
  kind: "agent" | "owner" | "person"
  who: string
  /** Where this was read from. */
  source: WallBlockSource
  /** The blocking agent's project; null for the owner, a person, or an
   *  agent no mapping entry names. */
  project: string | null
  /** An agent blocker in another project than the post's (both named). */
  crossProject: boolean
}

/** The recorded blocker of a post, or null when there is none. */
export function blockerOf(
  input: { owner: string; project: string | null; handedTo: string | null; stepAgent: string | null; waitsOn: { group: string; who: string } },
  projects: WallProjects | null | undefined,
): WallBlocker | null {
  const { owner, project, handedTo, stepAgent, waitsOn } = input
  if (waitsOn.group === "owner") return { kind: "owner", who: OWED_TO_OWNER, source: "owner", project: null, crossProject: false }
  if (waitsOn.group === "person") return { kind: "person", who: waitsOn.who, source: "person", project: null, crossProject: false }
  const agent = handedTo && handedTo !== owner ? { who: handedTo, source: "handoff" as const }
    : stepAgent && stepAgent !== owner ? { who: stepAgent, source: "plan" as const }
    : null
  if (!agent) return null
  return withProject({ kind: "agent", who: agent.who, source: agent.source, project: null, crossProject: false }, project, projects)
}

function withProject(b: WallBlocker, postProject: string | null, projects: WallProjects | null | undefined): WallBlocker {
  const claimed = projects?.claim([b.who], null)?.name ?? null
  return { ...b, project: claimed, crossProject: !!claimed && !!postProject && claimed !== postProject }
}

/** A peer's post seen through this node's mapping: its agent blocker's
 *  project and cross-project mark redone when an entry here names that agent. */
export function claimBlocker<T extends { project: string | null; blockedBy?: WallBlocker | null }>(p: T, projects: WallProjects | null | undefined): T {
  const b = p.blockedBy
  if (!b || b.kind !== "agent" || !projects?.claim([b.who], null)) return p
  return { ...p, blockedBy: withProject(b, p.project, projects) }
}
