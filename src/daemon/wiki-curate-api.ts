// --- Wiki page curator API (#818) ---
//
//   GET  /api/wiki/curate?agent=<id>&path=<page.md>   settings + this page's chat
//   POST /api/wiki/curate          { agent, path, message }   start a turn
//   POST /api/wiki/curate/restore  { agent, path, version }   undo an edit
//
// `agent` and `path` name the page (the wiki it lives in and its file),
// not the agent that answers: that comes from `wiki.curator`. A turn runs
// in the background and the bubble polls, like the Ask-an-agent drawer.
// The chat is kept in memory; the page's versions are on disk.

import type { IncomingMessage, ServerResponse } from "http"
import type { WikiHub } from "@/wiki/hub"
import type { WikiStore } from "@/wiki/store"
import { isSafeArticlePath } from "@/wiki/article-sync"
import { LockBusyError } from "@/wiki/facts/ledger-file"
import type { WikiArticle } from "@/wiki/types"
import {
  applyCuration, buildCuratePrompt, curatorAgentFor, pageFingerprint, parseCurateReply,
  type CuratorSettings, type CuratorTurn, type DiffLine,
} from "@/wiki/curate"

export interface CurateMessage {
  id: number
  role: "owner" | "agent"
  text: string
  status: "pending" | "done" | "error"
  at: string
  /** The answering agent, on agent messages. */
  agent?: string
  edit?: {
    version?: string
    diff: DiffLine[]
    added: number
    removed: number
    sources: string[]
    restored?: boolean
  }
}

export interface WikiCurateDeps {
  hub: () => WikiHub
  settings: () => CuratorSettings
  agents: () => string[]
  /** Run one agent turn and return its final message. */
  execute: (agentId: string, prompt: string, requestText: string) => Promise<{ content?: string; error?: string }>
  log?: (msg: string) => void
}

interface PageRef {
  agentId: string
  path: string
  store: WikiStore
  article: WikiArticle
  readOnly: boolean
}

const MAX_MESSAGES = 40
const MAX_PAGES = 200

export class WikiCurateApi {
  private chats = new Map<string, CurateMessage[]>()
  private seq = 0

  constructor(private deps: WikiCurateDeps) {}

