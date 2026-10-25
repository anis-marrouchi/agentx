import type { IssueState } from "@/requests/checkers"
import { OPEN_STATES } from "@/requests/store"

// --- The forge and the Wall disagree (#1195) ---
//
// A forge-homed post has two statuses: the request's own and its home's
// on GitHub or GitLab. When one says open and the other says closed, the
// Wall marks it, so nobody picks up closed work or forgets open work.

/** "forge-closed": closed or merged on the forge, still open here.
 *  "forge-open": open on the forge, closed here. Null: they agree, or the
 *  forge state is unknown. */
export type ForgeMismatch = "forge-closed" | "forge-open"

export function forgeMismatch(postState: string, forgeState: IssueState | null): ForgeMismatch | null {
  if (!forgeState || postState === "candidate") return null
  const openHere = (OPEN_STATES as readonly string[]).includes(postState)
  const openThere = forgeState === "open"
  if (openHere === openThere) return null
  return openHere ? "forge-closed" : "forge-open"
}
