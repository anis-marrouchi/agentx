// --- The simple shell, #page=home (#2226 S3) ---
//
// Three columns, as #2226 lays them out: the side menu on the left (its
// items from shell.ts, so it follows Settings › Layout), the chat with the
// agent in view in the centre, and the right column's tabs (Files first;
// the issue leaves the other tabs for a follow-up). On a phone the chat
// takes the screen and the menu and the tabs open as sheets from its bar.
//
// The shell covers the old Hub's frame while it is open; every menu item is
// a link to today's page, which the old Hub draws as before.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react"
import { apiGet, apiPost } from "../api"
import { readBoot } from "../boot"
import type { HubLayoutView } from "../layout"
import type { HubPageProps } from "../registry"
import { currentLayout, shellNav, type ShellNavItem } from "../shell"
import {
  Button, Dialog, DialogContent, DialogTitle, EmptyState, Icon, Kbd, Skeleton,
  Tabs, TabsContent, TabsList, TabsTrigger, Tooltip, TooltipContent, TooltipTrigger, cn,
} from "../ui"

export interface ShellAgent { id: string; name: string; model?: string }

interface AgentsReply { agents?: RawAgent[] }
interface RawAgent { id?: string; name?: string; model?: string }

/** /api/agents answers a list or { agents }; rows without an id are dropped. */
export function shellAgents(reply: RawAgent[] | AgentsReply | null | undefined): ShellAgent[] {
  const list = Array.isArray(reply) ? reply : reply?.agents ?? []
  return list
    .filter((a) => a && (a.id || a.name))
    .map((a) => ({ id: String(a.id || a.name), name: String(a.name || a.id), ...(a.model ? { model: a.model } : {}) }))
}

// --- Side menu ---

function MenuLink({ item, onOpen }: { item: ShellNavItem; onOpen?: () => void }) {
  return (
    <a
      href={item.href}
      data-shell-item={item.id}
      onClick={onOpen}
      className="flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon name={item.icon} />
      <span className="truncate">{item.label}</span>
    </a>
  )
}

function GroupLabel({ children }: { children: ReactNode }) {
  return <p className="px-2 pt-4 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{children}</p>
}

export interface SideMenuProps {
  view: HubLayoutView
  owner: boolean
  agents?: ShellAgent[]
  agent?: string
  onAgent?: (id: string) => void
  /** Called after a pick, so the phone sheet closes. */
  onDone?: () => void
}

/** The left column: search, the default items, the agents, the items
 *  switched on in Settings › Layout, and Settings. */
export function SideMenu({ view, owner, agents, agent, onAgent, onDone }: SideMenuProps) {
  const [q, setQ] = useState("")
  const nav = useMemo(() => shellNav(view, { owner }), [view, owner])
  const needle = q.trim().toLowerCase()
  const hit = (label: string) => !needle || label.toLowerCase().includes(needle)
  // Search is the box above; Agents stays as the heading of the agent list.
  const main = nav.main.filter((i) => i.id !== "search" && (i.id === "agents" || hit(i.label)))
  const shownAgents = (agents ?? []).filter((a) => hit(a.name) || hit(a.id))
  const more = nav.more.filter((i) => hit(i.label))
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") { setQ(""); return }
    if (e.key !== "Enter") return
    const first = shownAgents[0]
    if (first && onAgent) { onAgent(first.id); onDone?.(); return }
    const link = [...main.filter((i) => i.id !== "agents"), ...more][0]
    if (link?.href) { location.href = link.href; onDone?.() }
  }
  return (
    <nav aria-label="Side menu" data-shell="menu" className="flex h-full min-h-0 flex-col gap-0.5 px-2 py-3">
      <a href="/hub" className="mb-2 px-2 text-sm font-semibold tracking-tight">AgentX</a>
      <label className="flex h-8 items-center gap-2 rounded-md border border-border bg-background px-2 text-[13px] text-muted-foreground focus-within:ring-2 focus-within:ring-ring" data-shell-item="search">
        <Icon name="search" />
        <input
          type="search" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onSearchKey}
          placeholder="Search" aria-label="Search the menu and the agents"
          className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
        />
        <Kbd className="hidden md:inline-flex">⌘K</Kbd>
      </label>
      <div className="mt-2 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
        {main.map((item) => item.id === "agents" ? (
          <section key="agents" aria-label="Agents" data-shell-item="agents">
            <GroupLabel><a href={item.href} className="hover:text-foreground">Agents</a></GroupLabel>
            {agents === undefined ? <Skeleton className="mx-2 h-6" /> : shownAgents.length === 0 ? (
              <p className="px-2 py-1 text-xs text-muted-foreground">{needle ? "No agent matches." : "No agents on this computer."}</p>
            ) : shownAgents.map((a) => (
              <button
                key={a.id} type="button" data-shell-agent={a.id} aria-pressed={a.id === agent}
                onClick={() => { onAgent?.(a.id); onDone?.() }}
                className={cn(
                  "flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer",
                  a.id === agent ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <Icon name="bot" />
                <span className="truncate">{a.name}</span>
              </button>
            ))}
          </section>
        ) : <MenuLink key={item.id} item={item} onOpen={onDone} />)}
        {more.length ? (
          <section aria-label="More" data-shell-group="more">
            <GroupLabel>More</GroupLabel>
            {more.map((item) => <MenuLink key={item.id} item={item} onOpen={onDone} />)}
          </section>
        ) : null}
      </div>
      {nav.foot.length ? (
        <div className="border-t border-border pt-2">
          {nav.foot.map((item) => <MenuLink key={item.id} item={item} onOpen={onDone} />)}
        </div>
      ) : null}
    </nav>
  )
}

