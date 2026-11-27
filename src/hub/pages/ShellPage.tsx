// --- The simple shell, #page=home (#2226 S3) ---
//
// Three columns, as #2226 lays them out: the side menu on the left
// (shell/SideMenu.tsx, the approved orca mock of #2101; its items from
// shell.ts, so it follows Settings › Layout), the chat with the agent in
// view in the centre, and the right column's tabs (Run artifacts, Project,
// Workspace for the chat in view, shell/FilesPanel.tsx, #2455; the issue
// leaves the other tabs for a follow-up). At 641-1180 px the menu is an
// icon rail and Files a Sheet; on a phone the chat takes the screen and
// the menu and the tabs open as Sheets from its bar. ⌘K puts the cursor
// in the menu's search, opening the menu first where it is folded away.
//
// The shell covers the old Hub's frame while it is open. Tasks (S4) opens
// in the centre, as List or Kanban (ShellTasks.tsx), with the switch at the
// foot of the side menu, as the issue places it. Automations and Waiting on
// you (S5) open in the centre too (ShellAutomations.tsx, ShellWaiting.tsx).
// Every other item is a link to today's page, which the old Hub draws.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react"
import { apiGet, apiPost } from "../api"
import { readBoot } from "../boot"
import type { HubPageProps } from "../registry"
import { navigate } from "../router"
import { SHELL_PAGE, currentLayout } from "../shell"
import { SideMenu, SideRail, type SideMenuProps } from "../shell/SideMenu"
import { Composer, sayAnswer, type ComposerSend } from "../shell/Composer"
import { FilesPanel } from "../shell/FilesPanel"
import { liveAnswer, storedAnswer, useTaskStream } from "../shell/chat-stream"
import { hubAgentsUrl, idleModel, readMenuRail, saveMenuRail, shellShortcut, type HaModel } from "../shell/menu"
import { readTasksView, saveTasksView, shellPane, type TasksView } from "../tasks"
import { WAITING_URL, waitingList, type WaitingReply } from "../waiting"
import { MENU_API, MENU_QUERY_KEY, type MenuReply } from "../settings/menu-model"
import { TasksPane } from "./ShellTasks"
import { AutomationsPane } from "./ShellAutomations"
import { WaitingPane } from "./ShellWaiting"
import { ProjectsPane } from "./ShellProjects"
import {
  AfSkeletonRows, AfStateLabel, Button, EmptyState, Icon, Sheet, SheetContent, SheetTitle,
  Tooltip, TooltipContent, TooltipTrigger, cn,
} from "../ui"

export { SideMenu, type SideMenuProps } from "../shell/SideMenu"

export interface ShellAgent { id: string; name: string; model?: string; tier?: string }

interface AgentsReply { agents?: RawAgent[] }
interface RawAgent { id?: string; name?: string; model?: string; tier?: string }

/** /api/agents answers a list or { agents }; rows without an id are dropped. */
export function shellAgents(reply: RawAgent[] | AgentsReply | null | undefined): ShellAgent[] {
  const list = Array.isArray(reply) ? reply : reply?.agents ?? []
  return list
    .filter((a) => a && (a.id || a.name))
    .map((a) => ({ id: String(a.id || a.name), name: String(a.name || a.id), ...(a.model ? { model: a.model } : {}), ...(a.tier ? { tier: a.tier } : {}) }))
}

// --- Chat ---

interface ChatMessage { seq: number; role: "user" | "assistant"; content: string; status: "pending" | "done" | "error"; taskId?: string | null }
/** `node`: the daemon that holds the thread, added by the dashboard. */
interface ChatThread { node?: string; thread?: { id: string; agentId: string; node: string | null }; messages?: ChatMessage[] }

const pending = (t?: ChatThread) => !!t?.messages?.some((m) => m.status === "pending")

// The answer renderer (Streamdown) loads on its own, the first time an answer shows.
const ChatMarkdown = lazy(() => import("../shell/ChatMarkdown"))

