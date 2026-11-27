// --- The right column, for the chat in view (#2101 R17, tabs #2455) ---
//
// Three tabs, in this order (Anis, #2455):
//   1. Run artifacts, always there: what the current run makes (writes,
//      edits, sends) while it goes, from its live output (run-stream.ts),
//      then from its record. Picking another run of the chat shows its own.
//      The files a run only read are one click away, not in the list.
//   2. Project: the Git repo the agent works in (GET /api/task/project,
//      project-files-api.ts on the node). Hidden when there is none.
//   3. Workspace: the agent's workspace, one folder at a time.
// Dot files and dot folders never show in Project or Workspace.
//
// Nothing is drawn twice: the lists and the file views are wall-files.ts's
// own (filesTabHtml, workspaceHtml, runFileHtml, workspaceFileHtml), styled
// by its WALL_FILES_CSS, which the Hub document already loads. This file
// reads the routes and answers the clicks their markup names with data-cx.
import { useQuery } from "@tanstack/react-query"
import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react"
import { apiGet } from "../api"
import {
  attachedOf, filesTabHtml, runFileHtml, runFilesOf, workspaceFileHtml, workspaceHtml, workspaceRel,
  type RunFiles, type WorkspaceView,
} from "../../daemon/ui/pages/wall-files"
import { AfLoader, AfStateLabel, Button, EmptyState, Icon, Tabs, TabsContent, TabsList, TabsTrigger, cn } from "../ui"
import { useRunStream } from "./run-stream"

/** GET /api/assistant/thread: the dashboard adds the node that holds it. */
export interface ChatThreadReply {
  node?: string
  thread?: { id: string; agentId: string; title?: string; node?: string | null }
  messages?: Array<{ role: string; content: string; taskId?: string | null; status?: string }>
}

/** One run of the chat: its task ("" until it has started), whether its
 *  answer is still pending, what was asked and what was attached to it. */
export interface ChatRun { node: string; agent: string; task: string; live: boolean; ask: string; attached: string[] }

/** A chat as a Files source: its runs, newest last (the last 12), and its
 *  agent's workspace. Null with no conversation. */
export interface FilesSource {
  key: string; label: string; runs: ChatRun[]; ws: { node: string; agent: string } | null
}

/** What was asked, in one short line: the message without its Attached line. */
export function askLine(text: string): string {
  const line = String(text || "").split("\n").map((l) => l.trim()).find((l) => l && !/^Attached:/i.test(l)) || ""
  return line.length > 80 ? line.slice(0, 79) + "…" : line
}

export function chatFilesSource(t: ChatThreadReply | null | undefined): FilesSource | null {
  const th = t?.thread
  if (!th?.id) return null
  const node = t?.node || th.node || ""
  const runs: ChatRun[] = []
  let asked = ""
  for (const m of t?.messages ?? []) {
    if (m.role === "user") { asked = m.content; continue }
    if (!node || m.role !== "assistant" || !(m.taskId || m.status === "pending")) continue
    runs.push({ node, agent: th.agentId, task: String(m.taskId || ""), live: m.status === "pending", ask: askLine(asked), attached: attachedOf([asked]) })
    asked = ""
  }
  return { key: "chat:" + th.id, label: th.title || "This chat", runs: runs.slice(-12), ws: node ? { node, agent: th.agentId } : null }
}

const q = (o: Record<string, string>) => new URLSearchParams(o).toString()
const words = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** A finished run's files, from its record (GET /api/task/history). */
async function readRunFiles(r: ChatRun): Promise<RunFiles> {
  const rec = await apiGet<{ transcript?: string; responseText?: string; message?: string }>("/api/task/history?" + q({ node: r.node, agent: r.agent, task: r.task }))
  const files = runFilesOf(rec.transcript || "", rec.responseText || "")
  for (const a of [...attachedOf([rec.message || ""]), ...r.attached]) if (!files.attached.includes(a)) files.attached.push(a)
  return files
}

/** A run's files split: what it made (changed, sent, attached) and what it only read. */
export function splitRunFiles(r: RunFiles): { made: RunFiles; read: RunFiles } {
  return {
    made: { files: r.files.filter((f) => f.op !== "read"), artifacts: r.artifacts, attached: r.attached },
    read: { files: r.files.filter((f) => f.op === "read"), artifacts: [], attached: [] },
  }
}

