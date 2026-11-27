// --- The Task page's runs: the live run and the past runs (#2101 T2) ---
//
// Fills the Task page's runs slot. RunPanel is the run going now as a
// conversation (the ask, then the agent's steps and reply as they stream),
// with a steer box and Stop while it runs; when it ends it stays put.
// PastRuns lists the other runs, newest first; each opens in place,
// read-only, as its stored record. The data and the calls are in runs.ts,
// the same as the old run page's. The conversation parts are the old run
// page's own (src/web/task-conversation), so both pages draw a run alike.
//
// Loaded on its own (TaskPage lazy-loads this file): Streamdown is not in
// the Task page's first load.
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useMemo, useState, type FormEvent } from "react"
import { outStamp, type OutStamp } from "../../agents/output-stamps"
import { Conversation } from "../../web/task-conversation/elements/Conversation"
import { Parts } from "../../web/task-conversation/elements/Parts"
import { parseStream } from "../../web/task-conversation/parse"
import "../../web/task-conversation/styles.css"
import "../shell/chat-markdown.css"
import { apiFetch, apiPost } from "../api"
import { followTaskStream, taskStreamUrl } from "../shell/chat-stream"
import { Button, Icon, Kbd, Skeleton, Tooltip, TooltipContent, TooltipTrigger, cn } from "../ui"
import { Ago, Rows, TaskSection } from "./parts"
import {
  followupNote, isRunning, recordOutput, runActionUrl, runHash, runNodeUrl, runRecordUrl, runState, runTook, runView, runningTaskIds, stopNote,
  type RequestRun, type RunRecord, type RunState,
} from "./runs"
import type { LiveSnapshot, TaskNode } from "./task-data"

const TONE: Record<RunState["tone"], string> = { work: "text-primary", done: "text-ok-ink", err: "text-err-ink", idle: "text-muted-foreground" }

function StateMark({ st, className }: { st: RunState; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1", className)} data-state={st.word.toLowerCase()}>
      <Icon name={st.icon} className={cn("size-3.5", TONE[st.tone], st.tone === "work" && "animate-spin [animation-duration:2s] motion-reduce:animate-none")} />
      <span>{st.word}{st.reason ? ": " + st.reason : ""}</span>
    </span>
  )
}

/** What was asked, as the user's bubble on the right (A4). */
function Ask({ text }: { text: string }) {
  if (!text) return null
  return <div className="mb-3 ml-auto w-fit max-w-[80%] whitespace-pre-wrap break-words rounded-2xl bg-muted px-4 py-2 text-sm">{text}</div>
}

export default function TaskRuns({ runs, taskNode, live, run, now, nameOf }: {
  runs: RequestRun[]; taskNode: TaskNode | null | undefined; live: LiveSnapshot | undefined; run: string | null; now: number; nameOf: (id: string) => string
}) {
  const node = runNodeUrl(taskNode, live)
  const running = useMemo(() => runningTaskIds(live), [live])
  const [watched, setWatched] = useState<string | null>(null)
  const view = runView(runs, run, running, watched)
  // Once shown live, a run keeps its place when it ends.
  useEffect(() => { if (view.live && isRunning(view.live, running)) setWatched(view.live.taskId) }, [view.live, running])

  return (
    <>
      {view.live && <RunPanel key={view.live.taskId} run={view.live} node={node} running={running} now={now} nameOf={nameOf} onNewRun={setWatched} />}
      {view.past.length > 0 && <PastRuns runs={view.past} opened={view.opened} node={node} running={running} now={now} nameOf={nameOf} />}
    </>
  )
}

// --- The live run ---

interface Live { raw: string; stamps: OutStamp[]; ask: string; ended: boolean }

/** The run's output as it streams; `ended` once the stream says so. */
function useLiveRun(node: string, run: RequestRun): Live {
  const [out, setOut] = useState<Live>({ raw: "", stamps: [], ask: "", ended: false })
  const client = useQueryClient()
  useEffect(() => {
    if (!node || typeof window === "undefined" || !("EventSource" in window)) return
    let stamps: OutStamp[] = [], prev = "", ask = ""
    return followTaskStream(
      taskStreamUrl(node, run.agentId, run.taskId),
      (raw, chunk) => {
        if (chunk) outStamp(stamps, prev, chunk.text, chunk.at)
        prev = raw
        setOut((o) => ({ ...o, raw, stamps: stamps.slice(), ask }))
      },
      () => {
        setOut((o) => ({ ...o, ended: true }))
        // The thread now has the run's end: read it again.
        void client.invalidateQueries({ queryKey: ["task-thread"] })
      },
      { onStart: (d) => { stamps = (d.stamps ?? []).slice(); ask = d.message || ask } },
    )
  }, [node, run.agentId, run.taskId, client])
  return out
}

