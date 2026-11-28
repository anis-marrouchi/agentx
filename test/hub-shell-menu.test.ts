// The React shell's side menu, ⌘K search, Agents folds, phone Sheet and
// Files tab (#2101, #2321 follow-up): the approved orca design of #2388.
import { readFileSync } from "fs"
import { join } from "path"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { describe, expect, it } from "vitest"
import { resolveHubLayout } from "../src/hub/layout"
import { SideMenu, SideRail, type SideMenuProps } from "../src/hub/shell/SideMenu"
import {
  MENU_FOLDS_KEY, firstHit, menuGroups, readMenuFolds, saveMenuFolds, shellShortcut, type HaModel, type HaRow,
} from "../src/hub/shell/menu"
import { waitingCount, type WaitingReply } from "../src/hub/waiting"
import { askLine, chatFilesSource, runArtifactsHtml, splitRunFiles, treeView } from "../src/hub/shell/FilesPanel"
import { streamStep } from "../src/hub/shell/run-stream"
import { runFilesOf, workspaceHtml } from "../src/daemon/ui/pages/wall-files"
import { RightTabs, SimpleShell, type SimpleShellProps } from "../src/hub/pages/ShellPage"
import { TooltipProvider } from "../src/hub/ui"

const row = (id: string, state: HaRow["state"], extra: Partial<HaRow> = {}): HaRow => ({
  id, name: id[0].toUpperCase() + id.slice(1), node: "", nodeUrl: "", color: null, face: id.slice(0, 2).toUpperCase(), state,
  line: "", ageMs: -1, at: 0, unread: 0, taskId: "", runs: 0, today: 0, ...extra,
})
const model = (rows: HaRow[]): HaModel => ({ rows, counts: { all: rows.length, working: 0, needs: 0, failed: 0, done: 0, idle: 0 } })
const team = model([
  row("ada", "working"), row("bea", "working"), row("cyd", "working"), row("dov", "working"),
  row("eli", "needs"), row("fay", "failed"), row("gus", "done"), row("hal", "idle"),
])

function wrap(el: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(TooltipProvider, null, el)))
}
const simple = resolveHubLayout({ layout: "simple" })
const menu = (p: Partial<SideMenuProps> = {}) => wrap(createElement(SideMenu, { view: simple, owner: true, model: team, onAgent: () => {}, ...p }))

/** A store like localStorage, in memory. */
function memStore() {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }
}

describe("⌘K and ⌘B", () => {
  const key = (k: string, o: Partial<KeyboardEvent> = {}) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o })
  it("⌘K or Ctrl K opens the search, ⌘B or Ctrl B folds the menu", () => {
    expect(shellShortcut(key("k", { metaKey: true }))).toBe("search")
    expect(shellShortcut(key("K", { ctrlKey: true }))).toBe("search")
    expect(shellShortcut(key("b", { metaKey: true }))).toBe("fold")
  })
  it("a plain k, or with Shift or Alt, is typing, not a shortcut", () => {
    expect(shellShortcut(key("k"))).toBeNull()
    expect(shellShortcut(key("k", { metaKey: true, shiftKey: true }))).toBeNull()
    expect(shellShortcut(key("k", { ctrlKey: true, altKey: true }))).toBeNull()
    expect(shellShortcut(key("j", { metaKey: true }))).toBeNull()
  })
})

