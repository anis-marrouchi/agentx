import { describe, expect, it } from "vitest"
import { renderMeshPage } from "../src/daemon/ui/pages/mesh"
import { MESH_FEED_SCRIPT } from "../src/daemon/ui/pages/mesh-feed.client"

const body = MESH_FEED_SCRIPT.replace(/^<script>/, "").replace(/<\/script>$/, "")

/** Run the feed script against a minimal DOM stand-in and one feed answer. */
async function run(answer: { node: string; events: unknown[] }) {
  const el = (): any => ({ innerHTML: "", textContent: "", hidden: false, dataset: {}, listeners: {} as Record<string, Function>,
    addEventListener(t: string, h: Function) { this.listeners[t] = h },
    setAttribute() {}, querySelectorAll: () => [] })
  const root = el(), more = el(), count = el()
  const chips = ["all", "peers", "announce", "problems"].map((id) => Object.assign(el(), { dataset: { feedFilter: id } }))
  const document = {
    getElementById: (id: string) => ({ "mx-feed": root, "mx-feed-more": more, "mx-feed-count": count } as any)[id] ?? null,
    querySelectorAll: () => chips,
  }
  const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
  const MX = { esc, age: () => "1m ago", plural: (n: number, one: string) => `${n} ${n === 1 ? one : one + "s"}`, fields: () => "", open: () => {}, get: async () => answer }
  const timers: unknown[] = []
  new Function("document", "MX", "localStorage", "setInterval", body)(
    document, MX, { getItem: () => null, setItem: () => {} }, (fn: unknown) => timers.push(fn))
  await new Promise((r) => setTimeout(r, 0))
  return { root, count, chips }
}

const ev = (over: Record<string, unknown>) => ({ id: String(Math.random()), rootId: "r", kind: "agent", type: "task:completed", at: new Date().toISOString(), summary: "completed in 5ms", ...over })

describe("mesh page feed", () => {
  it("renders the section with its filters and script", () => {
    const html = renderMeshPage({})
    expect(html).toContain('id="mx-feed"')
    expect(html).toContain('data-feed-filter="problems"')
    expect(html).toContain("/api/mesh/feed")
  })

  it("ships browser JS that parses", () => {
    expect(() => new Function(body)).not.toThrow()
  })

  it("shows peer activity, marks this machine, and filters to problems", async () => {
    const { root, count, chips } = await run({ node: "node-a", events: [
      ev({ node: "node-a", summary: "local work" }),
      ev({ node: "node-b", agentId: "helper", summary: "peer <work>" }),
      ev({ node: "node-a", kind: "mesh", type: "feed:down", summary: "peer node-c unreachable: refused" }),
      ev({ node: "node-b", kind: "announce", type: "announce", summary: "Maintenance tonight" }),
    ] })
    expect(count.textContent).toBe("4 events")
    expect(root.innerHTML).toContain("this machine")
    expect(root.innerHTML).toContain("peer &#60;work&#62;")
    expect(root.innerHTML).toContain("Unreachable")
    expect(root.innerHTML).toContain("Announcement")
    // Newest first.
    expect(root.innerHTML.indexOf("Maintenance tonight")).toBeLessThan(root.innerHTML.indexOf("local work"))

    chips[3].listeners.click()
    expect(count.textContent).toBe("1 event")
    expect(root.innerHTML).toContain("node-c unreachable")
    chips[1].listeners.click()
    expect(count.textContent).toBe("2 events")
    expect(root.innerHTML).not.toContain("local work")
  })
})
