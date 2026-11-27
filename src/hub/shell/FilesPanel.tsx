// --- The right column's Files tab, for the chat in view (#2101 R17 in the React shell) ---
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
import { useEffect, useState, type MouseEvent } from "react"
import { apiGet } from "../api"
import {
  attachedOf, filesTabHtml, mergeRunFiles, runFileHtml, runFilesOf, workspaceFileHtml, workspaceHtml, workspaceRel,
  type RunFiles, type WorkspaceView,
} from "../../daemon/ui/pages/wall-files"
import { AfLoader, Button, EmptyState, Icon } from "../ui"

/** GET /api/assistant/thread: the dashboard adds the node that holds it. */
export interface ChatThreadReply {
  node?: string
  thread?: { id: string; agentId: string; title?: string; node?: string | null }
  messages?: Array<{ role: string; content: string; taskId?: string | null }>
}

interface RunRef { node: string; agent: string; task: string }

/** A chat as a Files source, as the old chat hands it to the panel
 *  (wall-chat.client.ts api.files): its answers' runs (the last 12), the
 *  files its messages carried, and its agent's workspace. Null with no
 *  conversation. */
export interface FilesSource { key: string; label: string; runs: RunRef[]; attached: string[]; ws: { node: string; agent: string } | null }

export function chatFilesSource(t: ChatThreadReply | null | undefined): FilesSource | null {
  const th = t?.thread
  if (!th?.id) return null
  const node = t?.node || th.node || ""
  const msgs = t?.messages ?? []
  const runs = node
    ? msgs.filter((m) => m.role === "assistant" && m.taskId).map((m) => ({ node, agent: th.agentId, task: String(m.taskId) })).slice(-12)
    : []
  return {
    key: "chat:" + th.id, label: th.title || "This chat", runs,
    attached: attachedOf(msgs.filter((m) => m.role === "user").map((m) => m.content)),
    ws: node ? { node, agent: th.agentId } : null,
  }
}

const q = (o: Record<string, string>) => new URLSearchParams(o).toString()

/** Each run's record (GET /api/task/history), its files added up. A run
 *  still going has no record yet: it is left out until it ends. */
async function readRunFiles(src: FilesSource): Promise<RunFiles> {
  let why = ""
  const recs = await Promise.all(src.runs.map((r) =>
    apiGet<{ transcript?: string; responseText?: string; message?: string }>("/api/task/history?" + q({ node: r.node, agent: r.agent, task: r.task }))
      .catch((e: unknown) => { why = why || (e instanceof Error ? e.message : String(e)); return null })))
  const got = recs.filter((r): r is NonNullable<typeof r> => !!r)
  if (src.runs.length && !got.length) throw new Error(why || "no run record")
  const all = mergeRunFiles(got.map((rec) => runFilesOf(rec.transcript || "", rec.responseText || "")))
  for (const a of [...attachedOf(got.map((rec) => rec.message || "")), ...src.attached]) if (!all.attached.includes(a)) all.attached.push(a)
  return all
}

/** GET /api/task/workspace: a folder's list or a text file. */
interface WsReply { kind?: "dir" | "file"; root?: string; entries?: NonNullable<WorkspaceView["list"]>["entries"]; more?: boolean; content?: string; size?: number }

const wsUrl = (ws: { node: string; agent: string }, path: string) => "/api/task/workspace?" + q({ node: ws.node, agent: ws.agent, path })
const words = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** What the panel shows: the list, a file the runs touched, or a workspace file. */
type View = { kind: "list" } | { kind: "wfile"; path: string } | { kind: "wsfile"; path: string }

/** The Files tab for one chat thread (null: no conversation yet). */
export function FilesPanel({ threadId }: { threadId: string | null }) {
  // The chat's own read (ShellPage.tsx ShellChat): one cache, no second request.
  const thread = useQuery({
    queryKey: ["assistant-thread", threadId],
    queryFn: () => apiGet<ChatThreadReply>("/api/assistant/thread?id=" + encodeURIComponent(threadId!)),
    enabled: !!threadId,
  })
  const src = chatFilesSource(thread.data)
  const [dir, setDir] = useState("")
  const [view, setView] = useState<View>({ kind: "list" })
  useEffect(() => { setDir(""); setView({ kind: "list" }) }, [src?.key])

  const files = useQuery({
    queryKey: ["chat-files", src?.key, src?.runs.map((r) => r.task).join(",")],
    queryFn: () => readRunFiles(src!),
    enabled: !!src,
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

  let html: string
  if (view.kind === "wsfile") {
    html = workspaceFileHtml({
      path: view.path, loading: wsFile.isLoading, error: wsFile.error ? words(wsFile.error) : wsFile.data && wsFile.data.kind !== "file" ? "not a file" : undefined,
      content: wsFile.data?.kind === "file" ? String(wsFile.data.content || "") : undefined, size: wsFile.data?.size,
    })
  } else if (view.kind === "wfile") {
    html = runFileHtml(files.data?.files.find((f) => f.path === view.path))
  } else if (files.data) {
    html = filesTabHtml(files.data, { key: src.key }) + workspaceHtml(wsView, src.key)
  } else if (files.error) {
    html = `<p class="ax-wall__empty">Files not available: ${escapeHtml(words(files.error))}. A run still going has its record when it ends.</p>` + workspaceHtml(wsView, src.key)
  } else html = workspaceHtml(wsView, src.key)

  // The markup's own buttons (data-cx), as wall-context.client.ts answers them.
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const b = (e.target as Element).closest<HTMLElement>("[data-cx]")
    if (!b) return
    const what = b.getAttribute("data-cx"), path = b.getAttribute("data-path") ?? ""
    if (what === "freload") void files.refetch()
    else if (what === "wsdir") setDir(path)
    else if (what === "wsfile" && path) setView({ kind: "wsfile", path })
    else if (what === "wfile") {
      const f = files.data?.files[Number(b.getAttribute("data-i"))]
      if (f) setView({ kind: "wfile", path: f.path })
    }
  }
  const rel = view.kind === "wfile" && wsView?.list ? workspaceRel(view.path, wsView.list.root) : null

  return (
    <div data-shell="files" className="flex flex-col gap-2">
      <div className="flex min-h-8 items-center gap-2">
        {view.kind === "list" ? (
          <b className="min-w-0 flex-1 truncate text-[13px] font-semibold">{src.label}</b>
        ) : (
          <Button variant="ghost" size="xs" className="-ml-2 mr-auto" onClick={() => setView({ kind: "list" })}>
            <Icon name="arrow-left" className="size-3.5" />Files
          </Button>
        )}
        {view.kind === "list" ? (
          <Button variant="outline" size="xs" disabled={files.isFetching} onClick={() => void files.refetch()}>Reload</Button>
        ) : rel ? (
          <Button variant="outline" size="xs" onClick={() => setView({ kind: "wsfile", path: rel })}>Open it as it is now</Button>
        ) : null}
      </div>
      {view.kind === "list" && files.isLoading ? <AfLoader>Reading the runs…</AfLoader> : null}
      {/* wall-files.ts escapes every value it puts in its markup. Its empty
          state brings a Reload of its own: the header's is the one shown. */}
      <div className="min-w-0 text-[13px] [&_.ax-af-empty_.wcx\_\_re]:hidden" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
}
