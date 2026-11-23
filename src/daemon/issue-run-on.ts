import { existsSync } from "fs"
import { issueWorktreePath, issueWorktreeState, pickCheckout, TASK_WORKTREE_DEFAULTS, worktreeTarget, type IssueWorktreeState, type TaskWorktreeSettings } from "@/agents/task-worktrees"
import type { ExecFn } from "@/agents/spec-tests"
import { parseRef } from "@/requests/checkers/issue"
import type { Placement, RequestRecord, RequestStore } from "@/requests/store"
import { OPEN_STATES } from "@/requests/store"

// --- Run an issue on another machine (#2104) ---
//
// The owner picks, on a Wall post whose home is an issue, the mesh node
// the issue's runs go to. The choice is kept per issue chat in
// `issue_placements` (requests/store.ts), never pruned; registry.execute
// and the router read it (channels/run-on.ts). Two reads and one write,
// all on the daemon:
//
//   GET  /mesh/issue-state?chatId=&channel=   (mesh token) what a move asks
//        the node holding the issue: {runOpen, worktree: {branch, dirty,
//        ahead} | null}.
//   GET  /issue-run-on?id=<post>   the post's node and the nodes it can
//        run on: {current, stale, choices: [...]}. The Wall's
//        GET /api/admin/wall/run-on asks this.
//   POST /issue-run-on {id, node}  moves it: refused for a post with no
//        issue home, a node that is unknown or cannot run it (offline, an
//        AgentX without placement, does not host the agent, no checkout of
//        the repository), or a failed move check (a run open, uncommitted
//        changes, commits not pushed, the holder offline). `node: "local"`
//        brings it back to this Mac: an explicit choice, which beats a
//        mapping. `node: "default"` deletes the row (C-c). `force` with
//        `confirm: <holder>` moves it off an offline holder (Q4), and
//        `dropLeftBehind: <node>` clears what that left behind.
//        Owner only: loopback or the operator key (C-a, mesh-auth.ts).

export interface IssueState { runOpen: boolean; worktree: IssueWorktreeState | null }

export interface IssueStateDeps {
  runOpen: (chatId: string) => boolean
  /** This node's agents: their workspace and worktree settings. */
  agents: () => Array<{ workspace?: string; worktrees?: Partial<TaskWorktreeSettings> }>
  /** This node's project rule folders (`runbook:`). */
  ruleDirs: () => string[]
  exec: ExecFn
  remoteOf?: (dir: string) => string | undefined
}

/** The issue's state on this node: a run open on its chat, and its issue
 *  worktree when one exists (the first agent's whose checkout has it). */
export async function issueState(chatId: string, channel: string | undefined, deps: IssueStateDeps): Promise<IssueState> {
  const runOpen = deps.runOpen(chatId)
  const channels = channel ? [channel] : ["github", "gitlab"]
  for (const ch of channels) {
    const target = worktreeTarget(ch, chatId)
    if (!target || target.kind === "change") continue
    for (const agent of deps.agents()) {
      const settings = { ...TASK_WORKTREE_DEFAULTS, ...(agent.worktrees ?? {}) }
      const picked = pickCheckout(target, [agent.workspace, ...deps.ruleDirs()].filter((d): d is string => !!d), deps.remoteOf)
      if ("reason" in picked) continue
      const dir = issueWorktreePath(target, picked.dir, settings)
      if (!existsSync(dir)) continue
      const worktree = await issueWorktreeState(dir, deps.exec)
      if (worktree) return { runOpen, worktree }
    }
  }
  return { runOpen, worktree: null }
}

/** Why a move away from the node holding the issue is refused, or null. */
export function moveRefusal(holder: string, state: IssueState): string | null {
  if (state.runOpen) return `A run is open on this issue on ${holder}. Wait for it to end, then move it.`
  if (state.worktree?.dirty) return `The issue's worktree on ${holder} has uncommitted changes (${state.worktree.branch}). Commit and push first.`
  if (state.worktree && state.worktree.ahead > 0) return `The issue's branch on ${holder} has ${state.worktree.ahead} commit(s) not pushed (${state.worktree.branch}). Push first.`
  return null
}

/** The forge issue a request's home is, or null. A short ref like
 *  "owner/repo#12" fits both forges: the request's own channel decides,
 *  then `forge` (the one this node runs), then GitHub for "owner/repo". */
