import { createHash } from "crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { resolve } from "path"
import { isHumanFacingTurn, type InitiatorContext } from "@/a2a/initiator"
import { createCard, type CardSettings, type DecisionCard, type ReplyTarget } from "@/approvals/cards"
import { mutateAgentxConfig } from "@/daemon/config-mutate"
import { orgConfirmFor } from "@/daemon/ui/pages/org-setup"
import { personOfTurn, type Person } from "@/people/people"
import { isOperatorTurn } from "@/requests/operator"
import { isOwnerTurn, OPERATOR_CHANNELS, senderOf } from "@/requests/tracker"
import { applyOrgEdit, orgChoices, readOrgSetup, RELATION_LABEL, type OrgEdit } from "./org-edit"
import type { RelationType } from "./relations"

// --- Org chart changes by chat (#1678 point 5) ---
//
// The owner asks an agent in chat ("CX reports to Sales now"). The agent
// calls agentx_org (org-tool.ts), which posts here. Nothing is written
// then: every change is checked on a copy of agentx.json with
// applyOrgEdit, and one Approvals card asks the owner. The proposal is kept
// next to the card, keyed by its id. On yes the daemon applies it itself
// (applyOrgProposal, from the approvals sweep's onCardResult), in one
// write, after checking again if the chart changed in between. The agent
// never writes the chart.
//
// Only a turn the owner started may propose: a schedule, another agent, a
// delegation or a contact gets "Only the owner can change the org chart."

export const NOT_OWNER = "Only the owner can change the org chart."
export const MAX_CHANGES = 5

export interface NewAgent {
  id: string
  name: string
  role: string
  /** An `agent:` or `person:` ref. */
  reportsTo?: string
}

export interface OrgProposal {
  cardId: string
  raised_by: string
  changes: OrgEdit[]
  newAgent?: NewAgent
  why?: string
  /** orgShapeHash of agentx.json when the card was raised. */
  shape: string
  /** What the card said would change. */
  text: string
  created_at: string
  status: "pending" | "applied" | "failed" | "dropped"
  /** The summary on apply, or the refusal sentence. */
  result?: string
  done_at?: string
}

/** Does the turn with this context count as the owner's? The same rule as
 *  the request store's owner turns (requests/tracker isOwnerTurn, with the
 *  operator mark on this node's own surfaces, or a listed person with the
 *  owner role elsewhere), but on every channel: the requests' channel
 *  filter says where requests are captured, not who the owner is. A
 *  schedule, a delegation, a2a or another agent is never the owner. */
export function isOwnerContext(
  ctx: InitiatorContext | undefined | null,
  settings: { from: string[] },
  people: Person[],
): boolean {
  if (!ctx || !isHumanFacingTurn(ctx)) return false
  const channel = String(ctx.channel ?? "")
  if (isOwnerTurn({ channels: [], from: settings.from }, channel, senderOf(ctx as Record<string, unknown>), isOperatorTurn(ctx))) return true
  if (OPERATOR_CHANNELS.has(channel.toLowerCase().split("@")[0])) return false
  return personOfTurn(people, ctx)?.role === "owner"
}

/** A hash of what the chart is built from, as the daemon's reload compares
 *  it (orgShape in daemon/index.ts), plus agent ids for a new agent. */
export function orgShapeHash(cfg: any): string {
  const b = cfg?.business ?? {}
  const people = Array.isArray(cfg?.people) ? cfg.people.map((p: any) => p?.id) : []
  return createHash("sha256")
    .update(JSON.stringify([b.roles, b.orgChart, b.orgPeople, b.relations, b.departments, b.projects, people, Object.keys(cfg?.agents ?? {})]))
    .digest("hex")
    .slice(0, 16)
}

