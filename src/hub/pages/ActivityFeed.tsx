// --- The Activity pane's Feed (#2457) ---
//
// The old Hub's Activity (#page=activity, wall-activity.client.ts #1429) in
// the shell: every run newest first, one row each with the agent, machine
// and time, what it worked on, its outcome, what started it, how long it
// took, its cost and its project. Outcome tabs (Failed with its count), the
// agent, project and source filters above. A row opens in place: what was
// asked, where it ran, its review findings, and a link to its Task page.
import { useState, type ReactNode } from "react"
import {
  EMPTY_FILTER, MARK_WORDS, NO_PROJECT, RESULT_WORDS, SOURCE_WORDS, clock, feedChoices, feedMatch, feedSummary, fmtCost, fmtDur,
  runFrom, runHref, runResult, runSource, runTook,
  type ActivityData, type ActivityRun, type FeedFilter, type RunResult,
} from "../activity"
import type { TimelineMark } from "../../daemon/activity-timeline"
import {
  Badge, Button, EmptyState, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, buttonVariants, cn,
} from "../ui"

const ALL = "*"
const ring = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"

const BADGE: Record<RunResult, "outline" | "err" | "ok"> = { done: "outline", failed: "err", running: "ok", stopped: "outline" }

function Pick({ label, value, all, items, onPick }: { label: string; value: string; all: string; items: { value: string; label: string }[]; onPick: (v: string) => void }) {
  return (
    <Select value={value || ALL} onValueChange={(v) => onPick(v === ALL ? "" : v)}>
      <SelectTrigger aria-label={label} className="h-8 max-w-[170px] flex-1 text-xs sm:flex-none"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{all}</SelectItem>
        {items.map((i) => <SelectItem key={i.value} value={i.value}>{i.label}</SelectItem>)}
      </SelectContent>
    </Select>
  )
}

