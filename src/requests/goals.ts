// --- Goals: why a request exists (#1168) ---
//
// A goal is an id and a plain title an agent names when it accepts a
// request: {id:"launch-site", title:"Launch the new site"}, or just the
// title, which gives the id. It is kept on the request; a tracked plan is
// keyed by its request, so its steps share the goal. Nothing else is
// stored: a goal exists while a request names it.
//
// The Goals view sums, per goal, its open and done requests, how far along
// it is (done out of open plus done; declined and dropped count for
// neither) and the cost of the runs linked to its requests. A request with
// no goal is untouched by all of this.

export const GOAL_ID_MAX = 80
export const GOAL_TITLE_MAX = 120
const GOAL_ID_RE = /^[a-z0-9][\w.:-]*$/i

export interface RequestGoal { id: string; title: string }

/** The id a bare title gives: lower case, words joined by dashes. */
export function goalIdOf(title: string): string {
  return title.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").slice(0, GOAL_ID_MAX).replace(/-$/, "")
}

/** The optional `goal` of accept: {id?, title} or a title. Undefined when
 *  absent, a string when it is malformed. */
export function parseGoal(v: unknown): RequestGoal | undefined | string {
  if (v === undefined || v === null || v === "") return undefined
  const raw = typeof v === "string" ? { title: v } : typeof v === "object" ? v as Record<string, unknown> : null
  if (!raw) return "goal must be {id, title} or a title"
  const title = typeof raw.title === "string" ? raw.title.replace(/\s+/g, " ").trim() : ""
  if (!title) return "goal needs title: what the goal is, in a few plain words"
  if (title.length > GOAL_TITLE_MAX) return `goal.title is longer than ${GOAL_TITLE_MAX} characters`
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : goalIdOf(title)
  if (!id) return "goal needs id: a short name made of letters, digits and dashes"
  if (id.length > GOAL_ID_MAX || !GOAL_ID_RE.test(id)) return `goal.id must be letters, digits, dashes, dots or colons, at most ${GOAL_ID_MAX} characters`
  return { id, title }
}

/** The line an agent is given in a request's task context. */
export function goalLine(goal: RequestGoal | null): string[] {
  return goal ? [`Why: this request serves the goal "${goal.title}" (${goal.id}).`, ""] : []
}

/** One request under a goal, for the Goals view. */
export interface GoalRequest {
  id: string
  state: string
  agentId: string
  /** The headline, else the owner's words, cut short. */
  title: string
  createdAt: number
  closedAt: number | null
  /** Summed cost of its linked runs. Null: no run reported one. */
  costUsd: number | null
}

export interface GoalSummary {
  id: string
  /** The title of its most recently updated request. */
  title: string
  open: number
  done: number
  /** Declined or dropped. */
  dropped: number
  /** done / (open + done), 0 to 1. Null when it has neither. */
  progress: number | null
  /** Summed cost of every linked run that reported one. */
  costUsd: number
  /** Linked runs, and how many of them reported no cost. */
  runs: number
  unpriced: number
  lastAt: number
  requests: GoalRequest[]
}
