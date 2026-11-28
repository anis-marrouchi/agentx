// The React Hub's simple shell (#2226 S3): what its side menu lists for each
// layout and switch, where /hub opens, and the three columns it draws.
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { describe, expect, it } from "vitest"
import { resolveHubLayout, HUB_SHOW_IDS } from "../src/hub/layout"
import { PAGE_SHELL, SHELL_MAIN, SHELL_MORE, SHELL_PAGE, currentLayout, shellLandingHash, shellNav, type ShellMenu } from "../src/hub/shell"
import { hubMenuCatalog } from "../src/daemon/ui/pages/wall"
import { presetItems, type MenuItem } from "../src/daemon/hub-menu"
import { HUB_REACT_PAGES, hubReactPageIds } from "../src/hub/pages"
import { ChatTurn, RightTabs, SimpleShell, shellAgents, type SimpleShellProps } from "../src/hub/pages/ShellPage"
import { TooltipProvider } from "../src/hub/ui"
import { ICON_NAMES } from "../src/hub/ui/icons"

const ids = (items: { id: string }[]) => items.map((i) => i.id)
const simple = resolveHubLayout({ layout: "simple" })
const full = resolveHubLayout({ layout: "full" })

describe("shell side menu per layout", () => {
  it("lists the issue's default items in its order, whatever the layout", () => {
    const want = ["search", "tasks", "automations", "agents", "projects", "needs"]
    expect(ids(shellNav(simple, { owner: true }).main)).toEqual(want)
    expect(ids(shellNav(full, { owner: true }).main)).toEqual(want)
  })
  it("simple: nothing under More", () => {
    expect(shellNav(simple, { owner: true }).more).toEqual([])
  })
  it("full: every hidden item that is a place, in Settings order", () => {
    expect(ids(shellNav(full, { owner: true }).more)).toEqual(["mobile", "workflows", "wiki", "activity", "org", "sessions", "usage"])
  })
  it("one switch on in simple shows that item only", () => {
    const v = resolveHubLayout({ layout: "simple", show: { workflows: true } })
    expect(ids(shellNav(v, { owner: true }).more)).toEqual(["workflows"])
  })
  it("one switch off in full hides that item only", () => {
    const v = resolveHubLayout({ layout: "full", show: { org: false, wiki: false } })
    expect(ids(shellNav(v, { owner: true }).more)).toEqual(["mobile", "workflows", "activity", "sessions", "usage"])
  })
  it("rules, gates and hosts are not menu items", () => {
    const v = resolveHubLayout({ layout: "simple", show: { rules: true, gates: true, hosts: true } })
    expect(shellNav(v, { owner: true }).more).toEqual([])
  })
  it("Settings for the owner only", () => {
    expect(ids(shellNav(simple, { owner: true }).foot)).toEqual(["settings"])
    expect(shellNav(simple, { owner: false }).foot).toEqual([])
  })
  it("every item has a known icon and a link (Search opens in place)", () => {
    const all = [...SHELL_MAIN, ...Object.values(SHELL_MORE)]
    for (const item of all) expect(ICON_NAMES).toContain(item.icon)
    for (const item of all) if (item.id !== "search") expect(item.href).toBeTruthy()
    for (const id of Object.keys(SHELL_MORE)) expect(HUB_SHOW_IDS).toContain(id)
  })
  it("Tasks opens the shell's own pane, never the old Hub's last view", () => {
    const tasks = SHELL_MAIN.find((i) => i.id === "tasks")!
    expect(new URLSearchParams(tasks.href!.slice(1)).get("pane")).toBe("tasks")
  })
})

