import { renderWallPage } from "../src/daemon/ui/pages/wall"
import { WALL_PAGE_SCRIPT } from "../src/daemon/ui/pages/wall.client"
import { CRON_VALUE_SCRIPT } from "../src/daemon/ui/cron-value"

// The Hub page's real script against a stubbed DOM and fetch, for the
// Settings tests (#1428): test/wall-settings*.test.ts.

export const STATE = {
  exists: true,
  agents: [
    { id: "cx", name: "Customer Desk", tier: "claude-code", model: "model-a", mentions: ["@cx", "cx"], access: "private", systemPrompt: "You answer customers.",
      maxConcurrent: 2, maxExecutionMinutes: 20, permissionMode: "default", wikiAbsorb: true,
      integrations: [{ kind: "custom", label: "Team CRM", enabled: true, credentials: { tokenEnv: "CRM_TOKEN" }, credStatus: { tokenEnv: "unset" }, metadata: {} }] },
    { id: "ops", name: "Night Shift", tier: "codex-cli", mentions: ["@ops"], access: "public", maxConcurrent: 1, maxExecutionMinutes: 20, permissionMode: "default", wikiAbsorb: true, integrations: [] },
    { id: "new", name: "New Hire", tier: "claude-code", mentions: ["@new"], access: "private", maxConcurrent: 1, maxExecutionMinutes: 20, permissionMode: "default", wikiAbsorb: true, integrations: [] },
  ],
  wikiCurator: { enabled: true, agent: "" },
  crons: [
    { id: "digest", schedule: "0 9 * * *", agent: "cx", model: "", enabled: true },
    { id: "audit", schedule: "0 3 * * 1", agent: "cx", model: "model-z", enabled: true },
    { id: "night", schedule: "0 1 * * *", agent: "ops", model: "", enabled: true },
  ],
  daemonUrl: "http://node-a:18800/",
  webhooks: [
    { id: "repo", source: "github", agentId: "cx", secretEnv: "GH_SECRET", description: "Main repo", enabled: true, triggers: { "issues.opened": "triage" }, defaultWorkflow: "" },
    { id: "pay", source: "stripe", agentId: "ops", secretEnv: "", enabled: false },
  ],
}
export const BUDGETS = { agents: [{ agentId: "cx", spentUsd: 12.5, capUsd: 40, state: "ok" }], agentIds: ["cx", "ops", "new"] }
export const ORG = {
  roots: [{ id: "cx", name: "Customer Desk", title: "Support lead", status: "idle", reports: [{ id: "ops", name: "Night Shift", status: "paused", heldBy: "the owner", reports: [] }] }],
  outside: [{ id: "new", name: "New Hire", status: "waiting", reports: [] }],
  live: true,
}
export const LIVE = { nodes: [{ name: "node-a", url: "http://node-a", reachable: true, agents: [{ id: "cx", name: "Customer Desk", runningTasks: [] }, { id: "ops", name: "Night Shift", runningTasks: [] }] }] }

export type Reply = { status: number; body: unknown }
export type Route = (url: string, init: any) => Reply | undefined

