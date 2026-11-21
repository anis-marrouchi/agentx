import { createHash } from "crypto"
import { fetchPeerJson, isSafeArticlePath, type PeerFetch } from "@/wiki/article-sync"
import { decisionsForBlock } from "@/wiki/decision-approvals"
import { isWikiArticleType, type WikiArticleMeta } from "@/wiki/types"
import type { WikiHub } from "@/wiki/hub"

/**
 * Keeps this node's copy of the Rules Registry page (noqta#809) in step
 * with the node that runs `rules.registryAgent`.
 *
 * Runs read the page from the local wiki (registry.ts `rulesForRun`), so a
 * node without the registry agent (clawd) needs a copy. This pulls that one
 * page through the mesh's `GET /wiki/article`, only from the peer whose own
 * agents include the registry agent, and only accepts an answer that says
 * so (`runsAgent`). It writes when the content hash changes.
 *
 * On every node with rules on, a missing page (or one the approval filter
 * drops) is an ERROR in the log, written when the state changes rather than
 * on every tick. `status()` feeds `/health.rules`; its md5 is over the page
 * content only, so the Mac and clawd show the same value for the same rules.
 */

export interface RulesSyncConfig {
  enabled: boolean
  registryAgent: string
  registryPage: string
  syncMinutes: number
  maxStaleHours: number
}

export interface RulesSyncPeer { name: string; url: string; token?: string }
export interface RulesSyncDirectoryEntry { peer: string; healthy: boolean; skills: Array<{ id: string }> }

export interface RulesSyncDeps {
  hub: WikiHub
  config: () => RulesSyncConfig
  /** True when this node runs the agent itself. */
  isLocalAgent: (agentId: string) => boolean
  /** `mesh.peers`: where to reach a peer and the token its wiki routes ask for. */
  peers: () => RulesSyncPeer[]
  /** The mesh directory: each peer's own agents, from its agent card. */
  directory: () => RulesSyncDirectoryEntry[]
  approvalsRequired: () => boolean
  fetchJson?: PeerFetch
  now?: () => number
  log: (msg: string) => void
}

export type RulesSyncStatus =
  | { enabled: false }
  | {
      enabled: true
      source: "local" | "peer"
      /** The page: `<agent>/<path>`. */
      page: string
      /** md5 of the page content (frontmatter left out); absent when there is no page. */
      md5?: string
      /** Peer mode: the node id and peer name the copy came from. */
      node?: string
      peer?: string
      /** Peer mode: last time the peer answered with the page. */
      syncedAt?: string
      warning?: string
      error?: string
    }

const FETCH_TIMEOUT_MS = 15_000

export function contentMd5(content: string): string {
  return createHash("md5").update(content.trim()).digest("hex")
}

export class RulesPageSync {
  private readonly startedAt: number
  private lastOkAt?: number
  private source?: { node: string; peer: string }
  private lastProblem?: string
  private loggedState?: string
  private timer?: ReturnType<typeof setInterval>
  private running = false

  constructor(private readonly deps: RulesSyncDeps) {
    this.startedAt = this.now()
  }

  private now(): number { return this.deps.now?.() ?? Date.now() }

