// --- The right column's Files tab, for the chat in view (#2101 R17 in the React shell) ---
//
// It opens on the chat's newest run (#2455): while it goes, the files its
// live output names (run-stream.ts), new ones as they come; once it ended,
// its record. The earlier runs' files and the workspace follow below.
//
// The same Files panel the old Hub opens beside a chat (#2315, fixes in
// #2354): what the chat's runs read, edited or wrote, the files they sent
// and the ones the owner attached, then the agent's workspace one folder at
// a time. Nothing is drawn twice: the lists and the file views are
// wall-files.ts's own (filesTabHtml, workspaceHtml, runFileHtml,
// workspaceFileHtml), styled by its WALL_FILES_CSS, which the Hub document
// already loads. This file only reads the same routes the old panel reads
// (wall-context.client.ts cxLoadSrc, cxLoadDir, cxOpenWsFile) and answers
// the clicks their markup names with data-cx.
import { useQuery } from "@tanstack/react-query"
import { useEffect, useMemo, useState, type MouseEvent } from "react"
import { apiGet } from "../api"
import {
  attachedOf, filesTabHtml, mergeRunFiles, runFileHtml, runFilesOf, workspaceFileHtml, workspaceHtml, workspaceRel,
  type RunFiles, type WorkspaceView,
} from "../../daemon/ui/pages/wall-files"
import { AfLoader, AfStateLabel, Button, EmptyState, Icon } from "../ui"
import { useRunStream } from "./run-stream"

/** GET /api/assistant/thread: the dashboard adds the node that holds it. */
export interface ChatThreadReply {
  node?: string
  thread?: { id: string; agentId: string; title?: string; node?: string | null }
  messages?: Array<{ role: string; content: string; taskId?: string | null; status?: string }>
}

interface RunRef { node: string; agent: string; task: string }

/** The chat's newest run (#2455): `live` while its answer is pending. Its
 *  task is "" until the run has started. */
export interface CurrentRun extends RunRef { live: boolean }

/** A chat as a Files source, as the old chat hands it to the panel
 *  (wall-chat.client.ts api.files): its newest run on its own (#2455), the
 *  runs before it (the last 12), the files its messages carried, and its
 *  agent's workspace. Null with no conversation. */
export interface FilesSource {
  key: string; label: string; current: CurrentRun | null; runs: RunRef[]; attached: string[]; ws: { node: string; agent: string } | null
}

export function chatFilesSource(t: ChatThreadReply | null | undefined): FilesSource | null {
  const th = t?.thread
  if (!th?.id) return null
  const node = t?.node || th.node || ""
  const msgs = t?.messages ?? []
  const answers = node ? msgs.filter((m) => m.role === "assistant" && (m.taskId || m.status === "pending")) : []
  const last = answers[answers.length - 1]
  const current: CurrentRun | null = last ? { node, agent: th.agentId, task: String(last.taskId || ""), live: last.status === "pending" } : null
  const runs = answers.slice(0, -1).filter((m) => m.taskId).map((m) => ({ node, agent: th.agentId, task: String(m.taskId) })).slice(-12)
  return {
    key: "chat:" + th.id, label: th.title || "This chat", current, runs,
    attached: attachedOf(msgs.filter((m) => m.role === "user").map((m) => m.content)),
    ws: node ? { node, agent: th.agentId } : null,
  }
}

const q = (o: Record<string, string>) => new URLSearchParams(o).toString()

/** Each run's record (GET /api/task/history), its files added up. A run
 *  still going has no record yet: its files come from its stream. */
async function readRunFiles(runs: RunRef[], attached: string[]): Promise<RunFiles> {
  let why = ""
  const recs = await Promise.all(runs.map((r) =>
    apiGet<{ transcript?: string; responseText?: string; message?: string }>("/api/task/history?" + q({ node: r.node, agent: r.agent, task: r.task }))
      .catch((e: unknown) => { why = why || (e instanceof Error ? e.message : String(e)); return null })))
  const got = recs.filter((r): r is NonNullable<typeof r> => !!r)
  if (runs.length && !got.length) throw new Error(why || "no run record")
  const all = mergeRunFiles(got.map((rec) => runFilesOf(rec.transcript || "", rec.responseText || "")))
  for (const a of [...attachedOf(got.map((rec) => rec.message || "")), ...attached]) if (!all.attached.includes(a)) all.attached.push(a)
  return all
}

