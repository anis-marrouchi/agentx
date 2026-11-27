// --- Activity in the simple shell (#2457) ---
//
// The centre's Activity pane: what ran, where, and what it decided. Feed is
// the old Hub's Activity (#page=activity, ActivityFeed.tsx); Timeline (runs
// on lanes, review findings marked) and Map (the live fleet map) are the
// classic /activity page's two views, which the old Feed linked out to.
// Same reads, no daemon change; the data side is ../activity.ts, the Map a
// lazy chunk (ActivityMap.tsx).
import { useQuery } from "@tanstack/react-query"
import { Suspense, lazy, useMemo, useState, type CSSProperties, type ReactNode } from "react"
import { ActivityFeed } from "./ActivityFeed"
import {
  ACTIVITY_HOURS, ACTIVITY_PERSPECTIVES, FEED_HOURS, MARK_WORDS, activityTimeline, clock, fmtDur, fmtGap, loadActivity, runTone,
  type ActivityData, type ActivityPerspective, type ActivityRun, type ActivityView,
} from "../activity"
import type { Timeline, TimelineMark } from "../../daemon/activity-timeline"
import { Badge, Button, EmptyState, Icon, Skeleton, cn } from "../ui"

const ActivityMap = lazy(() => import("./ActivityMap"))

const ring = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"

