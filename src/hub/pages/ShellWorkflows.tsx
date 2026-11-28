// --- Workflows in the simple shell (#2457) ---
//
// The centre's Workflows pane, `#page=home&pane=workflows&open=<id>`: the
// old Hub's Workflows page (#page=workflows) in the shell's look. One row
// per workflow (what starts it, its agents and project, its state, the
// last seven runs, an on/off switch for the owner); tabs All, Running,
// Failed and Off, a filter box and a project filter. A row opens on its
// last run step by step, with Run again, Open in the editor and All runs.
// Run… asks for the trigger's inputs. The data side is ../workflows.ts;
// same reads and writes as the old page, no daemon change.
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useMemo, useState, type ReactNode } from "react"
import { apiFetch, apiGet } from "../api"
import { navigate } from "../router"
import {
  NO_PROJECT, RUNS_MAX, RUNS_PAGE, RUNS_URL, WF_STATE, WF_TABS, WORKFLOWS_URL,
  duration, lastInput, matches, projectsOf, runFields, runPayload, runState, runSteps, runWhat, runsById, sortRows,
  stepCount, staleWords, stopLine, summaryLine, tabOf, wfAgents, wfIsManual, wfStarts, wfState,
  type WfField, type WfFilter, type WfRun, type WfState, type WfStepRow, type WfTab, type Workflow,
} from "../workflows"
import {
  AfCount, AfStateLabel, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  EmptyState, Icon, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, Switch,
  Tooltip, TooltipContent, TooltipTrigger, buttonVariants, cn, toast, type AfState,
} from "../ui"

const ring = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
const TONE_STATE: Record<(typeof WF_STATE)[WfState]["tone"], AfState> = { ok: "done", work: "running", warn: "waiting", err: "error", idle: "idle" }
const errText = (e: unknown) => (e instanceof Error ? e.message : "the computer did not answer")
const ALL_PROJECTS = "\u0000all"

export function StateLabel({ state, word }: { state: WfState; word?: string }) {
  return <AfStateLabel state={TONE_STATE[WF_STATE[state].tone]} label={word ?? WF_STATE[state].word} />
}

const SQUARE: Record<string, string> = { completed: "bg-ok", failed: "bg-destructive", running: "bg-primary", paused: "bg-warn" }

/** The last seven runs as squares, oldest first. */
export function RunSquares({ runs }: { runs: WfRun[] }) {
  const last = runs.slice(0, 7).reverse()
  if (!last.length) return null
  return (
    <span className="inline-flex gap-0.5" role="img" aria-label={`Last ${last.length} ${last.length === 1 ? "run" : "runs"}: ${last.map((r) => r.status).join(", ")}`} data-workflows="squares">
      {last.map((r) => (
        <Tooltip key={r.id}>
          <TooltipTrigger asChild><span className={cn("size-2 rounded-[2px]", SQUARE[r.status] ?? "bg-muted-foreground/40")} /></TooltipTrigger>
          <TooltipContent>{new Date(r.updatedAt).toLocaleString()}: {WF_STATE[runState(r)].word}</TooltipContent>
        </Tooltip>
      ))}
    </span>
  )
}

const STEP_ICON: Record<WfStepRow["state"], string> = {
  done: "check", failed: "circle-x", waiting: "clock", skipped: "circle-dashed", running: "loader-circle", todo: "circle",
  off: "circle", held: "circle", stopped: "circle", never: "circle",
}

/** A run step by step. */
export function RunStepsList({ rows }: { rows: WfStepRow[] }) {
  if (!rows.length) return <p className="text-xs text-muted-foreground">No steps recorded.</p>
  return (
    <ol data-workflows="steps" className="flex flex-col">
      {rows.map((s, i) => (
        <li key={i} className="flex min-w-0 items-center gap-2 border-b border-border py-1.5 text-[13px] last:border-b-0">
          <Icon name={STEP_ICON[s.state]} className={cn("size-3.5 shrink-0", s.state === "failed" ? "text-err-ink" : "text-muted-foreground", s.state === "running" && "animate-spin motion-reduce:animate-none")} />
          <span className="max-w-[60%] shrink-0 truncate font-medium">{s.name}</span>
          {s.who || s.meta ? <span className={cn("min-w-0 truncate text-xs", s.state === "failed" ? "text-err-ink" : "text-muted-foreground")}>{[s.who && "@" + s.who, s.meta].filter(Boolean).join(" · ")}</span> : null}
          <span className="ml-auto shrink-0">
            {s.state === "skipped" ? <span className="text-xs text-muted-foreground">Skipped</span>
              : s.state === "todo" ? <span className="text-xs text-muted-foreground">Not reached</span>
              : <StateLabel state={s.state} word={s.state === "running" ? "Running now" : s.state === "failed" ? "Failed" : undefined} />}
          </span>
        </li>
      ))}
    </ol>
  )
}