/** The chart as plain lines, so an agent maps the names it hears to refs. */
export function orgChartLines(cfg: any): string {
  const setup = readOrgSetup(cfg)
  const choices = orgChoices(cfg)
  const name = (ref: string) => setup.members.find((m) => m.ref === ref)?.name ?? ref
  const lines = ["Members of the org chart (use these refs):"]
  if (!setup.members.length) lines.push("- none yet")
  for (const m of setup.members) lines.push(`- ${m.ref}: ${m.name}, ${m.kind}${m.title ? `, role ${m.title}` : ""}`)
  lines.push("Lines:")
  if (!setup.relations.length) lines.push("- none yet")
  for (const r of setup.relations) {
    lines.push(`- ${r.from} ${r.type} ${r.to} (${name(r.from)} ${RELATION_LABEL[r.type as RelationType] ?? r.type} ${name(r.to)})`)
  }
  const inChart = new Set(setup.members.map((m) => m.ref))
  const out = [...choices.agents, ...choices.people].filter((c) => !inChart.has(c.ref))
  if (out.length) {
    lines.push("Not in the chart yet (add them with add-member first; an agent needs a role):")
    for (const c of out) lines.push(`- ${c.ref}: ${c.name}`)
  }
  lines.push("Kinds of line: reports-to (one boss each), dotted-line, acts-for (an agent acts for a person).")
  return lines.join("\n")
}

/** A refusal for the chat: the editor's "Reload the page" means nothing there. */
function plain(e: unknown): string {
  return String((e as Error)?.message ?? e).replace(/\s*Reload the page\.$/, "")
}

function agentsDir(root: string, id: string): string {
  return resolve(root, "agents", id)
}

/**
 * Apply the whole proposal to `cfg` in place: the new agent first (so a
 * change may name it), then each change. A new boss for a member who has
 * one is "remove the old line, add the new one", as in the editor
 * (orgConfirmFor). Throws the first refusal as a plain sentence. Returns
 * one line per change, in the editor's words.
 */
export function applyOrgPlan(cfg: any, plan: { changes: OrgEdit[]; newAgent?: NewAgent }, root: string): string[] {
  const said: string[] = []
  const a = plan.newAgent
  if (a) {
    cfg.agents = cfg.agents || {}
    if (cfg.agents[a.id]) throw new Error(`There is already an agent "${a.id}".`)
    cfg.agents[a.id] = {
      name: a.name, workspace: agentsDir(root, a.id), tier: "claude-code", mentions: [`@${a.id}`], maxConcurrent: 2, permissionMode: "default",
    }
    applyOrgEdit(cfg, { op: "add-member", member: `agent:${a.id}`, role: a.role })
    said.push(`New agent ${a.name} (${a.id}), role ${a.role}, workspace ${agentsDir(root, a.id)}.`)
    if (a.reportsTo) {
      const text = orgConfirmFor(readOrgSetup(cfg), { op: "add-relation", from: `agent:${a.id}`, type: "reports-to", to: a.reportsTo })?.text
      applyOrgEdit(cfg, { op: "add-relation", from: `agent:${a.id}`, type: "reports-to", to: a.reportsTo })
      if (text) said.push(text)
    }
  }
  for (const change of plan.changes) {
    const confirm = orgConfirmFor(readOrgSetup(cfg), change as any)
    let summary = ""
    for (const step of (confirm?.steps ?? [change]) as OrgEdit[]) summary = applyOrgEdit(cfg, step)
    said.push(confirm?.text ?? `${summary}.`)
  }
  return said
}

function proposalsDir(root: string): string {
  return resolve(root, ".agentx", "org-proposals")
}

function proposalFile(root: string, cardId: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,90}$/.test(cardId)) throw new Error(`invalid card id: ${cardId}`)
  return resolve(proposalsDir(root), `${cardId}.json`)
}

export function readOrgProposal(root: string, cardId: string): OrgProposal | null {
  try {
    return JSON.parse(readFileSync(proposalFile(root, cardId), "utf-8")) as OrgProposal
  } catch {
    return null
  }
}

function saveOrgProposal(root: string, p: OrgProposal): void {
  mkdirSync(proposalsDir(root), { recursive: true })
  const path = proposalFile(root, p.cardId)
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(p, null, 2) + "\n")
  renameSync(tmp, path)
}