/** A row of pressed/unpressed buttons, as the Tasks List/Kanban switch. */
function Segmented<T extends string | number>({ label, value, items, onPick, name }: {
  label: string; value: T; items: readonly { value: T; label: string; icon?: string }[]; onPick: (v: T) => void; name: string
}) {
  return (
    <div role="group" aria-label={label} data-activity={name} className="flex gap-0.5 rounded-md bg-muted p-0.5">
      {items.map((i) => (
        <button
          key={String(i.value)} type="button" aria-pressed={value === i.value} data-value={i.value} onClick={() => onPick(i.value)}
          className={cn("flex h-7 items-center gap-1.5 rounded-sm px-2.5 text-xs cursor-pointer", ring,
            value === i.value ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground")}
        >
          {i.icon ? <Icon name={i.icon} className="size-3.5" /> : null}{i.label}
        </button>
      ))}
    </div>
  )
}

/** A review finding's mark: the old page's diamond, triangle, dot and box. */
function Mark({ kind, className, style }: { kind: TimelineMark["kind"]; className?: string; style?: CSSProperties }) {
  const shape = kind === "decision" ? "rotate-45 bg-link" : kind === "warning" ? "bg-warn-ink [clip-path:polygon(50%_0,100%_100%,0_100%)]"
    : kind === "recommendation" ? "rounded-full bg-ok-ink" : "rounded-[2px] border-2 border-muted-foreground"
  return <i aria-hidden="true" data-mark={kind} className={cn("inline-block size-[9px] shrink-0", shape, className)} style={style} />
}

function MarksKey() {
  return (
    <div className="hidden flex-wrap items-center gap-3 text-[11.5px] text-muted-foreground md:flex" data-activity="key">
      <span className="inline-flex items-center gap-1.5"><Mark kind="decision" />decision</span>
      <span className="inline-flex items-center gap-1.5"><Mark kind="warning" />warning</span>
      <span className="inline-flex items-center gap-1.5"><Mark kind="recommendation" />friction</span>
      <span className="inline-flex items-center gap-1.5"><Mark kind="later" />do later</span>
      <span className="inline-flex items-center gap-1.5"><Icon name="x" className="size-3" />canceled</span>
    </div>
  )
}

const BAR: Record<ReturnType<typeof runTone>, string> = {
  done: "bg-link/80 border-link",
  running: "bg-ok border-ok-ink",
  failed: "bg-err-tint border-err-ink",
  canceled: "bg-transparent border-[1.5px] border-dashed border-err-ink h-3.5 mt-[3px]",
}

/** The bands of a row: one cell per active stretch, a hatched gap between. */
function Bands({ t, head, cell }: { t: Timeline; head?: boolean; cell: (bi: number) => ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1">
      {t.bands.map((b, i) => (
        <div key={i} className="contents">
          {i ? (
            <div className={cn("w-11 shrink-0", head
              ? "flex items-center justify-center border-x border-dashed border-border font-mono text-[9px] font-semibold text-muted-foreground"
              : "bg-[repeating-linear-gradient(45deg,var(--color-surface-2)_0_3px,transparent_3px_7px)]")}>
              {head ? fmtGap(t.gaps[i - 1]) : null}
            </div>
          ) : null}
          <div className="relative min-w-0" style={{ flex: b.weight.toFixed(4) }}>{cell(i)}</div>
        </div>
      ))}
    </div>
  )
}

/** The lanes and their runs. `selected` is outlined; a click picks a run. */
export function ActivityTimeline({ t, runs, selected, onPick }: { t: Timeline; runs: number; selected: string | null; onPick: (id: string) => void }) {
  return (
    <div data-activity="timeline" className="overflow-hidden rounded-md border border-border">
      <div className="flex border-b border-border bg-surface-2">
        <div className="flex w-[120px] shrink-0 items-center border-r border-border px-3 py-2 font-mono text-[10px] text-muted-foreground md:w-[186px]">
          {t.lanes.length} lanes · {runs} runs
        </div>
        <Bands t={t} head cell={(bi) => (
          <div className="flex items-center justify-center py-2 font-mono text-[10px] font-semibold text-muted-foreground">
            {clock(t.bands[bi].from)} – {clock(t.bands[bi].to)}
          </div>
        )} />
      </div>
      {t.lanes.map((ln) => (
        <div key={ln.key} data-lane={ln.key} className="flex border-b border-border last:border-b-0" style={{ height: 10 + ln.tracks * 24 }}>
          <div className="flex w-[120px] shrink-0 flex-col justify-center border-r border-border px-3 md:w-[186px]">
            <b className="truncate text-xs font-semibold">{ln.label}</b>
            {ln.sub ? <span className="truncate font-mono text-[10px] text-muted-foreground">{ln.sub}</span> : null}
          </div>
          <Bands t={t} cell={(bi) => ln.runs.filter((r) => r.band === bi).map((r) => {
            const top = 5 + r.track * 24
            return (
              <div key={r.id} className="contents">
                {r.marks.map((m, n) => <Mark key={n} kind={m.kind} className="pointer-events-none absolute -translate-x-1/2" style={{ left: r.left.toFixed(3) + "%", top: top - 11 }} />)}
                <button
                  type="button" data-run={r.id} aria-pressed={selected === r.id}
                  aria-label={`${r.laneLabel}, ${clock(r.startedAt)}, ${fmtDur(r.durationMs || 0)}, ${r.status}`}
                  title={`${r.laneLabel} · ${clock(r.startedAt)} · ${fmtDur(r.durationMs || 0)}`}
                  onClick={() => onPick(r.id)}
                  className={cn("absolute h-5 cursor-pointer rounded-[5px] border p-0 hover:brightness-110", ring, BAR[runTone(r.status)],
                    selected === r.id && "outline-2 outline-offset-1 outline-foreground")}
                  style={{ left: r.left.toFixed(3) + "%", width: r.width.toFixed(3) + "%", top }}
                />
              </div>
            )
          })} />
        </div>
      ))}
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="pt-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  )
}

/** The picked run: what it was, when, who, where, for whom, and its findings. */
export function ActivityDetail({ run, marks }: { run: ActivityRun; marks: TimelineMark[] }) {
  const found = marks.filter((m) => m.runId === run.id)
  return (
    <article data-activity="detail" className="flex flex-col gap-3 rounded-md border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium">{run.preview || "(no prompt recorded)"}</h2>
        <Badge variant="outline" className="text-[11px] font-normal">{run.status}</Badge>
      </div>
      <dl className="grid grid-cols-[80px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]">
        <Field label="When">{clock(run.startedAt)} · took {fmtDur(run.durationMs || 0)}</Field>
        <Field label="Who">{run.agentId}{run.node ? " on " + run.node : ""}</Field>
        <Field label="Where">{run.channel || "—"}{run.chatId ? " · " + run.chatId : ""}</Field>
        <Field label="For">{run.clientId || "unmapped"}</Field>
        {run.person ? <Field label="Started by">{run.personName || run.person}</Field> : null}
      </dl>
      {found.length ? (
        <ul className="flex flex-col divide-y divide-border border-t border-border text-[13px]">
          {found.map((m, n) => (
            <li key={n} className="flex items-start gap-2 py-2"><Mark kind={m.kind} className="mt-1" /><span><b className="font-medium">{MARK_WORDS[m.kind] ?? m.kind}.</b> {m.text}</span></li>
          ))}
        </ul>
      ) : <p className="border-t border-border pt-2 text-[13px] text-muted-foreground">No review findings for this run.</p>}
    </article>
  )
}

export interface ActivityBodyProps {
  data?: ActivityData
  view: "feed" | "timeline"
  perspective: ActivityPerspective
  /** The window in words ("24 h"), for the Feed's lines. */
  period: string
  error?: string | null
  onRetry?: () => void
}

/** Loading, error, or what was read (with what is missing said above it):
 *  the Feed, or the timeline with the picked run under it. */
export function ActivityBody({ data, view, perspective, period, error, onRetry }: ActivityBodyProps) {
  if (error && !data) {
    return (
      <EmptyState title="Could not read the runs" action={<Button size="sm" variant="outline" onClick={onRetry}>Try again</Button>}>
        <span role="alert">{error}</span>
      </EmptyState>
    )
  }
  if (!data) return <div className="flex flex-col gap-2 p-4"><Skeleton className="h-8 w-full" /><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-2/3" /></div>
  return (
    <div className="flex flex-col">
      {data.errors.map((e, n) => <p key={n} role="status" className="border-b border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn-ink">{e}</p>)}
      {view === "feed" ? <ActivityFeed data={data} period={period} /> : <TimelineBody key={perspective} data={data} perspective={perspective} />}
    </div>
  )
}

function TimelineBody({ data, perspective }: { data: ActivityData; perspective: ActivityPerspective }) {
  const [selected, setSelected] = useState<string | null>(null)
  const t = useMemo(() => activityTimeline(data, perspective), [data, perspective])
  const run = selected ? data.runs.find((r) => r.id === selected) : undefined
  if (!data.runs.length) return <EmptyState title="Nothing ran in this window">Pick a longer window, or come back after the agents have worked.</EmptyState>
  return (
    <div className="flex flex-col gap-3 p-4">
      <ActivityTimeline t={t} runs={data.runs.length} selected={selected} onPick={setSelected} />
      {run ? <ActivityDetail run={run} marks={data.marks} /> : <p className="px-1 text-xs text-muted-foreground">Pick a run to see what it decided.</p>}
    </div>
  )
}

const errText = (e: unknown) => (e instanceof Error ? e.message : "the computer did not answer")

const VIEWS = [
  { value: "feed", label: "Feed", icon: "list" },
  { value: "timeline", label: "Timeline", icon: "chart-line" },
  { value: "map", label: "Map", icon: "network" },
] as const

/** The pane. Feed and Timeline read once per window (Refresh reads again,
 *  and they share a window's read); Map is live. */
export function ActivityPane({ phoneBar }: { phoneBar?: ReactNode }) {
  const [view, setView] = useState<ActivityView>("feed")
  // The Feed's periods are the old Hub's, the Timeline's and Map's the classic page's.
  const [feedHours, setFeedHours] = useState(24)
  const [laneHours, setLaneHours] = useState(24)
  const [perspective, setPerspective] = useState<ActivityPerspective>("agent")
  const hours = view === "feed" ? feedHours : laneHours
  const choices = view === "feed" ? FEED_HOURS : ACTIVITY_HOURS
  const period = choices.find((c) => c.value === hours)?.label ?? hours + " h"
  const q = useQuery({ queryKey: ["shell-activity", hours], queryFn: () => loadActivity(hours), enabled: view !== "map" })
  return (
    <section aria-label="Activity" data-shell="activity" className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        {phoneBar}
        <h1 className="truncate text-sm font-medium">Activity</h1>
        <div className="ml-auto flex items-center gap-1">
          <Segmented name="view" label="View" value={view} items={VIEWS} onPick={setView} />
          {view !== "map" ? (
            <Button variant="ghost" size="icon" className="size-8" aria-label="Refresh" title="Refresh" disabled={q.isFetching} onClick={() => void q.refetch()}>
              <Icon name="refresh-cw" className={cn("size-4", q.isFetching && "animate-spin")} />
            </Button>
          ) : null}
        </div>
      </header>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Segmented name="hours" label="Period" value={hours} items={choices} onPick={view === "feed" ? setFeedHours : setLaneHours} />
        {view === "timeline" ? (
          <>
            <span className="ml-1 hidden text-xs text-muted-foreground sm:inline">Lanes by</span>
            <div className="max-w-full overflow-x-auto"><Segmented name="perspective" label="Lanes by" value={perspective} items={ACTIVITY_PERSPECTIVES} onPick={setPerspective} /></div>
            <div className="ml-auto"><MarksKey /></div>
          </>
        ) : view === "map" ? <span className="text-xs text-muted-foreground">Projects are lines, agents are stations, work in flight is a train. Live.</span> : null}
      </div>
      {view === "map" ? (
        <div className="min-h-0 flex-1" data-activity="map">
          <Suspense fallback={<p className="px-4 py-10 text-center text-sm text-muted-foreground">Loading the fleet map…</p>}>
            <ActivityMap hours={hours} />
          </Suspense>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ActivityBody data={q.data} view={view} perspective={perspective} period={period} error={q.isError ? errText(q.error) : null} onRetry={() => void q.refetch()} />
        </div>
      )}
    </section>
  )
}