/** The opened row: its description, its last run step by step, its links. */
function WorkflowOpen({ wf, runs, capped, owner, busy, onAgain }: { wf: Workflow; runs: WfRun[]; capped: boolean; owner: boolean; busy: boolean; onAgain: () => void }) {
  const last = runs[0]
  const detail = useQuery({
    queryKey: ["shell-workflow-run", last?.id, last?.updatedAt],
    queryFn: () => apiGet<{ run: WfRun }>("/api/workflows/runs/" + encodeURIComponent(last!.id)),
    enabled: !!last,
  })
  const allRuns = capped || !runs.length ? "All runs" : runs.length === 1 ? "Its 1 run" : `All ${runs.length} runs`
  const link = buttonVariants({ variant: "ghost", size: "sm" })
  return (
    <div data-workflows="open" className="flex flex-col gap-3 px-3 pb-3 pl-9">
      {wf.description ? <p className="text-xs text-muted-foreground">{String(wf.description).slice(0, 400)}</p> : null}
      {last ? (
        <>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <b className="font-medium">Run at {new Date(last.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</b>
            <StateLabel state={runState(last)} word={runState(last) === "failed" ? "Failed" : undefined} />
            <span className="text-muted-foreground">
              {last.status === "running" ? "running for " + duration(Date.now() - Date.parse(last.createdAt)) : "took " + duration(Date.parse(last.updatedAt) - Date.parse(last.createdAt))}
              {" · started "}{last.entityRef?.backend === "manual" ? "by hand" : wfStarts(wf).replace(/^When/, "when").replace(/^Started /, "")}
              {last.homeNode ? " · on " + last.homeNode : ""}
            </span>
          </p>
          {detail.isError ? <p className="text-xs text-err-ink" role="alert">Could not read this run: {errText(detail.error)}.</p>
            : detail.data ? <RunStepsList rows={runSteps(wf, detail.data.run)} />
            : <div className="flex flex-col gap-1.5" aria-busy="true" aria-label="Loading the steps"><Skeleton className="h-6 w-full" /><Skeleton className="h-6 w-2/3" /></div>}
        </>
      ) : <p className="text-xs text-muted-foreground">It has not run yet.</p>}
      <div className="flex flex-wrap gap-1">
        {owner && wf.state === "active" && runs.length ? <Button size="sm" variant="ghost" disabled={busy} onClick={onAgain} className="max-sm:hidden"><Icon name="rotate-ccw" />Run again</Button> : null}
        <a className={cn(link, "max-sm:hidden")} href={"#page=editor&e-wf=" + encodeURIComponent(wf.id)}><Icon name="pencil" />Open in the editor</a>
        <a className={link} href={"/workflows#" + encodeURIComponent(wf.id)}><Icon name="external-link" />{allRuns}</a>
      </div>
    </div>
  )
}

interface RowProps { wf: Workflow; runs: WfRun[]; state: WfState; capped: boolean; open: boolean; owner: boolean; busy: boolean; onOpen: () => void; onToggle: (on: boolean) => void; onRun: () => void; onAgain: () => void }

/** One workflow: name, state, switch; what starts it, agents, project, squares. */
export function WorkflowRow({ wf, runs, state, capped, open, owner, busy, onOpen, onToggle, onRun, onAgain }: RowProps) {
  const on = wf.state === "active"
  const name = wf.title || wf.id
  const running = runs.find((r) => r.status === "running")
  const step = running?.history?.length ?? 0
  const stale = staleWords(wf, runs, capped)
  const fail = state === "failed" ? stopLine(wf, runs[0]) : ""
  const agents = wfAgents(wf)
  return (
    <article data-workflow={wf.id} data-open={open || undefined} className={cn("border-b border-border last:border-b-0", open && "bg-surface-2")}>
      <div className="flex min-w-0 items-start gap-2 px-3 py-2">
        <button type="button" onClick={onOpen} aria-expanded={open} className={cn("flex min-w-0 flex-1 cursor-pointer flex-col gap-1 rounded-sm text-left", ring)}>
          <span className="flex min-w-0 items-center gap-2">
            <Icon name="chevron-right" className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none", open && "rotate-90")} />
            <span className={cn("truncate text-[13px] font-medium", !on && "text-muted-foreground")}>{name}</span>
            {state === "held" ? (
              <Tooltip><TooltipTrigger asChild><span><StateLabel state="held" /></span></TooltipTrigger>
                <TooltipContent>Held: it would clash with another route for the same events. Fix the clash, or turn it on again in the editor.</TooltipContent></Tooltip>
            ) : state !== "off" || !owner ? <StateLabel state={state} /> : null}
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 pl-[22px] text-xs text-muted-foreground" data-workflows="meta">
            <span>{wfStarts(wf)}</span>
            {agents.length ? <span>{agents.map((a) => "@" + a).join(", ")}</span> : null}
            {wf.project ? <span>{wf.project}</span> : null}
            {running && step ? <span>step {step} of {Math.max(step, stepCount(wf))}</span> : null}
            {stale ? <span className="text-warn-ink">{stale} · looks stale</span> : null}
            <RunSquares runs={runs} />
          </span>
          {fail ? <span className="truncate pl-[22px] text-xs text-err-ink" data-workflows="fail">{fail}</span> : null}
        </button>
        {owner ? (
          <span className="flex shrink-0 items-center gap-2 max-sm:hidden">
            {on && !open ? <Button size="xs" variant="outline" disabled={busy} onClick={onRun} data-workflows="run"><Icon name="play" />Run…</Button> : null}
            {state !== "held" ? (
              <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                {on ? "On" : "Off"}
                <Switch checked={on} disabled={busy} onCheckedChange={onToggle} aria-label={`${name}: ${on ? "on" : "off"}`} />
              </label>
            ) : null}
          </span>
        ) : null}
      </div>
      {open ? <WorkflowOpen wf={wf} runs={runs} capped={capped} owner={owner} busy={busy} onAgain={onAgain} /> : null}
    </article>
  )
}

/** Run…: the trigger's inputs as a form, the JSON folded, one line on what happens. */
function RunDialog({ wf, onClose, onStart }: { wf: Workflow; onClose: () => void; onStart: (payload: Record<string, unknown>) => void }) {
  const fields = useMemo(() => runFields(wf), [wf])
  const [values, setValues] = useState<Record<string, string | boolean>>({})
  const [json, setJson] = useState("{}")
  const [err, setErr] = useState("")
  const set = (k: string, v: string | boolean) => setValues((s) => ({ ...s, [k]: v }))
  const start = () => {
    const got = runPayload(fields, values, json)
    if ("error" in got) setErr(got.error)
    else onStart(got.payload)
  }
  const input = "h-9 w-full rounded-md border border-input bg-background px-3 text-base md:text-sm " + ring
  const field = (f: WfField) => {
    const id = "wfr-" + f.key
    const v = values[f.key] ?? f.initial
    return (
      <div key={f.key} className="flex flex-col gap-1">
        <label htmlFor={id} className="text-xs text-muted-foreground">{f.label}{f.required ? <span aria-hidden="true"> *</span> : null}</label>
        {f.kind === "boolean" ? <input id={id} type="checkbox" className="size-4" checked={v === true} onChange={(e) => set(f.key, e.target.checked)} />
          : f.kind === "enum" ? (
            <select id={id} className={input} value={String(v)} onChange={(e) => set(f.key, e.target.value)}>
              {f.required ? null : <option value="" />}
              {f.options!.map((o) => <option key={o}>{o}</option>)}
            </select>
          ) : <input id={id} className={input} type={f.kind === "number" ? "number" : "text"} required={f.required} value={String(v)} onChange={(e) => set(f.key, e.target.value)} />}
        {f.hint ? <small className="text-xs text-muted-foreground">{f.hint}</small> : null}
      </div>
    )
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent data-workflows="dialog" className="max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Run "{wf.title || wf.id}"?</DialogTitle>
          <DialogDescription>{runWhat(wf)}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {fields.length ? fields.map(field) : <p className="text-sm text-muted-foreground">It takes no inputs.</p>}
          <details className="text-sm" open={err.startsWith("The JSON") || undefined}>
            <summary className="cursor-pointer text-xs text-muted-foreground">Inputs as JSON</summary>
            <textarea aria-label="Inputs as JSON" rows={4} spellCheck={false} value={json} onChange={(e) => setJson(e.target.value)}
              className={cn("mt-1.5 w-full rounded-md border border-input bg-background p-2 font-mono text-xs", ring)} />
          </details>
          {err ? <p role="alert" className="text-sm text-err-ink">{err}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Back</Button>
          <Button onClick={start} data-workflows="start">Start the run</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The tabs, each with its count (Off has none), as the old page. */
function TabsRow({ tab, counts, onTab }: { tab: WfTab; counts: Record<WfTab, number>; onTab: (t: WfTab) => void }) {
  return (
    <div role="tablist" aria-label="Show" data-workflows="tabs" className="flex gap-0.5 rounded-md bg-muted p-0.5">
      {WF_TABS.map((t) => (
        <button key={t.value} type="button" role="tab" aria-selected={tab === t.value} onClick={() => onTab(t.value)}
          className={cn("flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-sm px-2.5 text-xs", ring,
            tab === t.value ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground")}>
          {t.label}{t.value && t.value !== "off" && counts[t.value] ? <AfCount n={counts[t.value]} /> : null}
        </button>
      ))}
    </div>
  )
}

export interface WorkflowsBodyProps {
  defs?: Workflow[]
  runs?: WfRun[]
  capped?: boolean
  error?: string | null
  onRetry?: () => void
  owner: boolean
  open: string | null
  onOpen: (id: string | null) => void
  busy?: Record<string, boolean>
  onToggle?: (wf: Workflow, on: boolean) => void
  onRun?: (wf: Workflow) => void
  onAgain?: (wf: Workflow) => void
  /** The filters; kept by the pane, given here so a test can set them. */
  initialFilter?: Partial<WfFilter>
}

/** Loading, error, empty, or the filtered list. */
export function WorkflowsBody({ defs, runs, capped = false, error, onRetry, owner, open, onOpen, busy = {}, onToggle, onRun, onAgain, initialFilter }: WorkflowsBodyProps) {
  const [f, setF] = useState<WfFilter>({ tab: "", q: "", project: "", ...initialFilter })
  const byId = useMemo(() => runsById(runs ?? []), [runs])
  if (error && !runs) {
    return (
      <EmptyState title="Could not read the workflows" action={<Button size="sm" variant="outline" onClick={onRetry}>Try again</Button>}>
        <span role="alert">{error}. The rest of the Hub still works.</span>
      </EmptyState>
    )
  }
  if (!defs || !runs) {
    return <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading the workflows"><Skeleton className="h-7 w-1/2" /><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-2/3" /></div>
  }
  if (!defs.length) {
    return (
      <EmptyState title="No workflows yet" icon="workflow" action={owner ? <a className={buttonVariants({ variant: "outline", size: "sm" })} href="#page=editor&e-new=1">New workflow</a> : undefined}>
        A workflow is a set of steps your agents take, in order, each time something starts it.
      </EmptyState>
    )
  }
  const rows = defs.map((wf) => { const r = byId.get(wf.id) ?? []; return { wf, runs: r, state: wfState(wf, r) } })
  const base = rows.filter((x) => matches(x.wf, f, x.state, true))
  const counts = { "": 0, running: 0, failed: 0, off: 0 } as Record<WfTab, number>
  for (const x of base) counts[tabOf(x.state)]++
  const shown = sortRows(base.filter((x) => matches(x.wf, f, x.state)))
  const projects = projectsOf(defs)
  return (
    <div data-workflows="list" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filters">
        <TabsRow tab={f.tab} counts={counts} onTab={(tab) => setF((s) => ({ ...s, tab }))} />
        <input type="search" placeholder="Filter workflows" aria-label="Filter workflows" value={f.q} onChange={(e) => setF((s) => ({ ...s, q: e.target.value }))}
          className={cn("h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-base sm:max-w-[260px] md:text-sm", ring)} />
        {projects.length ? (
          <Select value={f.project || ALL_PROJECTS} onValueChange={(v) => setF((s) => ({ ...s, project: v === ALL_PROJECTS ? "" : v }))}>
            <SelectTrigger aria-label="Project" className="h-8 w-auto min-w-[140px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
              {projects.map((p) => <SelectItem key={p} value={p}>{p === NO_PROJECT ? "No project" : p}</SelectItem>)}
            </SelectContent>
          </Select>
        ) : null}
      </div>
      <p className="px-1 text-xs text-muted-foreground" data-workflows="summary">{summaryLine(defs, runs)}</p>
      {!owner ? <p className="px-1 text-xs text-muted-foreground">Only the owner can start, turn on or turn off a workflow.</p>
        : <p className="px-1 text-xs text-muted-foreground sm:hidden">Starting a workflow, turning it on or off and the editor are on a computer.</p>}
      {shown.length ? (
        <div className="rounded-md border border-border">
          {shown.map((x) => (
            <WorkflowRow key={x.wf.id} wf={x.wf} runs={x.runs} state={x.state} capped={capped} open={open === x.wf.id} owner={owner} busy={!!busy[x.wf.id]}
              onOpen={() => onOpen(open === x.wf.id ? null : x.wf.id)} onToggle={(on) => onToggle?.(x.wf, on)} onRun={() => onRun?.(x.wf)} onAgain={() => onAgain?.(x.wf)} />
          ))}
        </div>
      ) : (
        <EmptyState title="No workflow matches" action={<Button size="sm" variant="outline" onClick={() => setF({ tab: "", q: "", project: "" })}>Clear the filters</Button>}>
          Change or clear the filters to see more.
        </EmptyState>
      )}
    </div>
  )
}

const runsPage = async (before?: string) =>
  (await apiGet<{ runs?: WfRun[] }>(`${RUNS_URL}&limit=${RUNS_PAGE}` + (before ? "&before=" + encodeURIComponent(before) : ""))).runs ?? []

/** The runs older than the first page, a page at a time, up to RUNS_MAX in all. */
async function readOlder(before: string): Promise<{ runs: WfRun[]; capped: boolean }> {
  let runs: WfRun[] = []
  let page: WfRun[] = []
  do {
    page = await runsPage(runs.length ? runs[runs.length - 1].updatedAt : before)
    runs = runs.concat(page)
  } while (page.length >= RUNS_PAGE && runs.length + RUNS_PAGE < RUNS_MAX)
  return { runs, capped: page.length >= RUNS_PAGE }
}

/** The newest 100 runs paint first; older ones, up to 500, fill in after.
 *  Until they are in, the read counts as cut short (no "looks stale" yet). */
function useRuns() {
  const first = useQuery({ queryKey: ["shell-workflow-runs"], queryFn: () => runsPage(), refetchInterval: 60_000 })
  const more = (first.data?.length ?? 0) >= RUNS_PAGE
  const oldest = first.data?.[first.data.length - 1]?.updatedAt ?? ""
  const older = useQuery({ queryKey: ["shell-workflow-runs-older", oldest], queryFn: () => readOlder(oldest), enabled: more, refetchInterval: 60_000 })
  const runs = first.data && (older.data ? first.data.concat(older.data.runs) : first.data)
  const capped = more && (!older.data || older.data.capped)
  return { runs, capped, first }
}

const send = <T,>(method: string, path: string, body: unknown) =>
  apiFetch<T>(path, { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } })
const ownerOnly = (e: unknown) => (e && typeof e === "object" && "status" in e && ((e as any).status === 401 || (e as any).status === 403) ? "Only the owner can start, turn on or turn off a workflow" : errText(e))

/** The pane: reads the workflows and their runs; the owner's writes. */
export function WorkflowsPane({ owner, open, phoneBar }: { owner: boolean; open: string | null; phoneBar?: ReactNode }) {
  const qc = useQueryClient()
  const defs = useQuery({ queryKey: ["shell-workflows"], queryFn: () => apiGet<{ workflows?: Workflow[] }>(WORKFLOWS_URL), refetchInterval: 60_000 })
  const runs = useRuns()
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [dialog, setDialog] = useState<Workflow | null>(null)
  const list = defs.data?.workflows
  const setOpen = (id: string | null) => navigate({ page: "home", pane: "workflows", open: id })
  const hold = (id: string, on: boolean) => setBusy((b) => ({ ...b, [id]: on }))

  const toggle = async (wf: Workflow, on: boolean) => {
    const name = wf.title || wf.id
    hold(wf.id, true)
    try {
      // The definition as it is on disk now, so nothing the list left out is lost.
      const cur = (await apiGet<{ workflow?: Workflow }>("/api/workflows/" + encodeURIComponent(wf.id))).workflow ?? wf
      await send("PUT", "/api/workflows/" + encodeURIComponent(wf.id), { ...cur, state: on ? "active" : "disabled" })
      await qc.invalidateQueries({ queryKey: ["shell-workflows"] })
      toast.success(on ? `"${name}" is on. What starts it starts a run again.` : `"${name}" is off. It takes no new runs; runs under way go on.`)
    } catch (e) {
      toast.error(`Could not turn "${name}" ${on ? "on" : "off"}: ${ownerOnly(e)}.`)
    } finally { hold(wf.id, false) }
  }
  const start = async (wf: Workflow, payload: Record<string, unknown>) => {
    const name = wf.title || wf.id
    hold(wf.id, true)
    try {
      // A workflow something else starts runs with that start stood in for (force), as the classic Run.
      await send("POST", "/workflows/" + encodeURIComponent(wf.id) + "/run", { payload, force: !wfIsManual(wf) })
      setOpen(wf.id)
      toast.success(`Started "${name}".`)
      await qc.invalidateQueries({ queryKey: ["shell-workflow-runs"] })
    } catch (e) {
      toast.error(`Could not start "${name}": ${ownerOnly(e)}.`)
    } finally { hold(wf.id, false) }
  }
  const again = async (wf: Workflow) => {
    const last = runsById(runs.runs ?? []).get(wf.id)?.[0]
    let payload: Record<string, unknown> = {}
    try { if (last) payload = lastInput(wf, (await apiGet<{ run: WfRun }>("/api/workflows/runs/" + encodeURIComponent(last.id))).run) } catch { /* the run is gone: start with no input */ }
    void start(wf, payload)
  }

  const error = defs.isError ? errText(defs.error) : runs.first.isError ? errText(runs.first.error) : null
  return (
    <section aria-label="Workflows" data-shell="workflows" className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        {phoneBar}
        <h1 className="truncate text-sm font-medium">Workflows</h1>
        {list ? <span className="text-xs tabular-nums text-muted-foreground">{list.length}</span> : null}
        {owner ? <a className={cn(buttonVariants({ size: "sm", variant: "outline" }), "ml-auto max-sm:hidden")} href="#page=editor&e-new=1"><Icon name="plus" />New workflow</a> : null}
      </header>
      <div className="mx-auto min-h-0 w-full max-w-[880px] flex-1 overflow-y-auto px-4 py-4">
        <WorkflowsBody
          defs={list} runs={runs.runs} capped={runs.capped} error={error}
          onRetry={() => { void defs.refetch(); void runs.first.refetch() }}
          owner={owner} open={open} onOpen={setOpen} busy={busy}
          onToggle={(wf, on) => void toggle(wf, on)} onRun={setDialog} onAgain={(wf) => void again(wf)}
        />
      </div>
      {dialog ? <RunDialog wf={dialog} onClose={() => setDialog(null)} onStart={(p) => { const wf = dialog; setDialog(null); void start(wf, p) }} /> : null}
    </section>
  )
}
