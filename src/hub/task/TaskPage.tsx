// --- The Task page, one per request (#2101 T1) ---
//
// Anis 2026-11-26: one page per request in place of the old post page
// (`#post=<id>`) and the old run page (`#page=task`). From the top:
//
//   Head     Back, the request as its title, its state, what was asked.
//   Stands   Asked, Working, Waits (only while it waits), Done; why it waits.
//   Plan     each step with its owner, state and proof ("2 of 5").
//   Result   the agent's answer, Markdown.
//   Runs     the live run with its steer box and Stop, then the past runs,
//            each opening in place (TaskRuns.tsx, T2).
//   Facts    who asked, chat, project, goal, times, estimate.
//   Links    home, proof, comments posted there.
//   Thread   the timeline, then the comment box and the actions.
//
// One 768 px column, as the feed. On the review id `task-preview` (pages.ts,
// owner only) while the old pages keep their addresses; T3 moves them here.
// Reads and writes are the old post page's (task-data.ts), sent to the node
// that keeps the request.
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Suspense, lazy, useEffect, useMemo, useState, type FormEvent } from "react"
import { HUB_NAME } from "../../daemon/ui/hub-name"
import { apiFetch, apiPost } from "../api"
import { readBoot } from "../boot"
import { useLiveSnapshot } from "../live-react"
import type { HubPageProps } from "../registry"
import {
  Button, EmptyState, Icon, Kbd, Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  Skeleton, Tooltip, TooltipContent, TooltipTrigger, cn,
} from "../ui"
import { Ago, FactList, LinkRow, PlanSteps, Prose, StageStrip, TaskSection, TaskSkeleton, Thread, planLabel } from "./parts"
import {
  allAgents, closeCall, closeConfirmText, isOpen, mentionText, mentionedAgents, nodeAgents, stateWord,
  taskAddress, taskFacts, taskFlags, taskLinks, taskRead, taskStages, taskThreadPath, waitReason,
  type CloseKind, type LiveSnapshot, type TaskRead, type TaskThreadReply,
} from "./task-data"
import { requestRuns } from "./runs"

const TaskRuns = lazy(() => import("./TaskRuns"))

const STATE_ICON: Record<string, { icon: string; tone: string }> = {
  in_progress: { icon: "loader-circle", tone: "text-primary" },
  waiting_owner: { icon: "clock", tone: "text-warn-ink" },
  waiting_other: { icon: "clock", tone: "text-muted-foreground" },
  needs_attention: { icon: "circle-alert", tone: "text-err-ink" },
  done: { icon: "circle-check", tone: "text-ok-ink" },
}

function leave() {
  if (history.length > 1) { history.back(); return }
  location.hash = ""
}

/** A Radix layer (dialog, menu, select, popover) is open: Esc is its own. */
const layerOpen = () => !!document.querySelector("[role=dialog][data-state=open], [data-radix-popper-content-wrapper]")

export default function TaskPage({ params }: HubPageProps) {
  const addr = taskAddress(params)
  const path = taskThreadPath(addr)
  const thread = useQuery({
    queryKey: ["task-thread", path, addr.peer],
    enabled: !!path,
    queryFn: () => apiFetch<TaskThreadReply>(path!, { headers: addr.peer ? { "X-Agentx-Peer": addr.peer } : {} }),
    refetchInterval: 15_000,
  })
  const read = useMemo(() => taskRead(thread.data, addr.peer), [thread.data, addr.peer])
  const live = useLiveSnapshot<LiveSnapshot>()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(t) }, [])
  useEffect(() => { setNow(Date.now()) }, [thread.dataUpdatedAt])

  // Esc goes back, unless a field or a layer has it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || layerOpen()) return
      const t = e.target as HTMLElement | null
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(t?.tagName || "") || t?.isContentEditable) return
      e.preventDefault(); leave()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  useEffect(() => { if (read) document.title = (read.post.headline || read.post.id) + " · " + HUB_NAME }, [read?.post.headline, read?.post.id]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div data-slot="task-page" className="mx-auto flex w-full max-w-[768px] flex-col gap-6 px-6 pb-12 pt-6 max-sm:gap-5 max-sm:px-4 max-sm:pt-3">
      {!path ? <EmptyState title="No task in this address" action={<Button variant="outline" size="sm" onClick={leave}>Back</Button>}>The address names no request.</EmptyState>
        : thread.isPending ? <TaskSkeleton />
        : thread.isError && !thread.data ? (
          <EmptyState title="Could not load the task" action={<Button variant="outline" size="sm" onClick={() => void thread.refetch()}>Retry</Button>}>
            {(thread.error as Error | null)?.message || "No answer"}.
          </EmptyState>
        ) : !read ? (
          <EmptyState title="No request for this run" action={<Button variant="outline" size="sm" onClick={leave}>Back</Button>}>Nobody tracks it as a request, so it has no Task page.</EmptyState>
        ) : <TaskBody read={read} live={live.data} now={now} run={addr.run} />}
    </div>
  )
}