/** An answer, rendered as markdown; plain text until the renderer has loaded. */
export function ChatAnswer({ md, streaming }: { md: string; streaming: boolean }) {
  return (
    <Suspense fallback={<div className="whitespace-pre-wrap" data-shell="answer">{md}</div>}>
      <ChatMarkdown md={md} streaming={streaming} />
    </Suspense>
  )
}

/** A pending answer: the label, then the words so far from the run's live
 *  output, read as the old panel reads it, without any {"answer":"…"} wrapper. */
function PendingAnswer({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-2" data-shell="live">
      <AfStateLabel state="running" label="Working…" />
      {text ? <ChatAnswer md={text} streaming /> : null}
    </div>
  )
}

/** The centre: the agent in view's newest conversation and the writing box. */
export function ShellChat({ agent, phoneBar, onThread }: { agent?: ShellAgent; phoneBar?: ReactNode; onThread?: (id: string | null) => void }) {
  const client = useQueryClient()
  const [threadId, setThreadId] = useState<string | null>(null)
  const [error, setError] = useState("")

  // A new agent in view: open its newest conversation, if any.
  const latest = useQuery({
    queryKey: ["assistant-threads", agent?.id],
    queryFn: () => apiGet<{ threads?: { id: string }[] }>("/api/assistant/threads?agent=" + encodeURIComponent(agent!.id)),
    enabled: !!agent,
  })
  // A send before the list loads picks the thread itself: the list must not overwrite it.
  const sentHere = useRef(false)
  useEffect(() => { sentHere.current = false; setThreadId(null); setError("") }, [agent?.id])
  useEffect(() => { if (!sentHere.current) setThreadId(latest.data?.threads?.[0]?.id ?? null) }, [latest.data])
  // The right column's Files follows the conversation in view.
  useEffect(() => { onThread?.(threadId) }, [threadId, onThread])

  const thread = useQuery({
    queryKey: ["assistant-thread", threadId],
    queryFn: () => apiGet<ChatThread>("/api/assistant/thread?id=" + encodeURIComponent(threadId!)),
    enabled: !!threadId,
    // The answer is written to the thread when the run ends: read again until
    // it is. The words come sooner, from the run's stream below.
    refetchInterval: (q) => (pending(q.state.data as ChatThread | undefined) ? 1500 : false),
  })

  // The pending answer, live (Anis, req-01M83KYQ: show whatever it has, do
  // not wait until everything is done). The stored answer replaces it once
  // the thread read has it; the stream's end asks for that read at once.
  const waiting = [...(thread.data?.messages ?? [])].reverse().find((m) => m.status === "pending")
  const settle = useCallback(() => { void client.invalidateQueries({ queryKey: ["assistant-thread", threadId] }) }, [client, threadId])
  const raw = useTaskStream({ node: thread.data?.node, agentId: thread.data?.thread?.agentId, taskId: waiting?.taskId }, settle)
  const live = liveAnswer(raw)

  // A message sent by voice: its answer is said back in the agent's voice.
  const spoken = useRef<string | null>(null)
  const send = useMutation({
    mutationFn: (s: ComposerSend) =>
      apiPost<{ threadId: string }>("/api/assistant", {
        agentId: agent?.id, threadId: threadId ?? undefined, node: threadId ? thread.data?.node || undefined : undefined,
        message: s.message, attachments: s.attachments, model: s.model, spoken: s.spoken,
      }),
    onSuccess: (d, s) => {
      sentHere.current = true
      spoken.current = s.spoken ? d.threadId : null
      setThreadId(d.threadId)
      void client.invalidateQueries({ queryKey: ["assistant-thread", d.threadId] })
    },
    onError: (e: unknown) => setError("Not sent: " + (e instanceof Error ? e.message : "the computer did not answer")),
  })
  const onSend = (s: ComposerSend) => {
    if (!agent || send.isPending) return Promise.resolve(false)
    setError("")
    return send.mutateAsync(s).then(() => true, () => false)
  }
  useEffect(() => {
    const t = thread.data
    const last = t?.messages?.[t.messages.length - 1]
    if (!threadId || spoken.current !== threadId || !last || last.role !== "assistant" || last.status !== "done" || !last.content) return
    spoken.current = null
    sayAnswer(threadId, t?.node, storedAnswer(last.content)).catch((e: unknown) => setError("Not said aloud: " + (e instanceof Error ? e.message : "the node did not answer")))
  }, [thread.data, threadId])

  const messages = thread.data?.messages ?? []
  const machine = thread.data?.thread?.node || "This computer"
  return (
    <section aria-label="Chat" data-shell="chat" className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        {phoneBar}
        <h1 className="truncate text-sm font-medium">{agent ? agent.name : "Chat"}</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[760px] flex-col gap-4 px-4 py-6">
          {!agent ? (
            <EmptyState title="Pick an agent to chat with">Your agents are in the side menu.</EmptyState>
          ) : thread.isLoading ? (
            <AfSkeletonRows />
          ) : messages.length === 0 ? (
            <p className="pt-16 text-center text-sm text-muted-foreground">Ask {agent.name} anything. The answer shows here.</p>
          ) : messages.map((m) => (
            <div key={m.seq} data-role={m.role} className={cn("text-sm", m.role === "user" ? "self-end max-w-[85%] whitespace-pre-wrap rounded-lg bg-muted px-3 py-2" : "min-w-0")}>
              {m.status === "pending" ? <PendingAnswer text={m === waiting ? live : ""} />
                : m.status === "error" ? <span className="whitespace-pre-wrap text-err-ink">{m.content || "The run ended with an error."}</span>
                : m.role === "assistant" ? <ChatAnswer md={storedAnswer(m.content)} streaming={false} />
                : m.content}
            </div>
          ))}
        </div>
      </div>
      {/* The approved composer card (#2182), as on every other way into a chat (#2453). */}
      <Composer agent={agent} node={thread.data?.node} busy={send.isPending} onSend={onSend}>
        <p className="mt-1.5 flex items-center gap-1.5 px-1 text-xs text-muted-foreground" data-shell="machine">
          <Icon name="monitor" className="size-3.5" /> {machine}
        </p>
        {error ? <p role="alert" className="mt-1 px-1 text-xs text-err-ink">{error}</p> : null}
      </Composer>
    </section>
  )
}