/** The changes and new agent as sent, or a sentence saying what is wrong. */
function cleanInput(body: Record<string, unknown>): { changes: OrgEdit[]; newAgent?: NewAgent; why?: string } | string {
  const changes = body.changes == null ? [] : body.changes
  if (!Array.isArray(changes) || changes.some((c) => !c || typeof c !== "object" || typeof (c as any).op !== "string")) {
    return "changes must be a list of org chart changes, each with an op."
  }
  let newAgent: NewAgent | undefined
  if (body.newAgent != null) {
    const n = body.newAgent as Record<string, unknown>
    const s = (v: unknown) => (typeof v === "string" ? v.trim() : "")
    newAgent = { id: s(n?.id), name: s(n?.name), role: s(n?.role), ...(s(n?.reportsTo) ? { reportsTo: s(n?.reportsTo) } : {}) }
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(newAgent.id)) return "newAgent.id must be lowercase letters, digits, - or _."
    if (!newAgent.name) return "newAgent.name is required."
    if (!newAgent.role) return `Give ${newAgent.name} a role.`
  }
  if (!changes.length && !newAgent) return "Nothing to change: give one to five changes, or a newAgent."
  if (changes.length > MAX_CHANGES) return `At most ${MAX_CHANGES} changes in one proposal. Split it.`
  const why = typeof body.why === "string" ? body.why.replace(/\s+/g, " ").trim().slice(0, 300) : ""
  return { changes: changes as OrgEdit[], ...(newAgent ? { newAgent } : {}), ...(why ? { why } : {}) }
}

export interface OrgApiDeps {
  /** The install's folder: agentx.json and .agentx/ are here. */
  root: string
  /** agentx.json, when it is not at the root (tests). */
  configPath?: string
  settings: CardSettings
  now?: number
  /** The agent whose running turn the request proves, and whether the
   *  owner started that turn (isOwnerContext). Null: no turn proven. */
  caller: () => { agentId: string; owner: boolean } | null
  /** Where the card's result is told back, as agentx_approval does. */
  reply?: ReplyTarget
  /** Told about a new card (open requests). */
  onCard?: (card: DecisionCard) => void
}

function readConfig(deps: { root: string; configPath?: string }): any {
  return JSON.parse(readFileSync(deps.configPath ?? resolve(deps.root, "agentx.json"), "utf-8"))
}

/**
 * The daemon's org routes for agents:
 *   GET  /api/org            the chart as plain lines (agentx_org show)
 *   POST /api/org/proposals  check changes and raise one Approvals card
 * Gated like /approvals (mesh-auth isMeshGatedPath).
 */