// --- Chat ---

interface ChatMessage { seq: number; role: "user" | "assistant"; content: string; status: "pending" | "done" | "error" }
interface ChatThread { thread?: { id: string; agentId: string; node: string | null }; messages?: ChatMessage[] }

const pending = (t?: ChatThread) => !!t?.messages?.some((m) => m.status === "pending")

/** The centre: the agent in view's newest conversation and the writing box. */
export function ShellChat({ agent, phoneBar }: { agent?: ShellAgent; phoneBar?: ReactNode }) {
  const client = useQueryClient()
  const [threadId, setThreadId] = useState<string | null>(null)
  const [text, setText] = useState("")
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

  const thread = useQuery({
    queryKey: ["assistant-thread", threadId],
    queryFn: () => apiGet<ChatThread>("/api/assistant/thread?id=" + encodeURIComponent(threadId!)),
    enabled: !!threadId,
    // The answer is written to the thread when the run ends: read again until it is.
    refetchInterval: (q) => (pending(q.state.data as ChatThread | undefined) ? 1500 : false),
  })

  const send = useMutation({
    mutationFn: (message: string) =>
      apiPost<{ threadId: string }>("/api/assistant", { agentId: agent?.id, threadId: threadId ?? undefined, message }),
    onSuccess: (d) => {
      setText("")
      sentHere.current = true
      setThreadId(d.threadId)
      void client.invalidateQueries({ queryKey: ["assistant-thread", d.threadId] })
    },
    onError: (e: unknown) => setError("Not sent: " + (e instanceof Error ? e.message : "the computer did not answer")),
  })

  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    const message = text.trim()
    if (!message || !agent || send.isPending) return
    setError("")
    send.mutate(message)
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) submit()
  }

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
            <Skeleton className="h-16 w-full" />
          ) : messages.length === 0 ? (
            <p className="pt-16 text-center text-sm text-muted-foreground">Ask {agent.name} anything. The answer shows here.</p>
          ) : messages.map((m) => (
            <div key={m.seq} data-role={m.role} className={cn("text-sm whitespace-pre-wrap", m.role === "user" ? "self-end max-w-[85%] rounded-lg bg-muted px-3 py-2" : "")}>
              {m.status === "pending" ? <span className="text-muted-foreground">Working…</span>
                : m.status === "error" ? <span className="text-err-ink">{m.content || "The run ended with an error."}</span>
                : m.content}
            </div>
          ))}
        </div>
      </div>
      <form onSubmit={submit} className="mx-auto w-full max-w-[760px] shrink-0 px-4 pb-4">
        <div className="rounded-lg border border-border bg-background focus-within:ring-2 focus-within:ring-ring">
          <textarea
            rows={2} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey}
            disabled={!agent} aria-label={agent ? `Message ${agent.name}` : "Message"}
            placeholder={agent ? `Message ${agent.name}` : "Pick an agent first"}
            className="block w-full resize-none bg-transparent px-3 pt-2.5 text-sm outline-none placeholder:text-muted-foreground"
          />
          <div className="flex items-center justify-end gap-2 px-2 pb-2">
            {agent?.model ? <span className="mr-auto rounded-sm border border-border px-1.5 font-mono text-[11px] text-muted-foreground" title="The agent's model">{agent.model}</span> : null}
            <Button type="submit" size="sm" disabled={!agent || !text.trim() || send.isPending} aria-label="Send">
              <Icon name="send" /> Send
            </Button>
          </div>
        </div>
        <p className="mt-1.5 flex items-center gap-1.5 px-1 text-xs text-muted-foreground" data-shell="machine">
          <Icon name="monitor" className="size-3.5" /> {machine}
        </p>
        {error ? <p role="alert" className="mt-1 px-1 text-xs text-err-ink">{error}</p> : null}
      </form>
    </section>
  )
}