// --- Right column ---

/** The right column: Run artifacts, Project and Workspace tabs for the
 *  chat in view (shell/FilesPanel.tsx, #2455). */
export function RightTabs({ threadId = null, inSheet = false }: { threadId?: string | null; inSheet?: boolean }) {
  return <FilesPanel threadId={threadId} inSheet={inSheet} />
}

// --- The shell ---

export interface SimpleShellProps extends SideMenuProps {
  /** The agents of this Hub, for the chat (/api/agents). Without `model`,
   *  the menu lists them as not working today. */
  agents?: ShellAgent[]
  /** The task opened in the Tasks pane, or the item in Waiting on you (`open=` in the hash). */
  openTask?: string | null
  /** The project picked in Tasks (`project=` in the hash). */
  project?: string | null
}

/** The centre for this pane. An agent of another machine is in the menu
 *  but not in /api/agents: the chat still opens for it. */
function Centre({ props, bar, onThread }: { props: SimpleShellProps; bar: ReactNode; onThread: (id: string | null) => void }) {
  const row = props.model?.rows.find((r) => r.id === props.agent)
  const current = props.agents?.find((a) => a.id === props.agent) ?? (row ? { id: row.id, name: row.name } : undefined)
  switch (props.pane) {
    case "tasks": return <TasksPane view={props.tasksView ?? "list"} onView={(v) => props.onTasksView?.(v)} open={props.openTask ?? null} project={props.project ?? null} phoneBar={bar} />
    case "automations": return <AutomationsPane phoneBar={bar} />
    case "waiting": return <WaitingPane open={props.openTask ?? null} phoneBar={bar} />
    case "projects": return <ProjectsPane owner={props.owner} phoneBar={bar} />
    default: return <ShellChat agent={current} phoneBar={bar} onThread={onThread} />
  }
}