export function handleOrgApi(
  method: string,
  path: string,
  body: Record<string, unknown> | undefined,
  deps: OrgApiDeps,
): { status: number; body: unknown } {
  const m = method.toUpperCase()
  if (path === "/api/org" && m === "GET") {
    try {
      return { status: 200, body: { text: orgChartLines(readConfig(deps)) } }
    } catch (e: any) {
      return { status: 500, body: { error: `couldn't read agentx.json: ${e?.message ?? e}` } }
    }
  }
  if (path !== "/api/org/proposals") return { status: 404, body: { error: "Not found" } }
  if (m !== "POST") return { status: 405, body: { error: "Method not allowed" } }

  const caller = deps.caller()
  if (!caller?.owner) return { status: 403, body: { error: NOT_OWNER } }
  const input = cleanInput(body ?? {})
  if (typeof input === "string") return { status: 400, body: { error: input } }

  let cfg: any
  try { cfg = readConfig(deps) } catch (e: any) { return { status: 500, body: { error: `couldn't read agentx.json: ${e?.message ?? e}` } } }
  let said: string[]
  try {
    said = applyOrgPlan(structuredClone(cfg), input, deps.root)
  } catch (e) {
    return { status: 422, body: { error: plain(e) } }
  }

  const text = said.join(" ")
  const ask = `${text} Apply?`
  const card = createCard(deps.root, {
    title: input.newAgent ? `Add ${input.newAgent.name} to the org chart` : "Change the org chart",
    ask: ask.length <= 300 ? ask : `Apply these ${said.length} changes to the org chart?`,
    ...(ask.length > 300 ? { context: said.map((s) => `- ${s}`).join("\n").slice(0, 600) } : {}),
    recommend: input.why ?? "Yes: you asked for this in chat, and every change was checked against the chart.",
    if_silent: "discard",
    raised_by: caller.agentId,
    ...(deps.reply ? { reply: deps.reply } : {}),
  }, { now: deps.now, settings: deps.settings, origin: { kind: "org-proposal" } })
  if (!card.ok) return { status: 400, body: { error: card.error } }

  saveOrgProposal(deps.root, {
    cardId: card.card.id,
    raised_by: caller.agentId,
    changes: input.changes,
    ...(input.newAgent ? { newAgent: input.newAgent } : {}),
    ...(input.why ? { why: input.why } : {}),
    shape: orgShapeHash(cfg),
    text,
    created_at: new Date(deps.now ?? Date.now()).toISOString(),
    status: "pending",
  })
  deps.onCard?.(card.card)
  return { status: 201, body: { card: card.card, text } }
}

/**
 * The owner answered an org proposal's card (approvals sweep,
 * onCardResult). On yes the daemon applies it in one write: when the chart
 * changed since the card, the changes are checked again first (they always
 * are, inside the write, so a refusal writes nothing). On no or expiry the
 * proposal is dropped. Runs once per proposal.
 */
export function applyOrgProposal(
  card: DecisionCard,
  deps: { root: string; configPath?: string; now?: number; skipReload?: boolean },
): OrgProposal | null {
  if (card.origin?.kind !== "org-proposal") return null
  const p = readOrgProposal(deps.root, card.id)
  if (!p || p.status !== "pending") return p
  const at = new Date(deps.now ?? Date.now()).toISOString()
  if (!(card.status === "decided" && card.verdict === "yes")) {
    const done: OrgProposal = { ...p, status: "dropped", result: "Not applied: the owner did not say yes.", done_at: at }
    saveOrgProposal(deps.root, done)
    return done
  }
  let done: OrgProposal
  try {
    let changed = false as boolean
    const { summary } = mutateAgentxConfig((cfg) => {
      changed = orgShapeHash(cfg) !== p.shape
      return applyOrgPlan(cfg, p, deps.root).join(" ")
    }, { configPath: deps.configPath, skipReload: deps.skipReload })
    if (p.newAgent) {
      const ws = agentsDir(deps.root, p.newAgent.id)
      const claudeMd = resolve(ws, "CLAUDE.md")
      if (!existsSync(claudeMd)) {
        try {
          mkdirSync(ws, { recursive: true })
          writeFileSync(claudeMd, `# ${p.newAgent.name}\n\nYou are ${p.newAgent.name}.\n`)
        } catch { /* best effort, as Add agent on the Hub */ }
      }
    }
    const note = (changed ? " The chart had changed since the card; the changes were checked again and still hold." : "") +
      (p.newAgent ? " The new agent starts after the next daemon restart." : "")
    done = { ...p, status: "applied", result: summary + note, done_at: at }
  } catch (e) {
    done = { ...p, status: "failed", result: plain(e), done_at: at }
  }
  saveOrgProposal(deps.root, done)
  return done
}

/** Lines added to the raising agent's result message. */
export function orgProposalLines(p: OrgProposal | null): string[] {
  if (!p) return []
  if (p.status === "applied") return [`The daemon applied it to the org chart: ${p.result}`, "Do not change the org chart yourself; tell the owner it is done."]
  if (p.status === "failed") return [`The daemon could not apply it: ${p.result} Nothing was changed. Tell the owner in one sentence.`]
  return ["Nothing was changed in the org chart."]
}