/** The Run artifacts list: what the run made, or why there is nothing. */
export function runArtifactsHtml(made: RunFiles | null, key: string, live: boolean): string {
  if (!made || (!made.files.length && !made.artifacts.length && !made.attached.length)) {
    return live
      ? `<p class="ax-wall__empty">Nothing yet. The files this run writes, edits or sends show here as it works.</p>`
      : `<p class="ax-wall__empty">This run made no files.</p>`
  }
  return filesTabHtml(made, { key, noRead: true })
}

/** GET /api/task/workspace and /api/task/project: a folder's list or a text file. */
interface TreeReply { kind?: "dir" | "file" | "none"; root?: string; name?: string; entries?: NonNullable<WorkspaceView["list"]>["entries"]; more?: boolean; content?: string; size?: number }

/** A folder's list as the markup wants it, dot names left out (#2455). */
export function treeView(dir: string, r: { data?: TreeReply; isFetching: boolean; error: unknown }): WorkspaceView {
  const d = r.data
  return {
    dir,
    list: d && d.kind === "dir" ? { root: String(d.root || ""), entries: (d.entries ?? []).filter((e) => !e.name.startsWith(".")), more: !!d.more } : null,
    loading: r.isFetching,
    error: r.error ? words(r.error) : d && d.kind === "file" ? "not a folder" : "",
  }
}

type Tab = "run" | "project" | "workspace"
/** What a tab shows: its list, or one file opened from it. */
type Open = { kind: "list" } | { kind: "run"; list: "made" | "read"; path: string } | { kind: "tree"; tab: "project" | "workspace"; path: string }

