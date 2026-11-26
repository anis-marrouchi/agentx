// The React Hub's simple shell (#2226 S3): what its side menu lists for each
// layout and switch, where /hub opens, and the three columns it draws.
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { describe, expect, it } from "vitest"
import { resolveHubLayout, HUB_SHOW_IDS } from "../src/hub/layout"
import { SHELL_MAIN, SHELL_MORE, SHELL_PAGE, currentLayout, shellLandingHash, shellNav } from "../src/hub/shell"
import { HUB_REACT_PAGES, hubReactPageIds } from "../src/hub/pages"
import { SimpleShell, shellAgents, type SimpleShellProps } from "../src/hub/pages/ShellPage"
import { TooltipProvider } from "../src/hub/ui"
import { ICON_NAMES } from "../src/hub/ui/icons"

const ids = (items: { id: string }[]) => items.map((i) => i.id)
const simple = resolveHubLayout()
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
    const v = resolveHubLayout({ show: { workflows: true } })
    expect(ids(shellNav(v, { owner: true }).more)).toEqual(["workflows"])
  })
  it("one switch off in full hides that item only", () => {
    const v = resolveHubLayout({ layout: "full", show: { org: false, wiki: false } })
    expect(ids(shellNav(v, { owner: true }).more)).toEqual(["mobile", "workflows", "activity", "sessions", "usage"])
  })
  it("rules, gates and hosts are not menu items", () => {
    const v = resolveHubLayout({ show: { rules: true, gates: true, hosts: true } })
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
    const saved = resolveHubLayout({ show: { workflows: true } })
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
  it("side menu, chat and the right tabs, Files first", () => {
    const html = draw()
    expect(html).toContain('data-shell="simple"')
    expect(html).toContain('data-shell="menu"')
    expect(html).toContain('data-shell="chat"')
    expect(html).toContain('data-shell="tabs"')
    expect(html).toMatch(/role="tab"[^>]*>[\s\S]*?Files<\/button>/)
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
    const html = draw({ view: resolveHubLayout({ show: { workflows: true } }) })
    expect(html).toContain('data-shell-item="workflows"')
    expect(html).toContain('href="#page=workflows"')
    expect(html).not.toContain('data-shell-item="mobile"')
  })
  it("lists the agents and chats with the one in view", () => {
    const html = draw()
    expect(html).toContain('data-shell-agent="ada"')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain("Message Ada")
    expect(html).toContain("model-x")
    expect(html).toContain('data-shell="machine"')
  })
  it("no agent: says to pick one, the box is off", () => {
    const html = draw({ agents: [], agent: undefined })
    expect(html).toContain("No agents on this computer.")
    expect(html).toContain("Pick an agent to chat with")
    expect(html).toMatch(/<textarea[^>]*disabled/)
  })
})