describe("where /hub opens", () => {
  const boot = (layout = simple, pages = [SHELL_PAGE]) => ({ layout, pages })
  it("simple layout, bare /hub: the shell", () => {
    expect(shellLandingHash("", boot())).toBe("#page=home")
    expect(shellLandingHash("#", boot())).toBe("#page=home")
  })
  it("a hash that names anything stays where it is", () => {
    expect(shellLandingHash("#status=open", boot())).toBeNull()
    expect(shellLandingHash("#page=settings", boot())).toBeNull()
  })
  it("full layout, or a viewer without the shell: the old Hub", () => {
    expect(shellLandingHash("", boot(full))).toBeNull()
    expect(shellLandingHash("", boot(simple, []))).toBeNull()
  })
  it("the shell is a React page for the owner only", () => {
    expect(HUB_REACT_PAGES.find((p) => p.page === SHELL_PAGE)?.ownerOnly).toBe(true)
    expect(hubReactPageIds(true)).toContain(SHELL_PAGE)
    expect(hubReactPageIds(false)).not.toContain(SHELL_PAGE)
    expect(hubReactPageIds(true, [SHELL_PAGE])).not.toContain(SHELL_PAGE)
  })
})

describe("the layout now", () => {
  it("is the boot's until Settings saves one", () => {
    expect(currentLayout({ layout: simple }, {}).show.workflows).toBe(false)
  })
  it("follows a save from Settings › Layout with no reload", () => {
    const saved = resolveHubLayout({ layout: "simple", show: { workflows: true } })
    const now = currentLayout({ layout: simple }, { AX_HUB_LAYOUT: saved })
    expect(now.layout).toBe("simple")
    expect(now.show.workflows).toBe(true)
    expect(now.show.wiki).toBe(false)
  })
  it("ignores a value that is not a view", () => {
    expect(currentLayout({ layout: simple }, { AX_HUB_LAYOUT: "full" })).toBe(simple)
  })
})

describe("agents for the menu", () => {
  it("reads a list or { agents }, drops rows without an id", () => {
    expect(shellAgents([{ id: "a", name: "Ada", model: "m1" }, {}])).toEqual([{ id: "a", name: "Ada", model: "m1" }])
    expect(shellAgents({ agents: [{ id: "b" }] })).toEqual([{ id: "b", name: "b" }])
    expect(shellAgents(null)).toEqual([])
  })
})

function draw(p: Partial<SimpleShellProps> = {}): string {
  const props: SimpleShellProps = { view: simple, owner: true, agents: [{ id: "ada", name: "Ada", model: "model-x" }], agent: "ada", ...p }
  const client = new QueryClient()
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(TooltipProvider, null, createElement(SimpleShell, props))),
  )
}