// --- Right column ---

/** The right column's tabs. Files is first; #2226 leaves the rest for later. */
export function RightTabs() {
  return (
    <Tabs defaultValue="files" className="flex h-full min-h-0 flex-col px-3 py-2" data-shell="tabs">
      <TabsList aria-label="Panels" className="self-start">
        <TabsTrigger value="files"><Icon name="files" className="mr-1.5" />Files</TabsTrigger>
      </TabsList>
      <TabsContent value="files" className="min-h-0 flex-1 overflow-y-auto">
        <EmptyState title="No files yet" action={<a className="text-sm text-link hover:underline" href="#view=projects">Open Projects</a>}>
          The files of the project you work on show here.
        </EmptyState>
      </TabsContent>
    </Tabs>
  )
}

// --- The shell ---

export interface SimpleShellProps extends SideMenuProps {}

/** The three columns, laid out for a computer and for a phone. */
export function SimpleShell(props: SimpleShellProps) {
  const [sheet, setSheet] = useState<"menu" | "tabs" | null>(null)
  const current = props.agents?.find((a) => a.id === props.agent)
  const bar = (
    <>
      <PhoneButton label="Menu" icon="menu" className="md:hidden" onClick={() => setSheet("menu")} />
      <PhoneButton label="Files" icon="panel-right" className="order-last ml-auto lg:hidden" onClick={() => setSheet("tabs")} />
    </>
  )
  return (
    <div
      data-shell="simple" data-layout={props.view.layout}
      className="fixed inset-0 z-30 grid grid-cols-1 bg-background text-foreground md:grid-cols-[240px_minmax(0,1fr)] lg:grid-cols-[260px_minmax(0,1fr)_300px]"
    >
      <aside className="hidden min-h-0 border-r border-border bg-muted/40 md:block">
        <SideMenu {...props} />
      </aside>
      <main className="min-h-0">
        <ShellChat agent={current} phoneBar={bar} />
      </main>
      <aside aria-label="Right column" className="hidden min-h-0 border-l border-border lg:block">
        <RightTabs />
      </aside>
      <Dialog open={sheet !== null} onOpenChange={(o) => { if (!o) setSheet(null) }}>
        <DialogContent className="left-0 top-0 h-full max-w-[300px] translate-x-0 translate-y-0 rounded-none p-0" aria-describedby={undefined}>
          <DialogTitle className="sr-only">{sheet === "tabs" ? "Files" : "Menu"}</DialogTitle>
          {sheet === "tabs" ? <RightTabs /> : <SideMenu {...props} onDone={() => setSheet(null)} />}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function PhoneButton({ label, icon, className, onClick }: { label: string; icon: string; className?: string; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={label} className={cn("size-8", className)} onClick={onClick}>
          <Icon name={icon} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** The route: the boot's viewer, the layout now, the agents of this Hub. */
export default function ShellPage(_: HubPageProps) {
  const boot = useMemo(() => readBoot(), [])
  // Re-read on each draw: coming back from Settings › Layout redraws the page.
  const view = currentLayout(boot)
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => apiGet<RawAgent[] | AgentsReply>("/api/agents") })
  const list = agents.data ? shellAgents(agents.data) : agents.isError ? [] : undefined
  const [agent, setAgent] = useState<string | undefined>()
  useEffect(() => { if (!agent && list?.length) setAgent(list[0].id) }, [agent, list])
  return <SimpleShell view={view} owner={boot.owner} agents={list} agent={agent} onAgent={setAgent} />
}
