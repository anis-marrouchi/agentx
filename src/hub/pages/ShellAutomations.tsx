// --- Automations in the simple shell (#2226 S5) ---
//
// The centre's Automations pane: what runs on its own on every machine,
// the scheduled jobs and the workflows a schedule or an event starts, each
// with its next run, its last result and the strip of its last seven runs
// (automations.ts). Read only, as the old Hub's Schedules page is: it has
// no pause, resume or run-now to carry over. A row folds open for its
// schedule, what it is for, why it looks stale and the last run's words.
import { useQuery } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { apiGet } from "../api"
import {
  AUTOMATIONS_URL, SCHEDULES_PAGE, automationGroups, automationStatus, automationTotals, automationsPending, runTone, runWord, shortUntil,
  type Automation, type AutomationGroup, type LiveReply, type RunTone,
} from "../automations"
import { buildHash } from "../router"
import { shortAgo } from "../tasks"
import { Badge, Button, EmptyState, Icon, Skeleton, StatusDot, cn } from "../ui"

const SQUARE: Record<RunTone | "none", string> = {
  ok: "bg-ok", err: "bg-destructive", idle: "bg-muted-foreground/40", work: "bg-primary", none: "bg-muted-foreground/15",
}

/** The last seven runs as squares, oldest first; a missing run is a blank. */
export function RunStrip({ recent }: { recent: string[] }) {
  const runs = recent.slice(-7)
  const cells: (string | null)[] = [...Array(Math.max(0, 7 - runs.length)).fill(null), ...runs]
  return (
    <span className="inline-flex gap-0.5" role="img" aria-label={"Last seven runs: " + (runs.length ? runs.join(", ") : "none")} data-automation="strip">
      {cells.map((s, i) => <span key={i} className={cn("size-2 rounded-[2px]", SQUARE[s ? runTone(s) : "none"])} title={s ? runWord(s) : "No run"} />)}
    </span>
  )
}

const BADGE: Record<ReturnType<typeof automationStatus>["tone"], "ok" | "warn" | "err" | "outline"> = { ok: "ok", warn: "warn", err: "err", idle: "outline" }