export function openWall(opts: { hash: string; owner?: boolean; business?: boolean; signIn?: boolean; route?: Route }) {
  const page = renderWallPage({ owner: opts.owner ?? true, business: opts.business, signIn: opts.signIn })
  const cfg = /<script>window\.AX_WALL_SETTINGS = (.*?);<\/script>/.exec(page)
  const script = CRON_VALUE_SCRIPT + "\n" + WALL_PAGE_SCRIPT
  const els = new Map<string, any>()
  let paints = 0
  const classes = () => { const s = new Set<string>(); return { toggle: (c: string, on?: boolean) => { (on ?? !s.has(c)) ? s.add(c) : s.delete(c); return s.has(c) }, contains: (c: string) => s.has(c), add: (c: string) => s.add(c), remove: (c: string) => s.delete(c) } }
  const attrsOf = (tag: string) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2].replace(/&amp;/g, "&").replace(/&quot;/g, '"')]))
  const make = (id: string, tag: string) => {
    let html = ""
    const e: any = {
      id, attrs: attrsOf(tag), hidden: /\shidden[\s>]/.test(tag), textContent: "", value: id === "f-status" ? "open" : "", checked: false,
      type: /type="checkbox"/.test(tag) ? "checkbox" : "select", style: {}, className: "", classList: classes(), parentNode: { classList: classes() },
      get innerHTML() { return html },
      set innerHTML(v: string) {
        html = v
        if (id === "wall-settings") paints++
        for (const m of v.matchAll(/<(\w+)\b[^>]*\sid="([^"]+)"[^>]*>/g)) els.set(m[2], make(m[2], m[0]))
      },
      getAttribute: (k: string) => e.attrs[k] ?? null, setAttribute: (k: string, v: string) => { e.attrs[k] = v }, removeAttribute: (k: string) => { delete e.attrs[k] },
      hasAttribute: (k: string) => k in e.attrs, addEventListener: () => {}, focus: () => {},
      querySelector: () => null,
    }
    return e
  }
  // A browser returns null for an id that is not on the page; the page's
  // markup and script text both count, as in the other Wall tests.
  const el = (id: string) => {
    if (!els.has(id)) {
      const tag = new RegExp(`<[^>]*\\sid="${id}"[^>]*>`).exec(page)
      if (!tag) return null
      els.set(id, make(id, tag[0]))
    }
    return els.get(id)
  }
  const onDoc: Record<string, Array<(ev: any) => void>> = {}
  const onWindow: Record<string, () => void> = {}
  const wall = { classList: classes() }
  const doc = {
    getElementById: el, hidden: false, activeElement: null,
    querySelector: (sel: string) => (sel === ".ax-wall" ? wall : null),
    querySelectorAll: () => [],
    addEventListener: (t: string, f: (ev: any) => void) => { (onDoc[t] ??= []).push(f) },
    createElement: () => ({ className: "", innerHTML: "", setAttribute() {}, querySelector: () => ({ setAttribute() {}, innerHTML: "" }) }),
  }
  const loc: any = { search: "", href: "" }
  let hash = opts.hash
  Object.defineProperty(loc, "hash", { get: () => hash, set: (h: string) => { hash = h.startsWith("#") || !h ? h : "#" + h; Promise.resolve().then(() => onWindow.hashchange?.()) } })
  const calls: Array<{ url: string; method: string; body: any }> = []
  const fetchStub = (url: string, init: any = {}) => {
    const method = init.method || "GET"
    calls.push({ url, method, body: init.body ? JSON.parse(init.body) : undefined })
    const r = opts.route?.(url, init)
      ?? (url === "/api/admin/state" ? { status: 200, body: STATE }
        : url === "/api/admin/org" ? { status: 200, body: ORG }
        : url.startsWith("/api/live?") ? { status: 200, body: LIVE }
        : url === "/api/admin/observability/budgets" ? { status: 200, body: BUDGETS }
        : url.startsWith("/api/admin/wall?") ? { status: 200, body: { node: "node-a", syncedAt: Date.now(), nodes: [{ name: "node-a", ok: true }], failures: [], posts: [] } }
        : method !== "GET" ? { status: 200, body: { summary: "ok" } }
        : { status: 200, body: { runs: [] } })
    return Promise.resolve({ ok: r.status < 400, status: r.status, json: async () => r.body, text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)) })
  }
  const win: any = { addEventListener: (t: string, f: () => void) => { onWindow[t] = f } }
  if (cfg) win.AX_WALL_SETTINGS = JSON.parse(cfg[1])
  if (page.includes("<script>window.AX_WALL_SIGN_IN = true;</script>")) win.AX_WALL_SIGN_IN = true
  class FakeEventSource { constructor() {} addEventListener() {} close() {} }
  new Function("document", "window", "fetch", "location", "history", "localStorage", "setInterval", "EventSource", "requestAnimationFrame", script)(
    doc, win, fetchStub, loc, { replaceState: (_: unknown, __: string, h: string) => { hash = h } },
    { getItem: () => null, setItem: () => {} }, () => 0, FakeEventSource, (f: () => void) => { f(); return 1 },
  )
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise<void>((r) => setTimeout(r, 0)) }
  const go = async (h: string) => { hash = h; onWindow.hashchange?.(); await settle() }
  /** A click on an element carrying these attributes. */
  const click = async (attrs: Record<string, string>) => {
    const t: any = { getAttribute: (k: string) => attrs[k] ?? null, hasAttribute: (k: string) => k in attrs }
    t.closest = (sel: string) => sel.split(",").some((s) => Object.keys(attrs).some((k) => s.trim() === `[${k}]`)) ? t : null
    for (const f of onDoc.click ?? []) f({ target: t, preventDefault() {} })
    await settle()
  }
  const submit = async (attrs: Record<string, string>) => {
    const form: any = { getAttribute: (k: string) => attrs[k] ?? null }
    for (const f of onDoc.submit ?? []) f({ target: { closest: () => form }, preventDefault() {} })
    await settle()
  }
  /** Typing in a field, or ticking a box: the field changes, then its input event. */
  const type = async (id: string, v: string | boolean) => {
    const t = el(id)
    if (typeof v === "boolean") t.checked = v
    else t.value = v
    for (const f of onDoc.input ?? []) f({ target: t })
    await settle()
  }
  const key = async (k: string) => {
    for (const f of onDoc.keydown ?? []) f({ key: k, target: { id: "" }, preventDefault() {} })
    await settle()
  }
  /** A switch flipped: the change event on an element carrying these attributes. */
  const change = async (attrs: Record<string, string>, checked: boolean, value?: string) => {
    const t: any = { checked, value, getAttribute: (k: string) => attrs[k] ?? null, hasAttribute: (k: string) => k in attrs }
    for (const f of onDoc.change ?? []) f({ target: t })
    await settle()
  }
  const writes = () => calls.filter((c) => c.method !== "GET")
  return { page, el, calls, writes, settle, go, click, submit, type, change, key, paints: () => paints, wall }
}

export const settingsHtml = (w: ReturnType<typeof openWall>) => w.el("wall-settings")!.innerHTML as string
