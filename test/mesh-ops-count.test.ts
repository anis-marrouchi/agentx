import { describe, expect, it } from "vitest"
import { renderMeshPage } from "../src/daemon/ui/pages/mesh"
import { MESH_OPS_SCRIPT } from "../src/daemon/ui/pages/mesh-ops.client"
import { liveWorkCount, type LtNode } from "../src/daemon/ui/pages/wall-tree"

// #2101-state: /mesh said "0 Tasks running" while the Hub listed runs. Its
// Operations view now counts with the Hub's rule (liveWorkCount), shipped
// to the page, so a slow node with its last answer counts and an agent two
// nodes list counts once.

const run = (id: string) => ({ id, startedAt: "2026-11-27T08:00:00Z" })
const NODES: LtNode[] = [
  { id: "mac", name: "primary", url: "http://mac", reachable: true, checking: true, staleSince: "2026-11-27T08:00:00Z", agents: [
    { id: "coder", name: "Coder", runningTasks: [run("c1"), run("c2")] },
  ] },
  { id: "peer", name: "peer", url: "http://peer", reachable: true, agents: [
    { id: "coder", name: "Coder", runningTasks: [run("c3")] },
    { id: "seif", name: "seif", runningTasks: [run("s1")] },
  ] },
]

/** The Operations view's render(), run against a stub page. */
function renderOps(nodes: LtNode[]) {
  const health: Record<number, unknown> = {}
  const text: Record<string, string> = {}
  const el = (id: string) => ({ id, hidden: false, innerHTML: "", set textContent(v: string) { text[id] = v }, addEventListener() {}, querySelectorAll: () => [] })
  const doc = { getElementById: el, querySelectorAll: () => [], dispatchEvent() {} }
  const MX = { esc: String, age: () => "now", setHealth: (i: number, v: unknown) => { health[i] = v }, get: () => new Promise(() => {}), open() {}, fields: () => "", section: () => "", dur: String }
  const body = MESH_OPS_SCRIPT.replace(/^<script>/, "").replace(/<\/script>$/, "")
    .replace("load();setInterval(load,5000);", "window.__render=render;")
  const win: any = {}
  const html = renderMeshPage({})
  const page = html.slice(html.indexOf("globalThis.__axBind"))
  const shared = page.slice(0, page.indexOf("</script>"))
  new Function("globalThis", shared)(win)
  new Function("document", "MX", "window", "CustomEvent", "Intl", "ltNodeCounts", "liveWorkCount", "ltNodeKey", body)(
    doc, MX, win, class {}, Intl, win.ltNodeCounts, win.liveWorkCount, win.ltNodeKey)
  win.__render({ ts: "2026-11-27T08:00:00Z", nodes })
  return { health, text }
}

describe("/mesh Operations counts with the Hub's rule (#2101-state)", () => {
  it("ships liveWorkCount to the page", () => {
    expect(renderMeshPage({})).toContain('globalThis.__axBind("liveWorkCount"')
  })

  it("Tasks running is the Hub's runs, with a slow node and an agent on two nodes", () => {
    const { health, text } = renderOps(NODES)
    const work = liveWorkCount(NODES)
    // coder counts once, on the up node (c3), never also on the slow one
    expect(work.runs).toBe(2)
    expect(health[1]).toBe(work.runs)
    expect(health[0]).toBe("2/2")
    expect(text["mx-active-count"]).toBe("2 active")
  })
})