export function issueHomeOf(r: Pick<RequestRecord, "home" | "channel">, forge?: "github" | "gitlab"): { provider: "github" | "gitlab"; project: string; number: number; chatId: string; label: string } | null {
  if (!r.home || r.home.kind !== "issue") return null
  const link = r.home.link.trim()
  let order: Array<"github" | "gitlab"> = ["github", "gitlab"]
  if (/^https?:\/\//i.test(link)) order = /\/-\/(issues|merge_requests)\//.test(link) ? ["gitlab"] : ["github", "gitlab"]
  else if (r.channel === "gitlab" || (r.channel !== "github" && forge === "gitlab")) order = ["gitlab", "github"]
  for (const provider of order) {
    const ref = parseRef(provider, link)
    if (ref && !ref.mr) return { provider, project: ref.project, number: ref.number, chatId: `${ref.project}:issue:${ref.number}`, label: `${ref.project}#${ref.number}` }
  }
  return null
}

export interface PeerEntry { peer: string; peerUrl: string; healthy: boolean; skills: Array<{ id: string }>; checkouts?: string[]; placement?: number; lastCheck?: Date }
export interface NodeNumbers { swapUsedPct?: number; load1?: number }

export interface RunOnChoice {
  node: string
  label: string
  healthy: boolean
  hostsAgent: boolean
  hasCheckout: boolean
  swapUsedPct?: number
  load1?: number
}

export interface RunOnDeps {
  store: () => RequestStore | null
  /** Mesh peers (A2AMesh.directory). */
  directory: () => PeerEntry[]
  localHostsAgent: (agentId: string) => boolean
  localCheckouts: () => string[]
  localNumbers: () => Promise<NodeNumbers | null>
  /** A peer's /api/node numbers, short timeout; null on failure. */
  peerNumbers: (peer: string) => Promise<NodeNumbers | null>
  localIssueState: (chatId: string, channel: string) => Promise<IssueState>
  /** A peer's /mesh/issue-state; throws when it does not answer. */
  peerIssueState: (peer: string, chatId: string, channel: string) => Promise<IssueState>
  forge?: "github" | "gitlab"
  now?: () => number
  /** The commit `branch` points at on the forge, or null (#2104 Q4). */
  pushedSha?: (provider: "github" | "gitlab", project: string, branch: string) => Promise<string | null>
  /** Posts a note on the issue chat, as this node's agent (#2104 Q4). */
  noteOnIssue?: (provider: "github" | "gitlab", chatId: string, text: string) => Promise<void>
}

export type Reply = { status: number; body: unknown }

const LOCAL = "local"
/** `node` for "Use the agent's default": the placement row is deleted. */
export const DEFAULT = "default"
const LOCAL_LABEL = "This Mac"
const has = (list: string[] | undefined, repo: string) => !!list?.some((c) => c.toLowerCase() === repo.toLowerCase())

function postOf(id: string, deps: RunOnDeps): { r: RequestRecord; issue: NonNullable<ReturnType<typeof issueHomeOf>>; agentId: string } | Reply {
  const store = deps.store()
  if (!store) return { status: 503, body: { error: "the requests store is not available" } }
  const r = id ? store.get(id) : null
  if (!r || r.state === "candidate") return { status: 404, body: { error: `no post "${id}" on this computer` } }
  const issue = issueHomeOf(r, deps.forge)
  if (!issue) return { status: 409, body: { error: "This post has no issue home, so there is nothing to run on another machine." } }
  return { r, issue, agentId: r.askedAgent ?? r.agentId }
}

/** A peer the Hub may offer: it hosts the agent, has the repository and
 *  says it supports placement (`placement: 1` in its card, #2104 C2): an
 *  older peer would ignore `placed` and fall back without saying so. */
function fits(p: PeerEntry, agentId: string, repo: string): boolean {
  return p.placement === 1 && p.skills.some((s) => s.id === agentId) && has(p.checkouts, repo)
}

/** GET /issue-run-on?id= */
export async function runOnChoices(id: string, deps: RunOnDeps): Promise<Reply> {
  const post = postOf(id, deps)
  if ("status" in post) return post
  const { r, issue, agentId } = post
  const peers = deps.directory()
  const placement = deps.store()!.placement(issue.provider, issue.chatId)
  const current = placement?.node ?? LOCAL
  const currentPeer = current !== LOCAL ? peers.find((p) => p.peer === current) : undefined
  const stale = current !== LOCAL && !currentPeer?.healthy
  const fit = peers.filter((p) => fits(p, agentId, issue.project))
  const [localNums, ...peerNums] = await Promise.all([
    deps.localNumbers().catch(() => null),
    ...fit.map((p) => (p.healthy ? deps.peerNumbers(p.peer).catch(() => null) : Promise.resolve(null))),
  ])
  const choices: RunOnChoice[] = [
    { node: LOCAL, label: LOCAL_LABEL, healthy: true, hostsAgent: deps.localHostsAgent(agentId), hasCheckout: has(deps.localCheckouts(), issue.project), ...(localNums ?? {}) },
    ...fit.map((p, i) => ({ node: p.peer, label: p.peer, healthy: p.healthy, hostsAgent: true, hasCheckout: true, ...(peerNums[i] ?? {}) })),
  ]
  return {
    status: 200,
    body: {
      id: r.id, issue: issue.label, agentId, current, placement, stale,
      leftBehind: deps.store()!.leftBehind(issue.provider, issue.chatId),
      ...(stale && currentPeer?.lastCheck ? { staleSince: new Date(currentPeer.lastCheck).toISOString() } : {}),
      choices,
    },
  }
}

/** POST /issue-run-on {id, node}. The order (#2104 B3): check the node
 *  that holds the issue (no open run, clean, nothing unpushed), write the
 *  placement, ask the holder again whether a run opened meanwhile, and if
 *  one did put the old placement back and refuse. A holder that does not
 *  answer (offline) refuses the move, "Back to this Mac" included: its
 *  state cannot be known, unless the owner forces it (Q4).
 *
 *  `node: "default"` deletes the placement row (C-c, "Use the agent's
 *  default"), after the same checks. `force: true` with `confirm` naming
 *  the offline holder moves it anyway (Q4): the holder's unpushed work
 *  stays there, recorded in `issue_left_behind`, and the issue is not
 *  placed on that node again until the owner drops the record
 *  (`{id, dropLeftBehind: <node>}`). A note on the issue says who, when,
 *  the node, and the last pushed commit of its branch. */
export async function moveRunOn(body: { id?: unknown; node?: unknown; by?: unknown; force?: unknown; confirm?: unknown; dropLeftBehind?: unknown }, deps: RunOnDeps): Promise<Reply> {
  const id = typeof body.id === "string" ? body.id.trim() : ""
  const node = typeof body.node === "string" ? body.node.trim() : ""
  const drop = typeof body.dropLeftBehind === "string" ? body.dropLeftBehind.trim() : ""
  if (!id || (!node && !drop)) return { status: 400, body: { error: "send { id, node }" } }
  const post = postOf(id, deps)
  if ("status" in post) return post
  const { r, issue, agentId } = post
  const store = deps.store()!
  if (drop) {
    if (!store.dropLeftBehind(issue.provider, issue.chatId, drop)) return { status: 404, body: { error: `No work left behind on ${drop} is recorded for ${issue.label}.` } }
    return { status: 200, body: { ok: true, message: `${drop} can run ${issue.label} again.` } }
  }
  if (!(OPEN_STATES as readonly string[]).includes(r.state)) return { status: 409, body: { error: `The post is ${r.state}; open it again first.` } }
  const peers = deps.directory()
  const before = store.placement(issue.provider, issue.chatId)
  const current = before?.node ?? LOCAL
  if (node === DEFAULT && !before) return { status: 200, body: { ok: true, current, message: "It already uses the agent's default." } }
  if (node === current && before) return { status: 200, body: { ok: true, current, message: node === LOCAL ? "It already runs on this Mac." : `It already runs on ${node}.` } }
  const left = store.leftBehind(issue.provider, issue.chatId).find((l) => l.node === node)
  if (left) return { status: 409, body: { error: `${node} keeps work on ${issue.label} left behind by a forced move. Recover or drop it there, then clear it here first.` } }

  if (node !== LOCAL && node !== DEFAULT) {
    const peer = peers.find((p) => p.peer === node)
    if (!peer) return { status: 404, body: { error: `"${node}" is not a node of this mesh.` } }
    if (!peer.healthy) return { status: 409, body: { error: `${node} is offline.` } }
    if (peer.placement !== 1) return { status: 409, body: { error: `${node} runs an AgentX that cannot run a placed issue; update it first.` } }
    if (!peer.skills.some((s) => s.id === agentId)) return { status: 409, body: { error: `${node} does not host ${agentId}.` } }
    if (!has(peer.checkouts, issue.project)) return { status: 409, body: { error: `${node} has no checkout of ${issue.project}.` } }
  }

  // 1. The holder's state.
  const holder = current === LOCAL ? "this Mac" : current
  const holderOffline = current !== LOCAL && !peers.find((p) => p.peer === current)?.healthy
  const by = typeof body.by === "string" && body.by ? body.by : "owner"
  const now = deps.now?.() ?? Date.now()
  const write = () => {
    if (node === DEFAULT) { store.clearPlacement(issue.provider, issue.chatId); return null }
    const p: Placement = { node, setBy: by, setAt: now }
    store.setPlacement(issue.provider, issue.chatId, p)
    return p
  }
  if (holderOffline && body.force === true) return forceMove()
  const ask = async (): Promise<IssueState | string> => {
    if (current === LOCAL) return deps.localIssueState(issue.chatId, issue.provider)
    if (!peers.find((p) => p.peer === current)?.healthy) return `${current} is offline, so its work on the issue cannot be checked. Start it again, then move the issue, or force the move and leave its unpushed work there.`
    try {
      return await deps.peerIssueState(current, issue.chatId, issue.provider)
    } catch (e: any) {
      return `Could not ask ${current} whether the issue can move: ${e?.message ?? e}`
    }
  }
  const first = await ask()
  if (typeof first === "string") return { status: 409, body: { error: first, ...(holderOffline ? { forcible: true, holder: current } : {}) } }
  const refusal = moveRefusal(holder, first)
  if (refusal) return { status: 409, body: { error: refusal } }

  // 2. Written: from here, a new run goes to the new node.
  const placement = write()

  // 3. A run that opened on the holder between 1 and 2 would split the
  // work: the move is undone.
  const again = await ask()
  const opened = typeof again === "string" ? again : again.runOpen ? `A run opened on this issue on ${holder} while it was moving, so it stays there. Try again when that run ends.` : null
  if (opened) {
    store.restorePlacement(issue.provider, issue.chatId, before)
    return { status: 409, body: { error: opened } }
  }
  return { status: 200, body: { ok: true, current: placement?.node ?? LOCAL, placement, message: movedText(node, issue.label) } }

  /** Q4: the holder is offline. Only with a confirm that names it; its
   *  unpushed work stays there, and the issue says so. */
  async function forceMove(): Promise<Reply> {
    const confirm = typeof body.confirm === "string" ? body.confirm.trim() : ""
    if (confirm !== current) return { status: 409, body: { error: `To force the move, confirm with the name of the offline node, ${current}: its unpushed work on ${issue.label} stays there.` } }
    const branch = `agentx/issue-${issue.number}`
    const sha = await deps.pushedSha?.(issue.provider, issue.project, branch).catch(() => null) ?? null
    store.addLeftBehind(issue.provider, issue.chatId, { node: current, pushedSha: sha, setBy: by, setAt: now })
    const placement = write()
    const to = node === LOCAL ? "this Mac" : node === DEFAULT ? "the agent's default" : node
    const text = `Moved by ${by} at ${new Date(now).toISOString()}: ${issue.label} no longer runs on ${current}, which was offline; it now runs on ${to} (forced, #2104).\n\n` +
      `The next run starts from origin/${branch} at ${sha ? sha.slice(0, 12) : "(no pushed commit found)"}. Work on ${current} that was not pushed stays there: ${current} will not run this issue or push that worktree. Recover or drop it there, then clear it from the Hub.`
    let noted = false
    try {
      if (deps.noteOnIssue) { await deps.noteOnIssue(issue.provider, issue.chatId, text); noted = true }
    } catch (e: any) {
      return { status: 200, body: { ok: true, forced: true, current: placement?.node ?? LOCAL, placement, pushedSha: sha, message: `${movedText(node, issue.label)} The note on the issue failed: ${e?.message ?? e}` } }
    }
    return { status: 200, body: { ok: true, forced: true, noted, current: placement?.node ?? LOCAL, placement, pushedSha: sha, message: movedText(node, issue.label) + ` ${current}'s unpushed work stays there.` } }
  }
}

function movedText(node: string, label: string): string {
  if (node === LOCAL) return `Back to this Mac: ${label}'s next run starts here, from the issue's pushed branch.`
  if (node === DEFAULT) return `${label} uses the agent's default again: its next run starts where the agent's own rule says, from the issue's pushed branch.`
  return `${label}'s next run starts on ${node}, from the issue's pushed branch.`
}

/** /api/node's numbers: swap used (percent of total) and the 1-minute load. */
export function nodeNumbersOf(report: unknown): NodeNumbers | null {
  const live = (report as any)?.host?.live
  if (!live || typeof live !== "object") return null
  const out: NodeNumbers = {}
  if (typeof live.swapTotalMB === "number" && live.swapTotalMB > 0 && typeof live.swapUsedMB === "number") out.swapUsedPct = Math.round((live.swapUsedMB / live.swapTotalMB) * 100)
  if (typeof live.load1 === "number") out.load1 = live.load1
  return out
}