  /** True when the path is one of these routes (a response was sent). */
  async handle(req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<boolean> {
    if (path !== "/api/wiki/curate" && path !== "/api/wiki/curate/restore") return false
    try {
      if (req.method === "GET" && path === "/api/wiki/curate") {
        const page = this.page(url.searchParams.get("agent"), url.searchParams.get("path"))
        if ("error" in page) return send(res, page.status, { error: page.error })
        const settings = this.deps.settings()
        const curator = curatorAgentFor(settings, page.article, page.agentId, this.deps.agents())
        return send(res, 200, {
          enabled: settings.enabled,
          curator,
          title: page.article.meta.title,
          readOnly: page.readOnly,
          versions: page.store.getVersions(page.path).slice(0, 10).map(v => v.timestamp),
          messages: this.chats.get(key(page.agentId, page.path)) ?? [],
        })
      }
      if (req.method !== "POST") return send(res, 405, { error: "method not allowed" })
      let body: any
      try { body = await readJson(req) } catch (e: any) { return send(res, 400, { error: e.message }) }
      const page = this.page(body?.agent, body?.path)
      if ("error" in page) return send(res, page.status, { error: page.error })
      if (page.readOnly) return send(res, 409, { error: "this page is a copy from another node; edit it there" })
      const settings = this.deps.settings()
      if (!settings.enabled) return send(res, 403, { error: "the wiki curator is turned off (wiki.curator.enabled)" })

      if (path === "/api/wiki/curate/restore") {
        const version = String(body?.version ?? "")
        if (!version || !page.store.getVersions(page.path).some(v => v.timestamp === version)) {
          return send(res, 404, { error: "no such version" })
        }
        let restored: boolean
        try { restored = page.store.restoreVersion(page.path, version) } catch (e) {
          if (e instanceof LockBusyError) return send(res, 409, { error: "the page was busy; run again" })
          throw e
        }
        if (!restored) return send(res, 500, { error: "restore failed" })
        const chat = this.chats.get(key(page.agentId, page.path)) ?? []
        for (const m of chat) if (m.edit?.version === version) m.edit.restored = true
        this.push(page.agentId, page.path, { role: "agent", agent: "AgentX", text: `Put the page back as it was on ${version.slice(0, 10)}, before that change.`, status: "done" })
        return send(res, 200, { ok: true })
      }

      const message = String(body?.message ?? "").trim()
      if (!message) return send(res, 400, { error: "message required" })
      const curator = curatorAgentFor(settings, page.article, page.agentId, this.deps.agents())
      if (!this.deps.agents().includes(curator)) {
        return send(res, 404, { error: `no agent "${curator}" on this node; set wiki.curator.agent` })
      }
      const k = key(page.agentId, page.path)
      if ((this.chats.get(k) ?? []).some(m => m.status === "pending")) {
        return send(res, 409, { error: "the agent is still working on the last instruction" })
      }

      const history: CuratorTurn[] = (this.chats.get(k) ?? [])
        .filter(m => m.status === "done").map(m => ({ role: m.role, text: m.text }))
      this.push(page.agentId, page.path, { role: "owner", text: message.slice(0, 4000), status: "done" })
      const reply = this.push(page.agentId, page.path, { role: "agent", text: "", status: "pending", agent: curator })
      const prompt = buildCuratePrompt({ agentId: page.agentId, path: page.path, article: page.article, instruction: message, history })
      const fingerprint = pageFingerprint(page.article)

      void (async () => {
        try {
          const resp = await this.deps.execute(curator, prompt, message)
          if (resp.error) { finish(reply, String(resp.error), "error"); return }
          const parsed = parseCurateReply(resp.content ?? "")
          if (parsed.content === undefined) { finish(reply, parsed.summary, "done"); return }
          const applied = applyCuration(page.store, page.path, parsed, { curator, instruction: message, expectedFingerprint: fingerprint })
          if (!applied.ok) { finish(reply, `${parsed.summary}\n\n${applied.error}`, "error"); return }
          reply.edit = { version: applied.version, diff: applied.diff, added: applied.added, removed: applied.removed, sources: applied.sources }
          finish(reply, applied.added + applied.removed ? parsed.summary : `${parsed.summary}\n\nThe page text did not change.`, "done")
        } catch (e: any) {
          finish(reply, String(e?.message || e), "error")
        }
      })()
      return send(res, 200, { pending: true, id: reply.id, curator })
    } catch (e: any) {
      this.deps.log?.(`wiki curate: ${e?.message || e}`)
      return send(res, 500, { error: String(e?.message || e) })
    }
  }

  private page(agentId: unknown, path: unknown): PageRef | { error: string; status: number } {
    const a = typeof agentId === "string" ? agentId.trim() : ""
    const p = typeof path === "string" ? path.trim() : ""
    if (!a || !p) return { error: "agent and a page path are required", status: 400 }
    const hub = this.deps.hub()
    if (!hub.listAgents([]).includes(a)) return { error: `no wiki for "${a}"`, status: 404 }
    const store = hub.getAgentWiki(a)
    if (!isSafeArticlePath(store.baseDir, p)) return { error: "not a page path", status: 400 }
    const article = store.readArticle(p)
    if (!article) return { error: "no such page", status: 404 }
    return { agentId: a, path: p, store, article, readOnly: !!hub.syncedFrom(a) }
  }

  private push(agentId: string, path: string, m: Omit<CurateMessage, "id" | "at">): CurateMessage {
    const k = key(agentId, path)
    const chat = this.chats.get(k) ?? []
    const msg: CurateMessage = { ...m, id: ++this.seq, at: new Date().toISOString() }
    chat.push(msg)
    if (chat.length > MAX_MESSAGES) chat.splice(0, chat.length - MAX_MESSAGES)
    this.chats.delete(k)
    this.chats.set(k, chat)
    // Oldest chats go first.
    while (this.chats.size > MAX_PAGES) this.chats.delete(this.chats.keys().next().value!)
    return msg
  }
}

function finish(m: CurateMessage, text: string, status: "done" | "error"): void {
  m.text = text.trim() || (status === "error" ? "The agent failed without a message." : "Done.")
  m.status = status
}

function key(agentId: string, path: string): string {
  return `${agentId}\u0000${path}`
}

function send(res: ServerResponse, status: number, data: unknown): true {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(data))
  return true
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let d = ""
    req.on("data", c => { d += c; if (d.length > 64_000) { reject(new Error("body too large")); req.destroy() } })
    req.on("end", () => { try { resolve(d ? JSON.parse(d) : {}) } catch { reject(new Error("invalid JSON body")) } })
    req.on("error", reject)
  })
}