describe("the shell draws three columns", () => {
  it("side menu and chat; the right tabs, Run artifacts first, once there is a thread (#2455)", () => {
    const html = draw()
    expect(html).toContain('data-shell="simple"')
    expect(html).toContain('data-shell="menu"')
    expect(html).toContain('data-shell="chat"')
    // No thread yet: no third column on a computer (E3).
    expect(html).not.toContain('data-shell="tabs"')
    const tabs = renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(RightTabs, { threadId: null })))
    expect(tabs).toContain('data-shell="tabs"')
    expect(tabs).toMatch(/role="tab"[^>]*>[\s\S]*?Run artifacts<\/button>/)
  })

  it("leaves the 30 px status bar in view on a computer (#2101 R5)", () => {
    const root = draw().match(/<div[^>]*data-shell="simple"[^>]*>/)?.[0] ?? ""
    expect(root).toContain("bottom-[30px]")
    expect(root).not.toContain("inset-0")
  })
  it("simple: the default items, no hidden item", () => {
    const html = draw()
    for (const id of ["search", "tasks", "automations", "agents", "projects", "needs", "settings"]) expect(html).toContain(`data-shell-item="${id}"`)
    expect(html).not.toContain('data-shell-group="more"')
    for (const id of Object.keys(SHELL_MORE)) expect(html).not.toContain(`data-shell-item="${id}"`)
  })
  it("full: the hidden items under More", () => {
    const html = draw({ view: full })
    expect(html).toContain('data-layout="full"')
    expect(html).toContain('data-shell-group="more"')
    for (const id of Object.keys(SHELL_MORE)) expect(html).toContain(`data-shell-item="${id}"`)
  })
  it("a switch turned on shows its item in the simple layout", () => {
    const html = draw({ view: resolveHubLayout({ layout: "simple", show: { workflows: true } }) })
    expect(html).toContain('data-shell-item="workflows"')
    expect(html).toContain('href="#page=workflows"')
    expect(html).not.toContain('data-shell-item="mobile"')
  })
  it("without the grouped rows, lists the agents as not working today, folded", () => {
    const html = draw()
    expect(html).toMatch(/data-shell-group="idle"[\s\S]*?aria-expanded="false"[\s\S]*?Not working today[\s\S]*?>1</)
    expect(html).not.toContain('data-shell-agent="ada"')
  })
  it("lists the agents and chats with the one in view", () => {
    const html = draw({ model: { rows: [{ id: "ada", name: "Ada", node: "", nodeUrl: "", color: null, face: "A", state: "working", line: "Writing", ageMs: 60_000, at: 0, unread: 0, taskId: "", runs: 1, today: 2 }], counts: { all: 1, working: 1, needs: 0, failed: 0, done: 0, idle: 0 } } })
    expect(html).toContain('data-shell-agent="ada"')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain("Message Ada")
    expect(html).toContain("model-x")
    expect(html).toContain('data-shell="machine"')
  })
  it("the message list is announced politely (A17)", () => {
    expect(draw()).toMatch(/aria-live="polite"[^>]*data-shell="messages"/)
  })
  it("an empty chat greets and offers suggestion pills (A14)", () => {
    const html = draw()
    expect(html).toContain("Ask Ada anything")
    const pills = html.match(/data-shell="suggestion"/g) ?? []
    expect(pills.length).toBeGreaterThanOrEqual(2)
    expect(pills.length).toBeLessThanOrEqual(4)
    expect(html).toMatch(/rounded-full[^"]*"[^>]*data-shell="suggestion"/)
  })
  it("a failed answer shows its error with Try again (P10)", () => {
    const turn = (onRetry?: () => void) => renderToStaticMarkup(createElement(ChatTurn, { m: { seq: 2, role: "assistant", content: "The run timed out.", status: "error" }, onRetry }))
    expect(turn(() => {})).toMatch(/data-shell="turn-error"[\s\S]*?The run timed out\.[\s\S]*?<button[^>]*data-variant="outline"[^>]*data-size="sm"[^>]*>[\s\S]*?Try again<\/button>/)
    expect(turn()).not.toContain("Try again")
  })
  it("the last answer has Copy; a pending one shows the Working line", () => {
    const wrapT = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(TooltipProvider, null, el))
    expect(wrapT(createElement(ChatTurn, { m: { seq: 2, role: "assistant", content: "Hi", status: "done" }, last: true }))).toContain('aria-label="Copy"')
    expect(wrapT(createElement(ChatTurn, { m: { seq: 2, role: "assistant", content: "Hi", status: "done" } }))).not.toContain('aria-label="Copy"')
    expect(wrapT(createElement(ChatTurn, { m: { seq: 3, role: "assistant", content: "", status: "pending" } }))).toMatch(/role="status"[^>]*>Working…/)
  })
  it("no agent: says to pick one, the box is off", () => {
    const html = draw({ agents: [], agent: undefined })
    expect(html).toContain("No agents yet.")
    expect(html).toContain("Pick an agent to chat with")
    expect(html).toMatch(/<textarea[^>]*disabled/)
  })
})