/** The shell's width class (orca-design responsive §1): phone up to 640 px,
 *  the icon rail to 1180 px, the full menu beyond. Wide when there is no
 *  window (the tests' server render). */
export type ShellWidth = "phone" | "rail" | "wide"
const PHONE_Q = "(max-width: 640px)", RAIL_Q = "(max-width: 1180px)"
function widthNow(): ShellWidth {
  if (typeof window === "undefined" || !window.matchMedia) return "wide"
  return window.matchMedia(PHONE_Q).matches ? "phone" : window.matchMedia(RAIL_Q).matches ? "rail" : "wide"
}
function onWidth(cb: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {}
  const qs = [window.matchMedia(PHONE_Q), window.matchMedia(RAIL_Q)]
  qs.forEach((q) => q.addEventListener("change", cb))
  return () => qs.forEach((q) => q.removeEventListener("change", cb))
}

/** The three columns, laid out for a computer, the icon rail and a phone.
 *  `width` is for the tests; the page follows the window. */
export function SimpleShell(props: SimpleShellProps & { width?: ShellWidth }) {
  const live = useSyncExternalStore(onWidth, widthNow, () => "wide" as ShellWidth)
  const width = props.width ?? live
  // "search" is the menu Sheet opened by ⌘K, with the cursor in its search.
  const [sheet, setSheet] = useState<"menu" | "search" | "tabs" | null>(null)
  const [folded, setFolded] = useState(() => readMenuRail())
  // Each ⌘K bumps it; the open menu puts the cursor in its search box.
  const [kTick, setKTick] = useState(0)
  const fold = (v: boolean) => { setFolded(v); saveMenuRail(v); if (v) setKTick(0) }
  const openSearch = () => {
    if (width === "wide") { if (folded) fold(false) } else setSheet("search")
    setKTick((t) => t + 1)
  }
  const [threadId, setThreadId] = useState<string | null>(null)
  const chatThread = props.pane === undefined || props.pane === "chat" ? threadId : null
  const model = props.model ?? (props.agents ? idleModel(props.agents) : undefined)
  const menu = { ...props, model }
  const rail = width === "rail" || (width === "wide" && folded)
  // ⌘B / Ctrl B folds the menu on a computer and opens it as a Sheet on
  // the rail, as in the old Hub (hub-panels.ts). ⌘K / Ctrl K puts the
  // cursor in the menu's search. The old Hub under the shell sees neither.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const what = shellShortcut(e)
      if (!what) return
      e.preventDefault(); e.stopPropagation()
      if (what === "search") openSearch()
      else if (width === "wide") fold(!folded)
      else setSheet((s) => (s === "menu" || s === "search" ? null : "menu"))
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  })
  const bar = (
    <>
      {width === "phone" ? <PhoneButton label="Open the menu" icon="menu" onClick={() => setSheet("menu")} /> : null}
      {width !== "wide" ? <PhoneButton label="Files" icon="panel-right" className="order-last ml-auto" onClick={() => setSheet("tabs")} /> : null}
    </>
  )
  const cols = width === "phone" ? "minmax(0,1fr)" : (rail ? "56px" : "280px") + " minmax(0,1fr)" + (width === "wide" ? " 300px" : "")
  return (
    <div
      data-shell="simple" data-layout={props.view.layout} data-width={width}
      className="fixed inset-0 z-30 grid bg-background text-foreground"
      style={{ gridTemplateColumns: cols }}
    >
      {width === "phone" ? null : (
        <aside className="min-h-0 border-r border-border bg-background">
          {rail ? (
            <SideRail {...menu} onExpand={() => (width === "wide" ? fold(false) : setSheet("menu"))} onSearch={openSearch} />
          ) : (
            <SideMenu {...menu} focusSearch={kTick} action={<PhoneButton label="Collapse menu (⌘B)" icon="panel-left" onClick={() => fold(true)} slot />} />
          )}
        </aside>
      )}
      <main className="min-h-0">
        <Centre props={menu} bar={bar} onThread={setThreadId} />
      </main>
      {width === "wide" ? (
        <aside aria-label="Right column" className="min-h-0 border-l border-border">
          <RightTabs threadId={chatThread} />
        </aside>
      ) : null}
      <Sheet open={sheet !== null} onOpenChange={(o) => { if (!o) setSheet(null) }}>
        <SheetContent
          side={sheet === "tabs" ? "right" : "left"} closeLabel={sheet === "tabs" ? "Close Files" : "Close the menu"} aria-describedby={undefined}
          // ⌘K: the menu puts the cursor in its search. Otherwise the Sheet
          // itself takes focus, so a phone does not open its keyboard.
          onOpenAutoFocus={(e) => { e.preventDefault(); if (sheet !== "search") (e.currentTarget as HTMLElement).focus() }}
        >
          <SheetTitle className="sr-only">{sheet === "tabs" ? "Files" : "Menu"}</SheetTitle>
          {sheet === "tabs" ? <RightTabs threadId={chatThread} inSheet /> : <SideMenu {...menu} focusSearch={sheet === "search" ? kTick : 0} onDone={() => setSheet(null)} />}
        </SheetContent>
      </Sheet>
    </div>
  )
}