/** The right column's tabs for one chat thread (null: no conversation yet). */
export function FilesPanel({ threadId }: { threadId: string | null }) {
  // The chat's own read (ShellPage.tsx ShellChat): one cache, no second
  // request. The chat reads it again while an answer is pending, so a run
  // that starts or ends shows here too.
  const thread = useQuery({
    queryKey: ["assistant-thread", threadId],
    queryFn: () => apiGet<ChatThreadReply>("/api/assistant/thread?id=" + encodeURIComponent(threadId!)),
    enabled: !!threadId,
  })
  const src = chatFilesSource(thread.data)
  const runs = src?.runs ?? []
  const current = runs[runs.length - 1] ?? null

  const [tab, setTab] = useState<Tab>("run")
  const [picked, setPicked] = useState<string | null>(null)
  const [open, setOpen] = useState<Open>({ kind: "list" })
  const [showRead, setShowRead] = useState(false)
  const [dirs, setDirs] = useState({ project: "", workspace: "" })
  const [reopen, setReopen] = useState(0)
  useEffect(() => { setPicked(null); setOpen({ kind: "list" }); setDirs({ project: "", workspace: "" }) }, [src?.key])
  useEffect(() => { setOpen({ kind: "list" }); setShowRead(false) }, [picked])

  // The run in view: the one picked, else the newest.
  const run = (picked ? runs.find((r) => r.task === picked) : null) ?? current
  const isCurrent = !!run && run === current
  const liveText = useRunStream(current?.task ? current : null, !!current?.live, reopen)
  const liveFiles = useMemo(() => (liveText ? runFilesOf(liveText, liveText) : null), [liveText])
  const rec = useQuery({
    queryKey: ["run-files", run?.node, run?.agent, run?.task],
    queryFn: () => readRunFiles(run!),
    enabled: !!run?.task && !run.live,
  })
  // Until its record is read, a run that just ended keeps what it streamed.
  const runFiles = run?.live ? liveFiles : rec.data ?? (isCurrent ? liveFiles : null)
  const split = useMemo(() => (runFiles ? splitRunFiles(runFiles) : null), [runFiles])
  const runKey = "run:" + (run?.task || "")

  // The project follows the run in view: its repo, or the agent's.
  const project = useQuery({
    queryKey: ["chat-project", src?.ws?.node, src?.ws?.agent, run?.task ?? "", dirs.project],
    queryFn: () => apiGet<TreeReply>("/api/task/project?" + q({ node: src!.ws!.node, agent: src!.ws!.agent, task: run?.task ?? "", path: dirs.project })),
    enabled: !!src?.ws,
  })
  const hasProject = !!project.data && project.data.kind !== "none"
  const projectName = project.data?.name || "project"
  useEffect(() => { if (tab === "project" && project.data?.kind === "none") setTab("run") }, [tab, project.data?.kind])
  const ws = useQuery({
    queryKey: ["chat-workspace", src?.ws?.node, src?.ws?.agent, dirs.workspace],
    queryFn: () => apiGet<TreeReply>("/api/task/workspace?" + q({ node: src!.ws!.node, agent: src!.ws!.agent, path: dirs.workspace })),
    enabled: !!src?.ws,
  })
  const treeFile = useQuery({
    queryKey: ["chat-tree-file", open.kind === "tree" ? open.tab : "", src?.ws?.node, src?.ws?.agent, run?.task ?? "", open.kind === "tree" ? open.path : ""],
    queryFn: () => {
      const o = open as Extract<Open, { kind: "tree" }>
      return o.tab === "project"
        ? apiGet<TreeReply>("/api/task/project?" + q({ node: src!.ws!.node, agent: src!.ws!.agent, task: run?.task ?? "", path: o.path }))
        : apiGet<TreeReply>("/api/task/workspace?" + q({ node: src!.ws!.node, agent: src!.ws!.agent, path: o.path }))
    },
    enabled: !!src?.ws && open.kind === "tree",
  })

  if (!threadId || (!thread.isLoading && !src)) {
    // Run artifacts is always there (#2455), even before a conversation.
    return (
      <Tabs value="run" className="flex h-full min-h-0 flex-col px-3 py-2" data-shell="tabs">
        <TabsList aria-label="Files" className="self-start">
          <TabsTrigger value="run"><Icon name="files" className="mr-1.5" />Run artifacts</TabsTrigger>
        </TabsList>
        <TabsContent value="run" className="min-h-0 flex-1 overflow-y-auto">
          <EmptyState title="No files yet">What this chat's runs write or send shows here.</EmptyState>
        </TabsContent>
      </Tabs>
    )
  }
  if (!src) return <div className="px-3 py-2" data-shell="tabs"><AfLoader>Reading the chat…</AfLoader></div>

  const reload = () => {
    if (run?.task && !run.live) void rec.refetch()
    if (current?.live) setReopen((n) => n + 1)
    void project.refetch()
    void ws.refetch()
  }

  // The markup's own buttons (data-cx).
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const b = (e.target as Element).closest<HTMLElement>("[data-cx]")
    if (!b) return
    const what = b.getAttribute("data-cx"), path = b.getAttribute("data-path") ?? ""
    if (what === "freload") reload()
    else if (what === "wsdir") setDirs((d) => ({ ...d, workspace: path }))
    else if (what === "pjdir") setDirs((d) => ({ ...d, project: path }))
    else if (what === "wsfile" && path) setOpen({ kind: "tree", tab: "workspace", path })
    else if (what === "pjfile" && path) setOpen({ kind: "tree", tab: "project", path })
    else if (what === "wfile" && split) {
      const list = b.getAttribute("data-src") === "read:" + (run?.task || "") ? "read" : "made"
      const f = split[list].files[Number(b.getAttribute("data-i"))]
      if (f) setOpen({ kind: "run", list, path: f.path })
    }
  }
  // wall-files.ts escapes every value it puts in its markup. Its empty
  // state brings a Reload of its own: the header's is the one shown.
  const markup = (html: string) => (
    <div className="min-w-0 text-[13px] [&_.ax-af-empty_.wcx\_\_re]:hidden" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
  )

  // One file opened from a list: a Back to the list, then the file.
  if (open.kind !== "list") {
    const wsRoot = ws.data?.kind === "dir" ? String(ws.data.root || "") : ""
    const html = open.kind === "tree"
      ? workspaceFileHtml({
        path: open.path, loading: treeFile.isLoading, error: treeFile.error ? words(treeFile.error) : treeFile.data && treeFile.data.kind !== "file" ? "not a file" : undefined,
        content: treeFile.data?.kind === "file" ? String(treeFile.data.content || "") : undefined, size: treeFile.data?.size,
      }, open.tab === "project" ? projectName : "the workspace")
      : runFileHtml(split?.[open.list].files.find((f) => f.path === open.path))
    const rel = open.kind === "run" && wsRoot ? workspaceRel(open.path, wsRoot) : null
    return (
      <div data-shell="files" className="flex flex-col gap-2 px-3 py-2">
        <div className="flex min-h-8 items-center gap-2">
          <Button variant="ghost" size="xs" className="-ml-2 mr-auto" onClick={() => setOpen({ kind: "list" })}>
            <Icon name="arrow-left" className="size-3.5" />{open.kind === "tree" ? (open.tab === "project" ? "Project" : "Workspace") : "Run artifacts"}
          </Button>
          {rel ? <Button variant="outline" size="xs" onClick={() => setOpen({ kind: "tree", tab: "workspace", path: rel })}>Open it as it is now</Button> : null}
        </div>
        {markup(html)}
      </div>
    )
  }

  // --- Run artifacts ---
  let runBody: ReactNode
  if (!run) runBody = <p className="ax-wall__empty text-[13px]">No run yet. Ask the agent something; what its run makes shows here.</p>
  else if (run.live && !run.task) runBody = <AfLoader>Starting the run…</AfLoader>
  else if (!runFiles && rec.isLoading) runBody = <AfLoader>Reading the run…</AfLoader>
  else if (!runFiles && rec.error) runBody = markup(`<p class="ax-wall__empty">This run's files are not available: ${escapeHtml(words(rec.error))}.</p>`)
  else {
    const read = split?.read.files.length ?? 0
    runBody = (
      <>
        {markup(runArtifactsHtml(split?.made ?? null, runKey, run.live))}
        {read ? (
          <Button variant="ghost" size="xs" className="-ml-2 self-start text-muted-foreground" aria-expanded={showRead} onClick={() => setShowRead((s) => !s)}>
            <Icon name={showRead ? "chevron-down" : "chevron-right"} className="size-3.5" />Files it only read ({read})
          </Button>
        ) : null}
        {read && showRead ? markup(filesTabHtml(split!.read, { key: "read:" + run.task })) : null}
      </>
    )
  }
  const others = runs.filter((r) => r !== run && r.task).reverse()

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="flex h-full min-h-0 flex-col px-3 py-2" data-shell="tabs">
      <div className="flex items-center gap-2">
        <TabsList aria-label="Files" className="self-start">
          <TabsTrigger value="run"><Icon name="files" className="mr-1.5" />Run artifacts</TabsTrigger>
          {hasProject ? <TabsTrigger value="project"><Icon name="folder-git-2" className="mr-1.5" />Project</TabsTrigger> : null}
          <TabsTrigger value="workspace"><Icon name="folder" className="mr-1.5" />Workspace</TabsTrigger>
        </TabsList>
        <Button variant="ghost" size="icon-xs" className="ml-auto" aria-label="Reload" title="Reload" onClick={reload}>
          <Icon name="refresh-cw" className="size-3.5" />
        </Button>
      </div>

      <TabsContent value="run" className="min-h-0 flex-1 overflow-y-auto" data-shell="files">
        <section data-files="run" aria-label="Run artifacts" className="flex flex-col gap-2">
          {run ? (
            <div className="flex min-h-8 items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium" title={run.ask}>{run.ask || (isCurrent ? "This run" : "An earlier run")}</span>
              {run.live ? <AfStateLabel state="running" label="Running" /> : null}
              {!isCurrent ? (
                <Button variant="outline" size="xs" onClick={() => setPicked(null)}>Current run</Button>
              ) : null}
            </div>
          ) : null}
          {runBody}
        </section>
        {others.length ? (
          <section data-files="runs" aria-label="Other runs in this chat" className="mt-4">
            <h4 className="wfl__h"><Icon name="history" className="size-3.5" />Other runs in this chat</h4>
            <ul className="flex flex-col">
              {others.map((r) => (
                <li key={r.task}>
                  <button
                    type="button" data-run={r.task} onClick={() => setPicked(r === current ? null : r.task)}
                    className={cn("flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-muted", "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")}
                  >
                    <span className="min-w-0 flex-1 truncate">{r.ask || "A run"}</span>
                    {r === current ? <span className="text-xs text-muted-foreground">current</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </TabsContent>

      {hasProject ? (
        <TabsContent value="project" className="min-h-0 flex-1 overflow-y-auto" data-shell="files">
          {markup(workspaceHtml(treeView(dirs.project, project), src.key, { title: "", top: projectName, dirCx: "pjdir", fileCx: "pjfile" }))}
        </TabsContent>
      ) : null}

      <TabsContent value="workspace" className="min-h-0 flex-1 overflow-y-auto" data-shell="files">
        {src.ws ? markup(workspaceHtml(treeView(dirs.workspace, ws), src.key, { title: "" })) : <p className="ax-wall__empty text-[13px]">No workspace for this chat.</p>}
      </TabsContent>
    </Tabs>
  )
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
}