function RunPanel({ run, node, running, now, nameOf, onNewRun }: {
  run: RequestRun; node: string; running: Set<string> | null; now: number; nameOf: (id: string) => string; onNewRun: (taskId: string) => void
}) {
  const out = useLiveRun(node, run)
  const going = isRunning(run, running) && !out.ended
  // Ended, while the thread still reads "in-flight": no outcome to show
  // until it is read again (the stream's end asks for that).
  const st: RunState | null = going ? runState({ ...run, status: "in-flight" }, null) : run.status === "in-flight" ? null : runState(run, running)
  const parts = useMemo(() => parseStream(out.raw, { final: !going, stamps: out.stamps }), [out.raw, out.stamps, going])
  const [box, setBox] = useState<HTMLDivElement | null>(null)

  return (
    <TaskSection
      id="run" title={going ? "Live run" : "Run"}
      action={
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status" aria-live="polite">
          {st && <><StateMark st={st} /><span aria-hidden="true">·</span></>}
          <span>{nameOf(run.agentId)}</span>
          <span aria-hidden="true">·</span>
          <Ago at={run.at} now={now} />
        </span>
      }
    >
      <div data-slot="task-run" data-state={going ? "running" : "ended"} aria-busy={going} className="overflow-hidden rounded-xl border border-border bg-card/50 shadow-xs">
        <div ref={setBox} className="axc max-h-[min(60vh,560px)] overflow-y-auto px-4 py-3">
          <Ask text={out.ask} />
          {box && <Conversation scroller={box} tick={out.raw.length}><Parts parts={parts} live={going} /></Conversation>}
          {!going && !out.raw && <p className="text-[13px] text-muted-foreground">{run.text || "No output from this run."}</p>}
        </div>
      </div>
      {going && <Steer run={run} node={node} onNewRun={onNewRun} />}
    </TaskSection>
  )
}

/** The steer box and Stop: the old run page's follow-up and cancel. */
function Steer({ run, node, onNewRun }: { run: RequestRun; node: string; onNewRun: (taskId: string) => void }) {
  const client = useQueryClient()
  const [text, setText] = useState("")
  const [note, setNote] = useState<{ text: string; err: boolean }>({ text: "", err: false })
  const [busy, setBusy] = useState(false)

  const send = async (e?: FormEvent) => {
    e?.preventDefault()
    const message = text.trim()
    if (busy || !message) return
    setBusy(true); setNote({ text: "Sending…", err: false })
    try {
      const r = await apiPost<{ error?: string; resumed?: boolean; taskId?: string; answeredBy?: string }>(runActionUrl(node, run.taskId, "followup"), { message, agent: run.agentId })
      const n = followupNote(r)
      setNote(n)
      if (!n.err) setText("")
      if (r?.resumed && r.taskId) { onNewRun(r.taskId); void client.invalidateQueries({ queryKey: ["task-thread"] }) }
    } catch (err) { setNote({ text: "Not sent: " + (err as Error).message, err: true }) }
    setBusy(false)
  }
  const stop = async () => {
    setNote({ text: "Stopping…", err: false })
    try { setNote(stopNote(await apiPost<{ error?: string }>(runActionUrl(node, run.taskId, "cancel"), {}))) }
    catch (err) { setNote({ text: "Not stopped: " + (err as Error).message, err: true }) }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <form onSubmit={send} aria-label="Steer the run" className="flex items-end gap-2 rounded-xl border border-border bg-background py-2 pl-4 pr-2 shadow-xs focus-within:border-input">
        <textarea
          rows={1} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } }}
          placeholder="Steer it: your words go in as its next turn" aria-label="Steer the run"
          className="max-h-[200px] min-h-8 flex-1 resize-none self-center bg-transparent py-1 text-base leading-normal text-foreground outline-none [field-sizing:content] placeholder:text-muted-foreground md:text-sm"
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="outline" size="icon-sm" aria-label="Stop" onClick={() => void stop()} className="shrink-0 rounded-full">
              <Icon name="square" className="size-3.5 fill-current" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Stop the run</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="submit" aria-label="Send" disabled={!text.trim() || busy}
              className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-full bg-primary text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:bg-muted disabled:text-muted-foreground">
              <Icon name="arrow-up" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Send <Kbd>Enter</Kbd></TooltipContent>
        </Tooltip>
      </form>
      <p role="status" aria-live="polite" className={cn("min-h-4 px-1 text-xs", note.err ? "text-err-ink" : "text-muted-foreground")}>{note.text}</p>
    </div>
  )
}