function TaskBody({ read, live, now, run }: { read: TaskRead; live: LiveSnapshot | undefined; now: number; run: string | null }) {
  const { post: p, plan, events } = read
  const names = useMemo(() => Object.fromEntries(allAgents(live).map((a) => [a.id, a.name || a.id])), [live])
  const nameOf = (id: string) => names[id] || id
  const st = STATE_ICON[p.state] ?? { icon: "ban", tone: "text-muted-foreground" }
  const why = waitReason(p)
  const flags = taskFlags(p)
  const links = taskLinks(p)
  const facts = taskFacts(p)

  return (
    <>
      <header data-slot="task-head" className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Back" onClick={leave} className="-ml-2 size-7 text-muted-foreground"><Icon name="arrow-left" /></Button>
            </TooltipTrigger>
            <TooltipContent>Back <Kbd>Esc</Kbd></TooltipContent>
          </Tooltip>
          <span>Task</span>
          <span aria-hidden="true">·</span>
          <span>@{nameOf(p.owner)}</span>
          <span className={cn("ml-auto inline-flex items-center gap-1 font-medium", st.tone)} data-state={p.state}>
            <Icon name={st.icon} className={cn("size-3.5", p.state === "in_progress" && "animate-spin [animation-duration:2s] motion-reduce:animate-none")} />
            {stateWord(p.state)}
          </span>
        </div>
        <h1 className="text-2xl font-semibold leading-tight tracking-[-0.01em] max-sm:text-xl">{p.headline || p.id}</h1>
        {p.need && p.need !== p.headline && <p className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{p.need}</p>}
      </header>

      <div className="flex flex-col gap-2">
        <StageStrip stages={taskStages(p, plan, now)} />
        {why && <p role="status" className="flex items-start gap-1.5 text-[13px] text-warn-ink"><Icon name="clock" className="mt-0.5 size-3.5 shrink-0" />{why}</p>}
        {flags.map((f) => <p key={f} className="flex items-start gap-1.5 text-[13px] text-warn-ink"><Icon name="triangle-alert" className="mt-0.5 size-3.5 shrink-0" />{f}</p>)}
      </div>

      {plan.length > 0 && (
        <TaskSection id="plan" title="Plan" count={planLabel(plan)}>
          <PlanSteps plan={plan} nameOf={nameOf} />
        </TaskSection>
      )}

      {p.result && (
        <TaskSection id="result" title="Result" action={<span className="text-xs text-muted-foreground">{nameOf(p.result.agentId || p.owner)} · <Ago at={p.result.at} now={now} /></span>}>
          <Prose text={p.result.text} className="px-1" />
        </TaskSection>
      )}

      <RunsSlot read={read} live={live} run={run} now={now} nameOf={nameOf} />

      <TaskSection id="facts" title="Facts">
        <FactList facts={facts} now={now} />
      </TaskSection>

      {links.length > 0 && (
        <TaskSection id="links" title="Links" count={links.length}>
          <LinkRow links={links} />
        </TaskSection>
      )}

      <TaskSection id="thread" title="Thread" count={events.length}>
        <Thread events={events} now={now} />
        <Actions read={read} live={live} nameOf={nameOf} />
      </TaskSection>
    </>
  )
}

/** The live run and the past runs (TaskRuns.tsx), loaded on their own; a
 *  block shaped like the run holds the place while they load. */
function RunsSlot({ read, live, run, now, nameOf }: { read: TaskRead; live: LiveSnapshot | undefined; run: string | null; now: number; nameOf: (id: string) => string }) {
  const runs = useMemo(() => requestRuns(read.events), [read.events])
  if (!runs.length) return null
  return (
    <Suspense fallback={<Skeleton aria-label="Loading the runs" className="h-40 w-full rounded-xl" />}>
      <TaskRuns runs={runs} taskNode={read.post.node} live={live} run={run} now={now} nameOf={nameOf} />
    </Suspense>
  )
}

// --- The comment box and the actions (the old post page's, same calls) ---