describe("the search box", () => {
  it("narrows the groups, opens every group with a match, counts the matches", () => {
    const g = menuGroups(team, { work: false }, "a")
    expect(g.map((x) => [x.id, x.total, x.open])).toEqual([["needs", 1, true], ["working", 2, true], ["idle", 1, true]])
    expect(g.every((x) => x.more === null)).toBe(true)
  })
  it("Enter opens the first agent drawn", () => {
    expect(firstHit(menuGroups(team, {}, "dov"), [{ href: "#page=tasks" }])).toEqual({ agent: "dov" })
    expect(firstHit(menuGroups(team, {}), [])).toEqual({ agent: "eli" })
  })
  it("no agent matches: Enter opens the first page that does", () => {
    expect(firstHit(menuGroups(team, {}, "tasks"), [{ href: "#page=tasks" }])).toEqual({ href: "#page=tasks" })
    expect(firstHit([], [])).toBeNull()
  })
  it("a folded group's rows are not what Enter opens", () => {
    expect(firstHit(menuGroups(model([row("gus", "done")]), {}), [{ href: "#x" }])).toEqual({ href: "#x" })
  })
  it("sits at the top of the menu with its shortcut", () => {
    const html = menu()
    expect(html).toMatch(/data-shell-item="search"[\s\S]*?type="search"[\s\S]*?⌘K/)
    expect(html.indexOf('data-shell-item="search"')).toBeLessThan(html.indexOf('data-shell-item="agents"'))
  })
  it("the rail's search button names ⌘K", () => {
    const html = wrap(createElement(SideRail, { view: simple, owner: true, model: team, onExpand: () => {}, onSearch: () => {} }))
    expect(html).toContain('aria-label="Search agents and pages"')
  })
})

describe("the Agents folds", () => {
  it("Needs you and Working open, Done today and Not working today folded, each with its count", () => {
    const g = menuGroups(team, {})
    expect(g.map((x) => [x.id, x.total, x.open])).toEqual([["needs", 2, true], ["working", 4, true], ["done", 1, false], ["idle", 1, false]])
  })
  it("a live group shows 3 rows, then Show all (N)", () => {
    const w = menuGroups(team, {}).find((x) => x.id === "working")!
    expect(w.rows.map((r) => r.id)).toEqual(["ada", "bea", "cyd"])
    expect(w.capped).toBe(true)
    expect(menuGroups(team, { working: true }).find((x) => x.id === "working")!.rows).toHaveLength(4)
  })
  it("a folded group keeps its header and count, not its rows", () => {
    const html = menu({ model: team })
    expect(html).toMatch(/data-shell-group="done"[\s\S]*?aria-expanded="false"[\s\S]*?Done today[\s\S]*?>1</)
    expect(html).not.toContain('data-shell-agent="gus"')
    expect(html).toContain("Show all (4)")
  })
  it("Needs you's heading and Waiting on you show the one Waiting on you number (#2101 R3)", () => {
    const asks = model(["ann", "ben", "cal", "dan", "eve", "fox", "gil"].map((id) => row(id, "needs")))
    const reply: WaitingReply = { desk: { items: ["a", "b", "c"].map((k) => ({ key: "card:" + k, kind: "card", title: k })) } }
    const needs = waitingCount(reply)
    expect(needs).toBe(3)
    const g = menuGroups(asks, {}, "", needs).find((x) => x.id === "needs")!
    expect(g.count).toBe(needs)
    // Show all (N) still counts the rows it reveals.
    expect(g.total).toBe(7)
    const html = menu({ model: asks, needs })
    const heading = html.match(/data-shell-group="needs"[\s\S]*?Needs you<\/span><span[^>]*>(\d+)</)![1]
    expect(Number(heading)).toBe(needs)
    expect(html).toContain(needs + " things wait on you")
    expect(html).toContain("Show all (7)")
    // A search counts the matches; before Waiting on you loads, the rows.
    expect(menuGroups(asks, {}, "fox", needs).find((x) => x.id === "needs")!.count).toBe(1)
    expect(menuGroups(asks, {}, "an", needs).find((x) => x.id === "needs")!.count).toBe(2)
    expect(menuGroups(asks, {}, "", waitingCount(undefined)).find((x) => x.id === "needs")!.count).toBe(7)
  })
  it("the fold state is kept in the old Hub's key, so both menus agree", () => {
    const s = memStore()
    expect(MENU_FOLDS_KEY).toBe("ax.hub.agentOpen")
    saveMenuFolds({ done: true, work: false }, s)
    expect(readMenuFolds(s)).toEqual({ done: true, work: false })
    const g = menuGroups(team, readMenuFolds(s))
    expect(g.find((x) => x.id === "done")!.open).toBe(true)
    expect(g.find((x) => x.id === "working")!.open).toBe(false)
  })
  it("a bad saved value falls back to the defaults", () => {
    const s = memStore()
    s.setItem(MENU_FOLDS_KEY, "[1]")
    expect(readMenuFolds(s)).toEqual({})
    s.setItem(MENU_FOLDS_KEY, "{oops")
    expect(readMenuFolds(s)).toEqual({})
  })
})