function PhoneButton({ label, icon, className, onClick, slot }: { label: string; icon: string; className?: string; onClick: () => void; slot?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={label.replace(/ \(⌘B\)$/, "")} data-slot={slot ? "menu-action" : undefined} className={cn("size-8", className)} onClick={onClick}>
          <Icon name={icon} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** The route: the boot's viewer, the layout now, the agents of this Hub,
 *  and what the hash puts in the centre (the chat, Tasks, Automations or
 *  Waiting on you). */
export default function ShellPage({ params }: HubPageProps) {
  const boot = useMemo(() => readBoot(), [])
  // Re-read on each draw: coming back from Settings › Layout redraws the page.
  const view = currentLayout(boot)
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => apiGet<RawAgent[] | AgentsReply>("/api/agents") })
  const list = agents.data ? shellAgents(agents.data) : agents.isError ? [] : undefined
  const [agent, setAgent] = useState<string | undefined>()
  useEffect(() => { if (!agent && list?.length) setAgent(list[0].id) }, [agent, list])
  const { pane, open, project } = shellPane(params)
  const [tasksView, setTasksView] = useState<TasksView>(() => readTasksView())
  const onTasksView = (v: TasksView) => { setTasksView(v); saveTasksView(v) }
  // Picking an agent while another pane is open goes back to the chat with it.
  const onAgent = (id: string) => { setAgent(id); if (pane !== "chat") navigate({ page: SHELL_PAGE }) }
  // The menu's rows, grouped by state, as the old Hub's menu draws them
  // (#2388); patched in place on each read, keyed by agent.
  const rows = useQuery({ queryKey: ["hub-agents"], queryFn: () => apiGet<HaModel>(hubAgentsUrl()), refetchInterval: 5_000 })
  // Waiting on you's count: the same read as its pane (ShellWaiting.tsx).
  const waiting = useQuery({ queryKey: ["shell-waiting"], queryFn: () => apiGet<WaitingReply>(WAITING_URL), refetchInterval: 15_000 })
  const needs = waiting.data ? waitingList(waiting.data).items.length : undefined
  // The Hub's menu (#2149): the owner's, so only the owner reads it (the
  // route is the owner's too). Until it is saved, or if it can't be read,
  // the side menu is the default list.
  const menu = useQuery({ queryKey: MENU_QUERY_KEY, queryFn: () => apiGet<MenuReply>(MENU_API), enabled: boot.owner })
  return (
    <SimpleShell
      view={view} owner={boot.owner} agents={list} model={rows.data} needs={needs} agent={agent} onAgent={onAgent} menu={menu.data}
      pane={pane} openTask={open} project={project} tasksView={tasksView} onTasksView={onTasksView}
    />
  )
}