/** All, Done, Failed (with how many), Running, Stopped. */
export function FeedTabs({ runs, filter, onResult }: { runs: ActivityRun[]; filter: FeedFilter; onResult: (r: RunResult | "") => void }) {
  const failed = runs.filter((r) => feedMatch(r, filter, "result") && runResult(r.status) === "failed").length
  const tabs: [RunResult | "", string][] = [["", "All"], ...(Object.entries(RESULT_WORDS) as [RunResult, string][])]
  return (
    <div role="tablist" aria-label="Outcome" data-activity="tabs" className="flex gap-1 overflow-x-auto border-b border-border px-3">
      {tabs.map(([k, label]) => (
        <button
          key={k || "all"} type="button" role="tab" aria-selected={filter.result === k} data-result={k} onClick={() => onResult(k)}
          className={cn("flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-2 text-[13px] cursor-pointer", ring,
            filter.result === k ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
        >
          {label}
          {k === "failed" && failed ? <Badge variant="warn" className="px-1.5 text-[11px] tabular-nums">{failed}</Badge> : null}
        </button>
      ))}
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  )
}

/** A row opened in place. */
export function FeedOpen({ run, marks, onAgent }: { run: ActivityRun; marks: TimelineMark[]; onAgent?: (id: string) => void }) {
  const result = runResult(run.status)
  const src = runSource(run)
  const where = [run.node, src === "jobs" ? "scheduled job" : run.channel, run.chatId && src !== "jobs" ? run.chatId : ""].filter(Boolean).join(" · ")
  return (
    <div data-activity="open" className="mt-2 flex flex-col gap-3 rounded-md border border-border bg-background p-3">
      <dl className="grid grid-cols-[70px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px] sm:grid-cols-[90px_minmax(0,1fr)]">
        <Field label="Result">
          {result === "failed" ? <span className="text-err-ink">Failed{run.durationMs != null ? " after " + fmtDur(run.durationMs) : ""}. The Task page has what it said.</span>
            : result === "running" ? <>Still running, {runTook(run)}.</>
            : <>{RESULT_WORDS[result]}{run.durationMs != null ? " in " + fmtDur(run.durationMs) : ""}.</>}
        </Field>
        <Field label="Asked"><span className="block max-h-[9.5em] overflow-auto whitespace-pre-line">{run.preview || <i>No request recorded</i>}</span></Field>
        <Field label="Where">{where || "–"}</Field>
        <Field label="Review">
          {marks.length ? (
            <ul className="list-disc pl-4">{marks.map((m, n) => <li key={n}><b className="font-medium">{MARK_WORDS[m.kind] ?? m.kind}.</b> {m.text}</li>)}</ul>
          ) : <span className="text-muted-foreground">No review findings for this run</span>}
        </Field>
      </dl>
      <div className="flex flex-wrap gap-2">
        <a href={runHref(run)} className={buttonVariants({ size: "sm", variant: "outline" })}>Open the run</a>
        {src === "jobs" ? <a href="#page=home&pane=automations" className={buttonVariants({ size: "sm", variant: "ghost" })}>Automations</a> : null}
        {onAgent ? <Button size="sm" variant="ghost" onClick={() => onAgent(run.agentId)}>{run.agentId}'s runs</Button> : null}
      </div>
    </div>
  )
}

/** One run. A tap on the row opens it; the title opens its Task page. */
export function FeedRow({ run, open, multi, marks, onToggle, onAgent }: {
  run: ActivityRun; open: boolean; multi: boolean; marks: TimelineMark[]; onToggle: () => void; onAgent: (id: string) => void
}) {
  const result = runResult(run.status)
  const title = (run.preview || "").split("\n")[0].trim()
  return (
    <li data-run={run.id} data-result={result} className={cn("px-3 py-2.5", open && "bg-muted/50")}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <button type="button" className={cn("truncate font-medium text-foreground hover:underline cursor-pointer", ring)} title={`Only ${run.agentId}'s runs`} onClick={() => onAgent(run.agentId)}>{run.agentId}</button>
        {multi && run.node ? <span className="truncate">{run.node}</span> : null}
        <span className="tabular-nums">{run.startedAt ? clock(run.startedAt) : ""}</span>
        <Badge variant={BADGE[result]} className="ml-auto text-[11px] font-normal">{RESULT_WORDS[result]}</Badge>
        <button type="button" aria-expanded={open} aria-label={open ? "Close this run" : "Open this run here"} onClick={onToggle}
          className={cn("rounded-sm px-1 text-muted-foreground hover:text-foreground cursor-pointer", ring)}>{open ? "−" : "+"}</button>
      </div>
      <a href={runHref(run)} title="Open this run" className={cn("mt-0.5 line-clamp-2 text-[13px] hover:underline", ring)}>{title || <i className="text-muted-foreground">No request recorded</i>}</a>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        <span title="What started it">{runFrom(run)}</span>
        <span title="How long it took">{runTook(run)}</span>
        <span title={typeof run.costUsd === "number" ? "What it cost" : "No cost recorded for this run"}>{fmtCost(run.costUsd)}</span>
        {run.project ? <span title="Project" className="font-medium text-foreground">{run.project}</span> : null}
      </div>
      {open ? <FeedOpen run={run} marks={marks} /> : null}
    </li>
  )
}

/** The Feed: tabs, filters, the summary line, then the runs. */
export function ActivityFeed({ data, period }: { data: ActivityData; period: string }) {
  const [filter, setFilter] = useState<FeedFilter>(EMPTY_FILTER)
  const [open, setOpen] = useState("")
  const set = (patch: Partial<FeedFilter>) => { setFilter((f) => ({ ...f, ...patch })); setOpen("") }
  const { agents, projects } = feedChoices(data.runs)
  const shown = data.runs.filter((r) => feedMatch(r, filter))
  const multi = new Set(data.runs.map((r) => r.node)).size > 1
  const filtered = !!(filter.result || filter.agent || filter.project || filter.source)
  const clear = <Button size="sm" variant="outline" onClick={() => set(EMPTY_FILTER)}>Clear filters</Button>
  return (
    <div className="flex flex-col" data-activity="feed">
      <FeedTabs runs={data.runs} filter={filter} onResult={(result) => set({ result })} />
      <div role="group" aria-label="Filters" className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Pick label="Agent" all="All agents" value={filter.agent} items={agents.map((a) => ({ value: a, label: a }))} onPick={(agent) => set({ agent })} />
        <Pick label="Project" all="All projects" value={filter.project} items={projects.map((p) => ({ value: p, label: p === NO_PROJECT ? "Other (no project)" : p }))} onPick={(project) => set({ project })} />
        <Pick label="Started by" all="Any source" value={filter.source} items={SOURCE_WORDS.map((s) => ({ value: s.value, label: s.label }))} onPick={(source) => set({ source: source as FeedFilter["source"] })} />
      </div>
      {data.runs.length ? <p className="border-b border-border px-3 py-2 text-xs text-muted-foreground" data-activity="summary">{feedSummary(shown, data.runs.length, period)}, newest first</p> : null}
      {shown.length ? (
        <ul className="divide-y divide-border">
          {shown.map((r) => (
            <FeedRow key={r.id + (r.nodeUrl || "")} run={r} open={open === r.id} multi={multi} marks={data.marks.filter((m) => m.runId === r.id)}
              onToggle={() => setOpen((o) => (o === r.id ? "" : r.id))} onAgent={(agent) => set({ agent })} />
          ))}
        </ul>
      ) : !data.runs.length ? (
        <EmptyState title="Nothing ran in this window" action={filtered ? clear : undefined}>Nothing ran in the last {period}. Try a longer period.</EmptyState>
      ) : (
        <EmptyState title="No runs match these filters" action={clear}>{data.runs.length} {data.runs.length === 1 ? "run" : "runs"} in the last {period} do not match.</EmptyState>
      )}
    </div>
  )
}