/** One row: name and agent, next run, last result, the strip, its state. */
export function AutomationRow({ a, now = Date.now() }: { a: Automation; now?: number }) {
  const st = automationStatus(a)
  const failed = !!a.last && runTone(a.last.status) === "err"
  return (
    <details data-automation={a.id} className="group border-b border-border last:border-b-0">
      <summary className="grid cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-3 py-2 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:grid-cols-[minmax(0,1fr)_88px_120px_64px_112px] [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 flex-col">
          <span className="flex min-w-0 items-center gap-2">
            <Icon name="chevron-right" className="size-3.5 text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none" />
            <Icon name={a.source === "workflow" ? "workflow" : "clock"} className="size-3.5 text-muted-foreground" />
            <span className="truncate text-[13px] font-medium">{a.name}</span>
            {a.agent ? <span className="truncate text-xs text-muted-foreground">@{a.agent}</span> : null}
          </span>
          {failed && a.last?.summary ? <span className="truncate pl-[44px] text-xs text-err-ink">{a.last.summary.split("\n")[0]}</span>
            : a.why ? <span className="truncate pl-[44px] text-xs text-muted-foreground">{a.why}</span>
            : a.flags.length ? <span className="truncate pl-[44px] text-xs text-warn-ink">{a.flags[0]}</span> : null}
        </span>
        <span className="hidden text-xs tabular-nums sm:block" title={a.when}>
          {a.enabled ? (a.nextRunAt ? shortUntil(a.nextRunAt, now) : a.starts === "event" ? "on event" : "—") : "off"}
        </span>
        <span className="hidden items-center gap-1.5 text-xs sm:flex">
          {a.last ? (
            <>
              <StatusDot state={runTone(a.last.status)} label={runWord(a.last.status)} />
              <span className={cn("truncate", failed ? "text-err-ink" : "")}>{runWord(a.last.status)}</span>
              {a.last.at ? <span className="tabular-nums text-muted-foreground">{shortAgo(a.last.at, now)}</span> : null}
            </>
          ) : <span className="text-muted-foreground">No run yet</span>}
        </span>
        <span className="hidden sm:block"><RunStrip recent={a.recent} /></span>
        <Badge variant={BADGE[st.tone]} className="justify-self-end text-[11px]">{st.label}</Badge>
      </summary>
      <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-1.5 px-3 pb-3 pl-[56px] text-xs" data-automation="detail">
        <dt className="text-muted-foreground">{a.starts === "event" ? "Starts on" : "Schedule"}</dt>
        <dd><code className="font-mono text-[11px]">{a.when || "—"}</code>{a.timezone ? <span className="text-muted-foreground"> · {a.timezone}</span> : null}</dd>
        <dt className="text-muted-foreground">Kind</dt>
        <dd>{a.source === "workflow" ? "Workflow" : "Scheduled job"}{a.state && a.state !== "enabled" && a.state !== "active" ? <span className="text-muted-foreground"> · {a.state}</span> : null}</dd>
        {a.project.label ? (
          <>
            <dt className="text-muted-foreground">Project</dt>
            <dd>{a.project.href ? <a className="text-link hover:underline" href={a.project.href} target="_blank" rel="noopener noreferrer">{a.project.label}</a> : a.project.label}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Last run</dt>
        <dd className="whitespace-pre-wrap break-words">
          {a.last ? `${runWord(a.last.status)}${a.last.at ? ", " + new Date(a.last.at).toLocaleString() : ""}${a.last.summary ? ": " + a.last.summary.slice(0, 300) : ""}` : "No run on record."}
        </dd>
        <dt className="text-muted-foreground sm:hidden">Last seven</dt>
        <dd className="sm:hidden"><RunStrip recent={a.recent} /></dd>
        {a.flags.length ? (
          <>
            <dt className="text-muted-foreground">Notes</dt>
            <dd className="text-warn-ink">{a.flags.join("; ")}</dd>
          </>
        ) : null}
      </dl>
    </details>
  )
}

const NODE_NOTE: Record<AutomationGroup["state"], string> = { ok: "", checking: "checking…", down: "does not answer", stale: "as of" }

/** One machine: its name, how it answered, its rows (or why there are none). */
export function AutomationMachine({ group, now }: { group: AutomationGroup; now?: number }) {
  const note = group.state === "stale" && group.staleSince ? "as of " + new Date(group.staleSince).toLocaleString() : NODE_NOTE[group.state]
  return (
    <section aria-label={group.node} data-node={group.node} className="flex flex-col gap-1">
      <h2 className="flex items-center gap-2 px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <Icon name="monitor" className="size-3.5" />{group.node}
        <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums">{group.rows.length}</span>
        {note ? <span className="normal-case tracking-normal">{note}</span> : null}
      </h2>
      {group.rows.length ? (
        <div className="rounded-md border border-border">
          <div aria-hidden="true" className="hidden grid-cols-[minmax(0,1fr)_88px_120px_64px_112px] gap-x-3 border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground sm:grid">
            <span className="pl-[44px]">Name</span><span>Next run</span><span>Last result</span><span>Last 7</span><span />
          </div>
          {group.rows.map((a) => <AutomationRow key={a.id} a={a} now={now} />)}
        </div>
      ) : (
        <p className="rounded-md border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
          {group.state === "checking" ? "Checking this machine…" : group.state === "down" ? "This machine does not answer, so its automations are not shown." : "Nothing runs on its own here."}
        </p>
      )}
    </section>
  )
}

export interface AutomationsBodyProps {
  groups?: AutomationGroup[]
  error?: string | null
  onRetry?: () => void
  now?: number
}

/** Loading, error, empty, or every machine's automations. */
export function AutomationsBody({ groups, error, onRetry, now }: AutomationsBodyProps) {
  if (error) {
    return (
      <EmptyState title="Could not read the automations" action={<Button size="sm" variant="outline" onClick={onRetry}>Try again</Button>}>
        <span role="alert">{error}</span>
      </EmptyState>
    )
  }
  if (!groups) return <div className="flex flex-col gap-2"><Skeleton className="h-4 w-1/3" /><Skeleton className="h-9 w-full" /><Skeleton className="h-9 w-full" /><Skeleton className="h-9 w-2/3" /></div>
  const t = automationTotals(groups)
  if (t.total === 0 && groups.every((g) => g.state === "ok")) {
    return (
      <EmptyState title="Nothing runs on its own yet" action={<a className="text-sm text-link hover:underline" href={buildHash({ page: "home" })}>Ask an agent to schedule something</a>}>
        A scheduled job, or a workflow a schedule or an event starts, shows here with its last runs.
      </EmptyState>
    )
  }
  return (
    <div data-automations="list" className="flex flex-col gap-5">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs text-muted-foreground" data-automations="totals">
        <span><b className="font-medium text-foreground tabular-nums">{t.on}</b> on of {t.total}</span>
        {t.failed ? <span className="text-err-ink"><b className="font-medium tabular-nums">{t.failed}</b> last run failed</span> : null}
        {t.stale ? <span className="text-warn-ink"><b className="font-medium tabular-nums">{t.stale}</b> look stale</span> : null}
      </p>
      {groups.map((g) => <AutomationMachine key={g.node} group={g} now={now} />)}
      <p className="px-1 text-xs text-muted-foreground">
        Sensors, host jobs and today's totals are on the <a className="text-link hover:underline" href={SCHEDULES_PAGE}>Schedules page</a>.
      </p>
    </div>
  )
}

const errText = (e: unknown) => (e instanceof Error ? e.message : "the computer did not answer")

/** The pane: reads every machine (again soon while one is still checking). */
export function AutomationsPane({ phoneBar }: { phoneBar?: ReactNode }) {
  const live = useQuery({
    queryKey: ["shell-automations"],
    queryFn: () => apiGet<LiveReply>(AUTOMATIONS_URL),
    refetchInterval: (q) => (automationsPending(q.state.data as LiveReply | undefined) ? 2000 : 30_000),
  })
  const groups = live.data ? automationGroups(live.data) : undefined
  const total = groups ? automationTotals(groups).total : null
  return (
    <section aria-label="Automations" data-shell="automations" className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        {phoneBar}
        <h1 className="truncate text-sm font-medium">Automations</h1>
        {total !== null ? <span className="text-xs tabular-nums text-muted-foreground">{total}</span> : null}
      </header>
      <div className="mx-auto min-h-0 w-full max-w-[880px] flex-1 overflow-y-auto px-4 py-4">
        <AutomationsBody groups={groups} error={live.isError ? errText(live.error) : null} onRetry={() => void live.refetch()} />
      </div>
    </section>
  )
}