describe("agent faces", () => {
  it("the menu and the rail draw each agent's face, the rail with its state icon", () => {
    const m = menu({ model: model([row("ada", "working")]) })
    expect(m).toMatch(/data-slot="agent-face"[^>]*>AD</)
    const r = wrap(createElement(SideRail, { view: simple, owner: true, model: model([row("ada", "working")]), onExpand: () => {}, onSearch: () => {} }))
    expect(r).toMatch(/data-slot="agent-face"[^>]*>AD<span[\s\S]*?lucide-loader-circle/)
  })
})

describe("phone menu and right tabs open as a Sheet", () => {
  const draw = (p: Partial<SimpleShellProps> & { width?: "phone" | "rail" | "wide" }) =>
    wrap(createElement(SimpleShell, { view: simple, owner: true, agents: [{ id: "ada", name: "Ada" }], agent: "ada", ...p }))
  it("a phone: no side column, the bar opens the menu and Files", () => {
    const html = draw({ width: "phone" })
    expect(html).toContain('data-width="phone"')
    expect(html).not.toContain('data-shell="menu"')
    expect(html).toContain('aria-label="Open the menu"')
    expect(html).toContain('aria-label="Files"')
  })
  it("641-1180 px: the icon rail, Files from the bar", () => {
    const html = draw({ width: "rail" })
    expect(html).toContain('data-shell="rail"')
    expect(html).not.toContain('aria-label="Right column"')
    expect(html).toContain('aria-label="Files"')
  })
  it("the shell's sheets are the Sheet, not a Dialog pushed to the edge", () => {
    const src = readFileSync(join(__dirname, "../src/hub/pages/ShellPage.tsx"), "utf8")
    expect(src).toContain("<SheetContent")
    expect(src).not.toMatch(/DialogContent|<Dialog\b/)
    const sheet = readFileSync(join(__dirname, "../src/hub/ui/sheet.tsx"), "utf8")
    expect(sheet).toContain('data-slot="sheet-content"')
    expect(sheet).toMatch(/left: "inset-y-0 left-0 border-r"/)
    expect(sheet).toMatch(/right: "inset-y-0 right-0 border-l/)
    // Orca's Sheet timing: 300 ms in, 200 ms out, none under reduced motion.
    const css = readFileSync(join(__dirname, "../src/hub/styles.css"), "utf8")
    expect(css).toMatch(/--animate-sheet-in: ax-sheet-in 300ms/)
    expect(css).toMatch(/--animate-sheet-out: ax-sheet-out 200ms/)
    expect(sheet).toContain("motion-reduce:animate-none")
  })
})

describe("the Files tab", () => {
  it("a chat's runs, each with what was asked and attached, and the workspace", () => {
    const src = chatFilesSource({
      node: "http://node-a:4200",
      thread: { id: "t1", agentId: "ada", title: "Pricing page" },
      messages: [
        { role: "user", content: "Look at this\nAttached: brief.pdf, logo.png" },
        { role: "assistant", content: "Done", taskId: "run-1" },
        { role: "assistant", content: "Working", taskId: null },
      ],
    })
    expect(src).toEqual({
      key: "chat:t1", label: "Pricing page",
      runs: [{ node: "http://node-a:4200", agent: "ada", task: "run-1", live: false, ask: "Look at this", attached: ["brief.pdf", "logo.png"] }],
      ws: { node: "http://node-a:4200", agent: "ada" },
    })
  })
  it("the newest run is last, live while its answer is pending (#2455)", () => {
    const thread = (last: { taskId: string | null; status: string }) => chatFilesSource({
      node: "http://node-a:4200",
      thread: { id: "t1", agentId: "ada" },
      messages: [
        { role: "user", content: "First" },
        { role: "assistant", content: "One", taskId: "run-1", status: "done" },
        { role: "assistant", content: "Two", taskId: "run-2", status: "done" },
        { role: "user", content: "Make the report" },
        { role: "assistant", content: "", ...last },
      ],
    })!
    const going = thread({ taskId: "run-3", status: "pending" })
    expect(going.runs.map((r) => r.task)).toEqual(["run-1", "run-2", "run-3"])
    expect(going.runs[2]).toMatchObject({ task: "run-3", live: true, ask: "Make the report" })
    // Asked, not started yet: the newest run has no task.
    expect(thread({ taskId: null, status: "pending" }).runs[2]).toMatchObject({ task: "", live: true })
  })
  it("what was asked, in one short line", () => {
    expect(askLine("\nAttached: a.pdf\n  Fix the header  \nmore")).toBe("Fix the header")
    expect(askLine("x".repeat(100))).toHaveLength(80)
  })
  it("Run artifacts lists what the run made; its reads are kept apart", () => {
    expect(runArtifactsHtml(null, "run:r", true)).toContain("show here as it works")
    expect(runArtifactsHtml(null, "run:r", false)).toContain("This run made no files.")
    const out = '→ Read({"file_path":"/w/brief.md"})\n→ Write({"file_path":"/w/out/report.pdf","content":"x"})\n'
    const { made, read } = splitRunFiles(runFilesOf(out, out))
    expect(read.files.map((f) => f.path)).toEqual(["/w/brief.md"])
    const html = runArtifactsHtml(made, "run:r", true)
    expect(html).toContain("report.pdf")
    expect(html).not.toContain("brief.md")
    expect(html).toContain('data-src="run:r"')
    expect(html).toContain("1 changed")
    expect(html).not.toContain("· 1 read")
    // Only reads: nothing made yet.
    const onlyRead = splitRunFiles(runFilesOf('→ Read({"file_path":"/w/a.md"})\n', "")).made
    expect(runArtifactsHtml(onlyRead, "run:r", false)).toContain("This run made no files.")
  })
  it("Project and Workspace never list dot files or dot folders (#2455)", () => {
    const v = treeView("src", { isFetching: false, error: null, data: { kind: "dir", root: "/r", entries: [
      { name: ".github", kind: "dir", size: 0 }, { name: ".eslintrc", kind: "file", size: 3 }, { name: "lib", kind: "dir", size: 0 }, { name: "a.ts", kind: "file", size: 9 },
    ] } })
    expect(v.list?.entries.map((e) => e.name)).toEqual(["lib", "a.ts"])
    expect(treeView("", { isFetching: false, error: null, data: { kind: "file" } }).error).toBe("not a folder")
    const html = workspaceHtml(v, "chat:t1", { title: "", top: "agentx", dirCx: "pjdir", fileCx: "pjfile" })
    expect(html).toContain('data-cx="pjdir"')
    expect(html).toContain('data-cx="pjfile"')
    expect(html).toContain(">agentx</button>")
    expect(html).not.toContain("wfl__h")
  })
  it("the run's stream: start brings the output so far, chunks add to it, end closes it", () => {
    let t = streamStep("", "start", JSON.stringify({ initial: "→ Read({})\n" }))!
    t = streamStep(t, "chunk", JSON.stringify({ text: "more\n" }))!
    expect(t).toBe("→ Read({})\nmore\n")
    expect(streamStep(t, "chunk", JSON.stringify({ text: "\n[task finished]\n" }))).toBe(t)
    expect(streamStep(t, "chunk", "not json")).toBe(t)
    expect(streamStep(t, "end", "")).toBeNull()
    expect(streamStep("", "start", JSON.stringify({ done: true }))).toBeNull()
  })
  it("no conversation: no source", () => {
    expect(chatFilesSource(null)).toBeNull()
    expect(chatFilesSource({ messages: [] })).toBeNull()
  })
  it("Files with no thread is an empty state, not a placeholder link (the rail's and phone's Sheet)", () => {
    const html = wrap(createElement(RightTabs, { threadId: null, inSheet: true }))
    expect(html).toContain("No files yet")
    expect(html).not.toContain("Open Projects")
  })
  it("a computer shows no right column until the chat in view has a thread (E3)", () => {
    const html = wrap(createElement(SimpleShell, { view: simple, owner: true, agents: [], width: "wide" }))
    expect(html).not.toContain('aria-label="Right column"')
    expect(html).not.toContain("No files yet")
  })
})