  /** Tick at once, then every `rules.syncMinutes`. */
  start(): void {
    void this.tick()
    const minutes = Math.max(1, this.deps.config().syncMinutes)
    this.timer = setInterval(() => { void this.tick() }, minutes * 60_000)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** One pass: pull the page when the registry agent is on a peer, then
   *  log the state if it changed. Never throws. */
  async tick(): Promise<RulesSyncStatus> {
    const cfg = this.deps.config()
    if (!cfg.enabled) return { enabled: false }
    if (this.running) return this.status()
    this.running = true
    try {
      if (!this.deps.isLocalAgent(cfg.registryAgent)) {
        try {
          await this.pull(cfg)
        } catch (e) {
          this.lastProblem = (e as Error).message
        }
      }
    } finally {
      this.running = false
    }
    const st = this.status()
    this.logChange(st, cfg)
    return st
  }

  status(): RulesSyncStatus {
    const cfg = this.deps.config()
    if (!cfg.enabled) return { enabled: false }
    const local = this.deps.isLocalAgent(cfg.registryAgent)
    const page = `${cfg.registryAgent}/${cfg.registryPage}`
    const st: Extract<RulesSyncStatus, { enabled: true }> = { enabled: true, source: local ? "local" : "peer", page }

    let article
    try {
      article = this.deps.hub.getAgentWiki(cfg.registryAgent).readArticle(cfg.registryPage)
    } catch (e) {
      st.error = `registry page unreadable: ${page}: ${(e as Error).message}`
      return st
    }
    if (article) st.md5 = contentMd5(article.content)

    if (!local) {
      if (this.source) { st.node = this.source.node; st.peer = this.source.peer }
      if (this.lastOkAt) st.syncedAt = new Date(this.lastOkAt).toISOString()
      if (this.lastProblem) {
        const ageH = Math.floor((this.now() - (this.lastOkAt ?? this.startedAt)) / 3600_000)
        if (ageH >= cfg.maxStaleHours) {
          st.error = `registry copy is ${ageH}h old (limit ${cfg.maxStaleHours}h): ${this.lastProblem}`
        } else {
          st.warning = this.lastProblem
        }
      }
    }

    if (!article) {
      st.error = `registry page missing: ${page}`
    } else if (!st.error) {
      const store = this.deps.hub.getAgentWiki(cfg.registryAgent)
      const [readable] = decisionsForBlock([article], store.baseDir, this.deps.approvalsRequired())
      if (!readable) st.error = `registry page not approved, runs get no rules: ${page}`
    }
    return st
  }

  private async pull(cfg: RulesSyncConfig): Promise<void> {
    const agent = cfg.registryAgent
    const owners = this.deps.directory().filter((p) => p.skills.some((s) => s.id === agent))
    if (owners.length === 0) throw new Error(`no mesh peer runs ${agent}; keeping the local copy`)
    if (owners.length > 1) {
      throw new Error(`more than one mesh peer runs ${agent} (${owners.map((o) => o.peer).join(", ")}); not syncing`)
    }
    const owner = owners[0]
    const peer = this.deps.peers().find((p) => p.name === owner.peer)
    if (!peer) throw new Error(`mesh peer ${owner.peer} runs ${agent} but is not in mesh.peers`)

    const store = this.deps.hub.getAgentWiki(agent)
    if (!isSafeArticlePath(store.baseDir, cfg.registryPage)) throw new Error(`unsafe rules.registryPage: ${cfg.registryPage}`)

    const fetchJson = this.deps.fetchJson ?? fetchPeerJson
    const body = await fetchJson(
      { url: peer.url, token: peer.token },
      `/wiki/article?agent=${encodeURIComponent(agent)}&path=${encodeURIComponent(cfg.registryPage)}`,
      FETCH_TIMEOUT_MS,
    )
    const node = typeof body?.nodeId === "string" ? body.nodeId : "unknown"
    // The directory said this peer runs the agent; the route must agree.
    // An older peer leaves the field out and is refused too.
    if (body?.runsAgent !== true) throw new Error(`peer ${peer.name} (node ${node}) does not run ${agent}; answer refused`)
    if (typeof body.content !== "string") throw new Error(`peer ${peer.name} (node ${node}) sent no page content`)

    const remoteMd5 = contentMd5(body.content)
    const existing = store.readArticle(cfg.registryPage)
    if (!existing || contentMd5(existing.content) !== remoteMd5) {
      const meta: WikiArticleMeta = {
        title: String(body.title || existing?.meta.title || "Rules Registry"),
        type: isWikiArticleType(body.type) ? body.type : (existing?.meta.type ?? "decision"),
        tags: Array.isArray(body.tags) ? body.tags.map(String) : (existing?.meta.tags ?? []),
        owner: String(body.owner || existing?.meta.owner || agent),
        access: body.access === "private" || body.access === "shared" || body.access === "public"
          ? body.access : (existing?.meta.access ?? "public"),
        created: String(body.created ?? existing?.meta.created ?? ""),
        lastUpdated: String(body.lastUpdated ?? ""),
        sources: Array.isArray(body.sources) ? body.sources.map(String) : [],
      }
      const ok = store.writeArticle(cfg.registryPage, meta, body.content.trim(), existing?.meta.owner || meta.owner)
      if (!ok) throw new Error(`could not write ${agent}/${cfg.registryPage} (see the wiki log)`)
      const back = store.readArticle(cfg.registryPage)
      if (!back || contentMd5(back.content) !== remoteMd5) throw new Error(`copy of ${agent}/${cfg.registryPage} does not read back the same`)
      this.deps.log(`[rules] registry synced from node ${node} (peer ${peer.name}), md5 ${remoteMd5}`)
    }
    this.source = { node, peer: peer.name }
    this.lastOkAt = this.now()
    this.lastProblem = undefined
  }

  private logChange(st: RulesSyncStatus, cfg: RulesSyncConfig): void {
    if (!st.enabled) return
    const state = st.error ? `E:${st.error}` : st.warning ? `W:${st.warning}` : "ok"
    if (state === this.loggedState) return
    // Stale-age errors change their number every hour; log the first.
    if (st.error && this.loggedState?.startsWith("E:registry copy is") && st.error.startsWith("registry copy is")) return
    const first = this.loggedState === undefined
    this.loggedState = state
    if (st.error) this.deps.log(`[rules] ERROR ${st.error}`)
    else if (st.warning) this.deps.log(`[rules] WARN ${st.warning}`)
    else if (!first) this.deps.log(`[rules] registry page ok: ${cfg.registryAgent}/${cfg.registryPage}, md5 ${st.md5}`)
  }
}