/** GET /api/task/workspace: a folder's list or a text file. */
interface WsReply { kind?: "dir" | "file"; root?: string; entries?: NonNullable<WorkspaceView["list"]>["entries"]; more?: boolean; content?: string; size?: number }

const wsUrl = (ws: { node: string; agent: string }, path: string) => "/api/task/workspace?" + q({ node: ws.node, agent: ws.agent, path })
const words = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** What the panel shows: the list, a file the runs touched (from the
 *  current run's list or the earlier runs'), or a workspace file. */
type View = { kind: "list" } | { kind: "wfile"; cur: boolean; path: string } | { kind: "wsfile"; path: string }

/** The current run's list while it goes (#2455): what its stream named so
 *  far. Nothing yet says so, in place of the finished runs' empty state. */
export function currentRunHtml(r: RunFiles | null, key: string, live: boolean): string {
  if (!live) return r ? filesTabHtml(r, { key }) : ""
  if (!r || (!r.files.length && !r.artifacts.length)) {
    return `<p class="ax-wall__empty">Nothing yet. The files this run reads, writes or sends show here as it goes.</p>`
  }
  return filesTabHtml(r, { key })
}

/** The Files tab for one chat thread (null: no conversation yet). */
export function FilesPanel({ threadId }: { threadId: string | null }) {
  // The chat's own read (ShellPage.tsx ShellChat): one cache, no second
  // request. The chat reads it again while an answer is pending, so a
  // run that starts or ends shows here too.
  const thread = useQuery({
    queryKey: ["assistant-thread", threadId],
    queryFn: () => apiGet<ChatThreadReply>("/api/assistant/thread?id=" + encodeURIComponent(threadId!)),
    enabled: !!threadId,
  })
  const src = chatFilesSource(thread.data)
  const cur = src?.current ?? null
  const [dir, setDir] = useState("")
  const [view, setView] = useState<View>({ kind: "list" })
  const [reopen, setReopen] = useState(0)
  useEffect(() => { setDir(""); setView({ kind: "list" }) }, [src?.key])

  // The current run: its stream while it goes, its record once it ended.
  const liveText = useRunStream(cur?.task ? cur : null, !!cur?.live, reopen)
  const liveFiles = useMemo(() => (liveText ? runFilesOf(liveText, liveText) : null), [liveText])
  const curRec = useQuery({
    queryKey: ["run-files", cur?.node, cur?.agent, cur?.task],
    queryFn: () => readRunFiles([cur!], []),
    enabled: !!cur?.task && !cur.live,
  })
  // Until its record is read, a run that just ended keeps what it streamed.
  const curFiles = cur?.live ? liveFiles : curRec.data ?? liveFiles
  const curKey = "run:" + (cur?.task || "")

  const earlierShown = !!src && (src.runs.length > 0 || src.attached.length > 0 || !cur)
  const files = useQuery({
    queryKey: ["chat-files", src?.key, src?.runs.map((r) => r.task).join(","), src?.attached.join(",")],
    queryFn: () => readRunFiles(src!.runs, src!.attached),
    enabled: earlierShown,
  })
  const ws = useQuery({
    queryKey: ["chat-workspace", src?.ws?.node, src?.ws?.agent, dir],
    queryFn: () => apiGet<WsReply>(wsUrl(src!.ws!, dir)),
    enabled: !!src?.ws,
  })
  const wsFile = useQuery({
    queryKey: ["chat-workspace-file", src?.ws?.node, src?.ws?.agent, view.kind === "wsfile" ? view.path : ""],
    queryFn: () => apiGet<WsReply>(wsUrl(src!.ws!, view.kind === "wsfile" ? view.path : "")),
    enabled: !!src?.ws && view.kind === "wsfile",
  })

  if (!threadId || (!thread.isLoading && !src)) {
    return <EmptyState title="No files yet">The files this chat's runs read, write or send show here.</EmptyState>
  }
  if (!src) return <AfLoader>Reading the chat…</AfLoader>

  const wsView: WorkspaceView | null = src.ws ? {
    dir,
    list: ws.data && ws.data.kind !== "file" ? { root: String(ws.data.root || ""), entries: ws.data.entries ?? [], more: !!ws.data.more } : null,
    loading: ws.isFetching,
    error: ws.error ? words(ws.error) : ws.data?.kind === "file" ? "not a folder" : "",
  } : null

  const reload = () => {
    if (earlierShown) void files.refetch()
    if (cur?.task && !cur.live) void curRec.refetch()
    if (cur?.live) setReopen((n) => n + 1)
  }
  const fetching = files.isFetching || curRec.isFetching

  // The markup's own buttons (data-cx), as wall-context.client.ts answers
  // them. data-src says which list a file row is from.
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const b = (e.target as Element).closest<HTMLElement>("[data-cx]")
    if (!b) return
    const what = b.getAttribute("data-cx"), path = b.getAttribute("data-path") ?? ""
    if (what === "freload") reload()
    else if (what === "wsdir") setDir(path)
    else if (what === "wsfile" && path) setView({ kind: "wsfile", path })
    else if (what === "wfile") {
      const isCur = b.getAttribute("data-src") === curKey
      const f = (isCur ? curFiles : files.data)?.files[Number(b.getAttribute("data-i"))]
      if (f) setView({ kind: "wfile", cur: isCur, path: f.path })
    }
  }
  // wall-files.ts escapes every value it puts in its markup. Its empty
  // state brings a Reload of its own: the header's is the one shown.
  const markup = (html: string) => (
    <div className="min-w-0 text-[13px] [&_.ax-af-empty_.wcx\_\_re]:hidden" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
  )

  if (view.kind !== "list") {
    const html = view.kind === "wsfile"
      ? workspaceFileHtml({
        path: view.path, loading: wsFile.isLoading, error: wsFile.error ? words(wsFile.error) : wsFile.data && wsFile.data.kind !== "file" ? "not a file" : undefined,
        content: wsFile.data?.kind === "file" ? String(wsFile.data.content || "") : undefined, size: wsFile.data?.size,
      })
      : runFileHtml((view.cur ? curFiles : files.data)?.files.find((f) => f.path === view.path))
    const rel = view.kind === "wfile" && wsView?.list ? workspaceRel(view.path, wsView.list.root) : null
    return (
      <div data-shell="files" className="flex flex-col gap-2">
        <div className="flex min-h-8 items-center gap-2">
          <Button variant="ghost" size="xs" className="-ml-2 mr-auto" onClick={() => setView({ kind: "list" })}>
            <Icon name="arrow-left" className="size-3.5" />Files
          </Button>
          {rel ? <Button variant="outline" size="xs" onClick={() => setView({ kind: "wsfile", path: rel })}>Open it as it is now</Button> : null}
        </div>
        {markup(html)}
      </div>
    )
  }

  let earlier = ""
  if (files.data) earlier = filesTabHtml(files.data, { key: src.key })
  else if (files.error) earlier = `<p class="ax-wall__empty">Files not available: ${escapeHtml(words(files.error))}.</p>`
  let current = currentRunHtml(curFiles, curKey, !!cur?.live)
  if (cur && !cur.live && !curFiles && curRec.error) current = `<p class="ax-wall__empty">This run's files are not available: ${escapeHtml(words(curRec.error))}.</p>`

  return (
    <div data-shell="files" className="flex flex-col gap-2">
      <div className="flex min-h-8 items-center gap-2">
        <b className="min-w-0 flex-1 truncate text-[13px] font-semibold">{src.label}</b>
        <Button variant="outline" size="xs" disabled={fetching} onClick={reload}>Reload</Button>
      </div>
      {cur ? (
        <section data-files="current" aria-label="This run">
          <h4 className="wfl__h" style={{ marginTop: 0 }}>
            <Icon name="files" className="size-3.5" />This run
            {cur.live ? <span className="ml-auto normal-case tracking-normal"><AfStateLabel state="running" label="Running" /></span> : null}
          </h4>
          {cur.live && !cur.task ? <AfLoader>Starting the run…</AfLoader>
            : !current && curRec.isLoading ? <AfLoader>Reading the run…</AfLoader>
            : markup(current)}
        </section>
      ) : null}
      {earlierShown ? (
        <section data-files="earlier" aria-label={cur ? "Earlier in this chat" : "This chat"}>
          {cur ? <h4 className="wfl__h"><Icon name="history" className="size-3.5" />Earlier in this chat</h4> : null}
          {files.isLoading ? <AfLoader>Reading the runs…</AfLoader> : markup(earlier)}
        </section>
      ) : null}
      {markup(workspaceHtml(wsView, src.key))}
    </div>
  )
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
}