// --- The past runs ---

const SHOWN = 3

function PastRuns({ runs, opened, node, running, now, nameOf }: {
  runs: RequestRun[]; opened: string | null; node: string; running: Set<string> | null; now: number; nameOf: (id: string) => string
}) {
  const [open, setOpen] = useState<string | null>(opened)
  const [all, setAll] = useState(() => !!opened && runs.findIndex((r) => r.taskId === opened) >= SHOWN)
  const shown = all ? runs : runs.slice(0, SHOWN)
  const toggle = (id: string) => {
    const next = open === id ? null : id
    setOpen(next)
    // The address names the opened run, so a link opens it again; the page
    // stays where it is (no new history entry, no hashchange).
    history.replaceState(history.state, "", runHash(location.hash, next))
  }

  return (
    <TaskSection id="past-runs" title="Past runs" count={runs.length}>
      <Rows>
        {shown.map((r) => {
          const st = runState(r, running)
          const isOpen = open === r.taskId
          return (
            <div key={r.taskId} data-slot="task-past-run" data-state={isOpen ? "open" : "closed"}>
              <button
                type="button" aria-expanded={isOpen} onClick={() => toggle(r.taskId)}
                className="flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring can-hover:hover:bg-muted/50"
              >
                <Icon name="chevron-right" className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-out motion-reduce:transition-none", isOpen && "rotate-90")} />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{nameOf(r.agentId)}</span>
                    <StateMark st={st} />
                    {runTook(r.durationMs) && <span>{runTook(r.durationMs)}</span>}
                  </span>
                  {r.text && <span className="truncate text-[13px]">{r.text}</span>}
                </div>
                <Ago at={r.at} now={now} className="shrink-0 text-xs text-muted-foreground" />
              </button>
              {isOpen && <PastRun run={r} node={node} />}
            </div>
          )
        })}
      </Rows>
      {runs.length > SHOWN && (
        <Button variant="ghost" size="sm" className="self-start text-[13px] text-muted-foreground" onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : "Show all (" + runs.length + ")"}
        </Button>
      )}
    </TaskSection>
  )
}

/** One past run, read-only: its stored record as the conversation. */
function PastRun({ run, node }: { run: RequestRun; node: string }) {
  const rec = useQuery({
    queryKey: ["task-run-record", node, run.agentId, run.taskId],
    enabled: !!node,
    queryFn: () => apiFetch<RunRecord>(runRecordUrl(node, run.agentId, run.taskId)),
    staleTime: Infinity,
  })
  const parts = useMemo(() => {
    if (!rec.data) return []
    const o = recordOutput(rec.data)
    return parseStream(o.raw, { final: true, stamps: o.stamps })
  }, [rec.data])

  return (
    <div data-slot="task-run-record" className="axc border-t border-border/60 px-4 py-3">
      {rec.isPending && node ? (
        <div aria-busy="true" aria-label="Loading the run" className="flex flex-col gap-2"><Skeleton className="ml-auto h-8 w-1/2 rounded-2xl" /><Skeleton className="h-4 w-3/4" /><Skeleton className="h-4 w-2/3" /></div>
      ) : rec.isError || !node ? (
        <p className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
          <Icon name="circle-alert" className="size-3.5 text-err-ink" />
          {node ? "Could not read this run: " + (rec.error as Error).message : "No machine to read this run from."}
          {node && <Button variant="outline" size="xs" onClick={() => void rec.refetch()}><Icon name="rotate-ccw" />Retry</Button>}
        </p>
      ) : (
        <>
          <Ask text={rec.data?.message || ""} />
          {parts.length ? <Parts parts={parts} live={false} /> : <p className="text-[13px] text-muted-foreground">No output kept for this run.</p>}
        </>
      )}
    </div>
  )
}