// #2149 M2: the side menu follows the owner's saved Hub menu.
describe("the saved Hub menu (#2149 M2)", () => {
  const catalog = hubMenuCatalog()
  const saved = (items: MenuItem[], isSaved = true): ShellMenu => ({ menu: { items }, saved: isSaved, catalog })
  const mine = saved([
    { id: "g1", kind: "group", label: "Daily" },
    { id: "m1", kind: "page", page: "needs" },
    { id: "m2", kind: "page", page: "wall", label: "My work" },
    { id: "m3", kind: "view", page: "wall", label: "Blocked", icon: "star", filter: { status: "blocked", project: "acme" } },
    { id: "g2", kind: "group", label: "Empty" },
    { id: "g3", kind: "group", label: "Fleet" },
    { id: "m4", kind: "page", page: "people" },
    { id: "pin_1", kind: "link", label: "Docs", url: "https://example.com/docs" },
  ])

  it("unsaved: the default list, as before", () => {
    expect(shellNav(simple, { owner: true, menu: saved(mine.menu.items as MenuItem[], false) })).toEqual(shellNav(simple, { owner: true }))
  })
  it("saved: Search and Agents, then the owner's items in order, empty groups dropped", () => {
    const nav = shellNav(simple, { owner: true, menu: mine })
    expect(ids(nav.main)).toEqual(["search", "agents", "g1", "needs", "tasks", "m3", "g3", "people", "pin_1"])
    expect(nav.main.find((i) => i.id === "tasks")!.label).toBe("My work")
    expect(nav.main.find((i) => i.id === "m3")!.href).toBe("#view=feed&status=blocked&project=acme")
    expect(nav.main.find((i) => i.id === "people")!.href).toBe("#page=people")
    expect(nav.main.find((i) => i.id === "pin_1")).toMatchObject({ href: "https://example.com/docs", external: true })
    expect(nav.more).toEqual([])
    expect(ids(nav.foot)).toEqual(["settings"])
  })
  it("a page left out is still reachable: it is in hidden, found by search (C4)", () => {
    const nav = shellNav(simple, { owner: true, menu: mine })
    const shown = new Set(ids(nav.main))
    expect(ids(nav.hidden)).toContain("automations")
    expect(ids(nav.hidden)).toContain("running")
    // Every catalog page is either drawn or in hidden, never lost.
    for (const p of catalog.flatMap((g) => g.items)) {
      const id = PAGE_SHELL[p.key] ?? p.key
      expect(shown.has(id) || nav.hidden.some((i) => i.id === id)).toBe(true)
    }
    for (const i of nav.hidden) expect(shown.has(i.id)).toBe(false)
  })
  it("saved: Wiki and Mobile app switched on stay under More (pm C1)", () => {
    const v = resolveHubLayout({ layout: "simple", show: { wiki: true, mobile: true, workflows: true } })
    const nav = shellNav(v, { owner: true, menu: mine })
    expect(ids(nav.more)).toEqual(["mobile", "wiki"])
    // Workflows is a catalog page: the saved menu decides it (left out = hidden).
    expect(ids(nav.hidden)).toContain("workflows")
    expect(shellNav(simple, { owner: true, menu: mine }).more).toEqual([])
  })
  it("a guest never gets the owner's links or Settings (C4)", () => {
    const nav = shellNav(simple, { owner: false, menu: mine })
    expect(nav.main.some((i) => i.external)).toBe(false)
    expect(nav.foot).toEqual([])
  })
  it("the catalog hrefs are plain hashes, not HTML", () => {
    for (const p of catalog.flatMap((g) => g.items)) {
      expect(p.href).toMatch(/^#/)
      expect(p.href).not.toContain("&amp;")
    }
  })
  it("every icon the saved menu can draw is in the kit", () => {
    const nav = shellNav(simple, { owner: true, menu: saved(presetItems("everything", catalog)) })
    for (const i of [...nav.main, ...nav.hidden].filter((x) => !x.group)) expect(ICON_NAMES).toContain(i.icon)
  })
  it("draws the saved menu: group headers, items in order, hidden pages not drawn, links in a new tab", () => {
    const html = draw({ menu: mine })
    expect(html).toContain('data-shell-menu-group="g1"')
    expect(html).not.toContain('data-shell-menu-group="g2"')
    expect(html.indexOf('data-shell-item="needs"')).toBeLessThan(html.indexOf('data-shell-item="tasks"'))
    expect(html).toContain(">My work<")
    expect(html).not.toContain('data-shell-item="automations"')
    expect(html).not.toContain('data-shell-group="pages"')
    expect(html).toMatch(/href="https:\/\/example\.com\/docs"[^>]*target="_blank"|target="_blank"[^>]*href="https:\/\/example\.com\/docs"/)
  })
})