function Actions({ read, live, nameOf }: { read: TaskRead; live: LiveSnapshot | undefined; nameOf: (id: string) => string }) {
  const p = read.post
  const peer = p.node?.peer ?? null
  const owner = readBoot().owner
  const client = useQueryClient()
  const [text, setText] = useState("")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [closing, setClosing] = useState<{ kind: CloseKind; agentId: string } | null>(null)
  const refresh = () => void client.invalidateQueries({ queryKey: ["task-thread"] })
  const handTo = nodeAgents(live, p.node)
  const open = isOpen(p.state)

  const comment = async (e?: FormEvent) => {
    e?.preventDefault()
    const body = text.trim()
    if (busy) return
    if (!body) { setNote("Write the comment first."); return }
    setBusy(true); setNote("Sending…")
    try {
      const r = await apiPost<{ message?: string }>("/api/admin/wall/comment", { id: p.id, text: body }, peer)
      setText("")
      const sent = r?.message || "Sent."
      setNote(sent)
      const told: string[] = []
      for (const m of mentionedAgents(body, allAgents(live), p.owner)) {
        try { await apiPost("/api/admin/wall/post", { agent: m.id, text: mentionText(HUB_NAME, p, body) }, m.peer); told.push(m.name || m.id) } catch { /* the note lists who got it */ }
      }
      if (told.length) setNote(sent + " Also posted to " + told.join(", ") + ".")
      refresh()
    } catch (err) { setNote("Not sent: " + (err as Error).message) }
    setBusy(false)
  }
  const call = async () => {
    setBusy(true); setNote("Calling…")
    try {
      const r = await apiPost<{ busy?: boolean }>("/api/admin/wall/call", { id: p.id }, peer)
      setNote(nameOf(p.owner) + " is calling you on AgentX Voice." + (r?.busy ? " You look busy: it waits for you." : ""))
    } catch (err) { setNote("No call: " + (err as Error).message) }
    setBusy(false)
  }
  const confirm = async () => {
    if (!closing) return
    const c = closeCall(closing.kind, p.id, closing.agentId, text.trim())
    setBusy(true); setNote(closing.kind === "handoff" ? "Handing it over…" : "Closing…")
    try {
      const r = await apiPost<{ message?: string }>(c.path, c.body, peer)
      setText(""); setClosing(null); setNote(r?.message || "Done.")
      refresh()
    } catch (err) { setNote("Not changed: " + (err as Error).message) }
    setBusy(false)
  }

  return (
    <div data-slot="task-actions" className="mt-2 flex flex-col gap-2">
      <form onSubmit={comment} aria-label="Comment" className="flex flex-col gap-1.5 rounded-xl border border-border bg-background pb-2 pl-4 pr-3 pt-3 shadow-xs focus-within:border-input">
        <textarea
          rows={1} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void comment() } }}
          placeholder={open ? "Comment, or @ another agent to bring it in" : "Comment to open it again for @" + nameOf(p.owner)}
          aria-label="Comment"
          className="max-h-[200px] min-h-6 w-full resize-none bg-transparent text-base leading-normal text-foreground outline-none [field-sizing:content] placeholder:text-muted-foreground md:text-sm"
        />
        <div className="flex min-h-8 flex-wrap items-center gap-1.5">
          {owner && (
            <>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void call()} className="text-[13px]"><Icon name="phone" />Call {nameOf(p.owner)}</Button>
              {open && (
                <>
                  <Select value="" onValueChange={(v) => setClosing({ kind: "handoff", agentId: v })}>
                    <SelectTrigger aria-label="Hand to" disabled={busy || !handTo.length} className="h-8 w-auto gap-1.5 border-transparent bg-transparent px-3 text-[13px] font-medium shadow-none data-[placeholder]:text-foreground can-hover:hover:bg-muted">
                      <Icon name="arrow-right" /><SelectValue placeholder="Hand to…" />
                    </SelectTrigger>
                    <SelectContent>
                      {handTo.map((a) => <SelectItem key={a.id} value={a.id}>{(a.name || a.id) + (a.id === p.owner ? " (has it: try again)" : "")}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => setClosing({ kind: "done", agentId: "" })} className="text-[13px]"><Icon name="check" />Done</Button>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => setClosing({ kind: "drop", agentId: "" })} className="text-[13px]"><Icon name="ban" />Drop</Button>
                </>
              )}
            </>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="submit" aria-label="Comment" disabled={!text.trim() || busy}
                className="ml-auto grid size-8 shrink-0 cursor-pointer place-items-center rounded-full bg-primary text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:bg-muted disabled:text-muted-foreground">
                <Icon name="arrow-up" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Comment <Kbd>Enter</Kbd></TooltipContent>
          </Tooltip>
        </div>
      </form>
      {closing && (
        <div role="alertdialog" aria-label="Confirm" className="flex flex-wrap items-center gap-2 rounded-xl border border-border px-4 py-2.5 text-[13px]">
          <span className="min-w-0 flex-1">{closeConfirmText(closing.kind, p.headline || p.id, nameOf(closing.agentId), !!text.trim())}</span>
          <Button variant="ghost" size="sm" onClick={() => setClosing(null)}>Back</Button>
          <Button variant={closing.kind === "drop" ? "destructive" : "default"} size="sm" disabled={busy} onClick={() => void confirm()}>Confirm</Button>
        </div>
      )}
      <p role="status" aria-live="polite" className="min-h-4 px-1 text-xs text-muted-foreground">{note}</p>
    </div>
  )
}
