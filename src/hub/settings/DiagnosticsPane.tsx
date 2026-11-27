// --- Settings › Diagnostics (#2101 ST3b) ---
//
// The mock's Diagnostics (settings-mock/full/diagnostics.html): seven tabs,
// one shown at a time, read-only. Each tab reads what the old Settings
// reads (wall-settings-diagnostics.client.ts): /api/admin/observability/
// overview, activity, errors, routing and rotations, the live log stream,
// and /api/admin/doctor. A row's tab is its `open` in panes.ts, so search
// turns to the tab before it scrolls to the row.
import { useQuery } from "@tanstack/react-query"
import { useContext, useState, type ReactNode } from "react"
import { apiGet } from "../api"
import { Badge, Button, Icon, Switch, Tabs, TabsList, TabsTrigger, Tooltip, TooltipContent, TooltipTrigger, cn } from "../ui"
import { Bars, DataTable, LogBox, useLogTail, type Col } from "./diagnostics-parts"
import { Choice, useWorkState } from "./fields"
import { Ago, DisclosureContext, Dots, EmptyLine, ErrorLine, INPUT, Lead, PaneHeader, SettingsGroup, SettingsItem, SettingsRow, SkeletonRows, TAB_TRIGGER } from "./parts"
import { paneDef, rowDef } from "./panes"
import { DIAGNOSTICS_TABS, type DiagnosticsTab as Tab } from "./rows/system"
import {
  delta, fillDays, fillHours, money, ms, num,
  type Activity, type AgentDay, type Doctor, type DoctorCheck, type Failure, type Overview, type RotationRow, type RouteRow, type Rows,
} from "./system-data"

const PANE = "diagnostics"
const TABS = DIAGNOSTICS_TABS.map(([t]) => t)
const LIMITS = ["50", "100", "200", "500"].map((l) => ({ value: l, label: l }))
const FILTERED: readonly Tab[] = ["overview", "activity", "errors", "routing", "rotations"]

/** Where the tab reads from; null for Logs (a stream). */
function source(tab: Tab, agent: string, limit: string): string | null {
  const a = agent ? "agent=" + encodeURIComponent(agent) : ""
  if (tab === "logs") return null
  if (tab === "doctor") return "/api/admin/doctor?running=true"
  if (tab === "overview" || tab === "activity") return "/api/admin/observability/" + tab + (a ? "?" + a : "")
  return "/api/admin/observability/" + tab + "?limit=" + limit + (a ? "&" + a : "")
}

export default function DiagnosticsPane() {
  const { isOpen, setOpen } = useContext(DisclosureContext)
  const tab: Tab = TABS.find((t) => isOpen("dg-tab-" + t)) ?? "overview"
  const pick = (t: string) => TABS.forEach((x) => setOpen("dg-tab-" + x, x === t))
  const [agent, setAgent] = useState("")
  const [limit, setLimit] = useState("50")
  const state = useWorkState()
  const path = source(tab, agent, limit)
  const data = useQuery({ queryKey: ["settings", "dg", tab, agent || "__all", limit], queryFn: () => apiGet<unknown>(path as string), enabled: !!path })
  const agents = state.data?.agents ?? []

  const action = tab === "logs" ? undefined : (
    <Button variant="outline" size="sm" disabled={data.isFetching} onClick={() => data.refetch()}>
      <Icon name={tab === "doctor" ? "play" : "refresh-cw"} className="size-3.5" />{tab === "doctor" ? "Run the checks again" : "Refresh"}
    </Button>
  )

  return (
    <>
      <PaneHeader pane={paneDef(PANE)} action={action} />
      <Tabs value={tab} onValueChange={pick} className="flex flex-col gap-8">
        <div className="sm:hidden">
          <Choice label="Diagnostics view" value={tab} onChange={pick} options={DIAGNOSTICS_TABS.map(([value, label]) => ({ value, label }))} />
        </div>
        <TabsList aria-label="Diagnostics view" className="-mt-2 h-auto w-full justify-start gap-1 overflow-x-auto rounded-none border-b border-border bg-transparent p-0 max-sm:hidden">
          {DIAGNOSTICS_TABS.map(([t, label]) => <TabsTrigger key={t} value={t} className={TAB_TRIGGER}>{label}</TabsTrigger>)}
        </TabsList>
        {FILTERED.includes(tab) && (
          <div className="-mt-4 flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground">
            <span>Agent</span>
            <Choice
              label="Agent" value={agent} onChange={setAgent} className={cn("h-8 w-auto min-w-28", agent && "font-mono")}
              options={[{ value: "", label: "All agents" }, ...agents.map((a) => ({ value: a.id, label: <span className="font-mono text-xs">{a.id}</span> }))]}
            />
            {tab !== "overview" && tab !== "activity" && <>
              <span className="ml-2">Rows</span>
              <Choice label="Rows" value={limit} onChange={setLimit} options={LIMITS} className="h-8 w-auto" />
            </>}
          </div>
        )}
        {tab === "logs" ? <Logs /> : data.isPending ? <SkeletonRows /> : data.isError ? (
          <ErrorLine text={`Could not read ${tab}: ${(data.error as Error).message}`} onRetry={() => data.refetch()} />
        ) : tab === "overview" ? <OverviewTab data={data.data as Overview} onErrors={() => pick("errors")} />
          : tab === "activity" ? <ActivityTab data={data.data as Activity} />
          : tab === "errors" ? <TableGroup row="dg-errors" cols={ERROR_COLS} rows={(data.data as Rows<Failure>).rows} empty="No errors found." rowKey={(r, i) => r.started_at + i} />
          : tab === "routing" ? <TableGroup row="dg-routing" cols={ROUTE_COLS} rows={(data.data as Rows<RouteRow>).rows} empty="No routing decisions yet." rowKey={(r, i) => r.at + i} />
          : tab === "rotations" ? <TableGroup row="dg-rotations" cols={ROTATION_COLS} rows={(data.data as Rows<RotationRow>).rows} empty="No rotations yet." rowKey={(r, i) => r.rotated_at + i} />
          : <DoctorTab data={data.data as Doctor} />}
      </Tabs>
    </>
  )
}

// --- Overview ---

const at = (id?: string) => (id ? <span className="font-mono">@{id}</span> : "–")
const Val = ({ children }: { children: ReactNode }) => <span className="text-sm font-semibold tabular-nums">{children}</span>

/** A clock time for a table: `14:33:52` today, `Yesterday 18:12`, else the date. */
function Stamp({ iso, now = Date.now() }: { iso?: string; now?: number }) {
  const ms = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(ms)) return <>–</>
  const d = new Date(ms), day = (x: Date) => x.toDateString()
  const time = (s: boolean) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", ...(s ? { second: "2-digit" } : {}) })
  const text = day(d) === day(new Date(now)) ? time(true)
    : day(d) === day(new Date(now - 86_400_000)) ? "Yesterday " + time(false)
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) + " " + time(false)
  return (
    <Tooltip>
      <TooltipTrigger asChild><time dateTime={iso}>{text}</time></TooltipTrigger>
      <TooltipContent>{d.toLocaleString()}</TooltipContent>
    </Tooltip>
  )
}

const LastActive = ({ iso }: { iso?: string }) => (iso ? <Ago iso={iso} /> : <>–</>)

const AGENT_COLS: Col<AgentDay>[] = [
  { head: "Agent", cell: (r) => at(r.agent_id), mono: true },
  { head: "Tasks", cell: (r) => num(r.tasks), num: true },
  { head: "Errors", cell: (r) => num(r.errors), num: true },
  { head: "Average time", cell: (r) => ms(r.avg_duration_ms), num: true },
  { head: "Last active", cell: (r) => <LastActive iso={r.last_active} /> },
]
const CHANNEL_COLS: Col<{ channel: string; tasks?: number; errors?: number }>[] = [
  { head: "Channel", cell: (r) => r.channel, mono: true },
  { head: "Tasks", cell: (r) => num(r.tasks), num: true },
  { head: "Errors", cell: (r) => num(r.errors), num: true },
]

function OverviewTab({ data, onErrors }: { data: Overview; onErrors: () => void }) {
  const k = data.kpis ?? {}
  const fails = data.recentErrors ?? []
  const idle = data.idleAgents ?? []
  const errs = k.errorsToday ?? 0
  return <>
    <SettingsGroup pane={PANE} row="dg-today">
      <SettingsRow pane={PANE} row="dg-tasks" help={delta(k.tasksDelta, num)} control={<Val>{num(k.tasksToday)}</Val>} />
      <SettingsRow
        pane={PANE} row="dg-errors-today" help={((k.errorRate ?? 0) * 100).toFixed(1) + "% of tasks"}
        control={errs ? <Badge variant="err">{num(errs)} error{errs === 1 ? "" : "s"}</Badge> : <Val>0</Val>}
      />
      <SettingsRow pane={PANE} row="dg-response" help={`p50 ${ms(k.p50DurationMs)} · p95 ${ms(k.p95DurationMs)}`} control={<Val>{ms(k.avgDurationMs)}</Val>} />
      <SettingsRow pane={PANE} row="dg-spend" help={delta(k.spendDelta, money)} control={<Val>{money(k.spendToday)}</Val>} />
    </SettingsGroup>

    <SettingsGroup pane={PANE} row="dg-failures">
      {fails.length === 0 ? <EmptyLine>No failures in the last 24 hours.</EmptyLine> : fails.map((f, i) => (
        <SettingsItem
          key={f.started_at + i} id={"fail-" + i}
          lead={<Lead icon="circle-alert" />}
          name={f.plain || f.error || "Failed"}
          meta={<>
            <Dots items={[<Ago key="t" iso={f.started_at} />, at(f.agent_id), f.channel]} />
            {f.message_preview && <span className="basis-full truncate">“{String(f.message_preview).slice(0, 200)}”</span>}
          </>}
          menu={<Button variant="ghost" size="sm" onClick={onErrors}>Errors</Button>}
        />
      ))}
    </SettingsGroup>

    <TableGroup row="dg-agents" cols={AGENT_COLS} rows={data.perAgent} empty="No tasks yet today." rowKey={(r) => r.agent_id} />
    <TableGroup row="dg-channels" cols={CHANNEL_COLS} rows={data.perChannel} empty="No traffic yet today." rowKey={(r) => r.channel} />

    <p data-row={rowDef(PANE, "dg-idle").id} className="-mt-3 flex scroll-mt-6 items-start gap-2 px-1 text-[12.5px] text-muted-foreground">
      <Icon name="moon" className="mt-0.5 size-3.5 shrink-0" />
      <span>{idle.length
        ? <>Idle: {idle.map((a, i) => <span key={a}>{i > 0 && ", "}{at(a)}</span>)} ran no task in the last 24 hours.</>
        : "Every recently active agent ran a task in the last 24 hours."}</span>
    </p>
  </>
}

function TableGroup<T>({ row, cols, rows, empty, rowKey }: { row: string; cols: Col<T>[]; rows?: T[]; empty: string; rowKey: (r: T, i: number) => string }) {
  return (
    <SettingsGroup pane={PANE} row={row}>
      <DataTable cols={cols} rows={rows ?? []} empty={empty} rowKey={rowKey} />
    </SettingsGroup>
  )
}

// --- Activity ---

const hour = (t: number) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
const dayName = (t: number) => new Date(t).toLocaleDateString("en-GB", { weekday: "short", day: "numeric" })

function ActivityTab({ data }: { data: Activity }) {
  const hours = fillHours(data.hourly)
  const days = fillDays(data.daily)
  return <>
    <SettingsGroup pane={PANE} row="dg-activity">
      <Bars title="Tasks per hour" slots={hours} label={hour} axis={[hour(hours[0].at) + " yesterday", hour(hours[6].at), hour(hours[12].at), hour(hours[18].at), "Now"]} />
    </SettingsGroup>
    <SettingsGroup pane={PANE} row="dg-days">
      <Bars title="Tasks per day" slots={days} label={dayName} axis={days.map((d, i) => (i === days.length - 1 ? "Today" : dayName(d.at)))} />
    </SettingsGroup>
    <TableGroup row="dg-agents-week" cols={WEEK_COLS} rows={data.perAgent} empty="No tasks in the last 7 days." rowKey={(r) => r.agent_id} />
  </>
}

const WEEK_COLS: Col<NonNullable<Activity["perAgent"]>[number]>[] = [
  { head: "Agent", cell: (r) => at(r.agent_id), mono: true },
  { head: "Tasks 24 h", cell: (r) => num(r.tasks_24h), num: true },
  { head: "Tasks 7 days", cell: (r) => num(r.tasks_7d), num: true },
  { head: "Errors 7 days", cell: (r) => num(r.errors_7d), num: true },
  { head: "Average time", cell: (r) => ms(r.avg_duration_ms), num: true },
  { head: "Last active", cell: (r) => <LastActive iso={r.last_active} /> },
]

// --- Errors, Routing, Rotations ---

const ERROR_COLS: Col<Failure>[] = [
  { head: "When", cell: (r) => <Stamp iso={r.started_at} />, mono: true },
  { head: "Agent", cell: (r) => at(r.agent_id), mono: true },
  { head: "Channel", cell: (r) => r.channel || "–", mono: true },
  { head: "What happened", cell: (r) => r.plain || r.error || "–" },
  { head: "Message", cell: (r) => { const m = String(r.message_preview || ""); return m.length > 60 ? m.slice(0, 60) + "…" : m } },
]
const ROUTE_COLS: Col<RouteRow>[] = [
  { head: "When", cell: (r) => <Stamp iso={r.at} />, mono: true },
  { head: "Channel", cell: (r) => r.channel || "–", mono: true },
  { head: "Chat", cell: (r) => r.chat_id || "–", mono: true },
  { head: "Kind", cell: (r) => r.kind || "–" },
  { head: "Stage", cell: (r) => r.deciding_stage || "–" },
  { head: "Agent", cell: (r) => at(r.agent_id), mono: true },
  { head: "Reason", cell: (r) => r.reason || "–" },
]
const ROTATION_COLS: Col<RotationRow>[] = [
  { head: "When", cell: (r) => <Stamp iso={r.rotated_at} />, mono: true },
  { head: "Agent", cell: (r) => at(r.agent_id), mono: true },
  { head: "Channel", cell: (r) => r.channel || "–", mono: true },
  { head: "Reason", cell: (r) => r.reason || "–" },
  { head: "Last turn input tokens", cell: (r) => (r.last_turn_input_tokens == null ? "–" : num(r.last_turn_input_tokens)), num: true },
]

// --- Logs ---

function Logs() {
  const [paused, setPaused] = useState(false)
  const [follow, setFollow] = useState(true)
  const [filter, setFilter] = useState("")
  const tail = useLogTail(!paused)
  const def = rowDef(PANE, "dg-logs")
  return (
    <section data-slot="settings-group" data-row={def.id} aria-label={def.label} className="flex scroll-mt-6 flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Show lines containing…" aria-label="Filter lines"
          className={cn(INPUT, "min-w-0 flex-[1_1_200px] max-sm:basis-full")}
        />
        <label className="flex items-center gap-2 text-[12.5px] text-muted-foreground">Follow new lines<Switch checked={follow} onCheckedChange={setFollow} aria-label="Follow new lines" /></label>
        <Button variant="outline" size="sm" onClick={() => setPaused(!paused)}><Icon name={paused ? "play" : "pause"} className="size-3.5" />{paused ? "Resume" : "Pause"}</Button>
        <Button variant="ghost" size="sm" onClick={tail.clear}>Clear</Button>
        <span role="status">
          {tail.state === "live" ? <Badge variant="ok">Live</Badge>
            : tail.state === "paused" ? <Badge variant="secondary">Paused</Badge>
            : tail.state === "retrying" ? <Badge variant="warn">Reconnecting</Badge>
            : <Badge variant="secondary">Connecting</Badge>}
        </span>
      </div>
      <div data-slot="settings-card" className="overflow-hidden rounded-xl border border-border bg-card/50 px-5 shadow-xs">
        <LogBox lines={tail.lines} filter={filter} follow={follow} />
      </div>
    </section>
  )
}

// --- Doctor ---

const SEVERITY: Record<DoctorCheck["severity"], ReactNode> = {
  ok: <Badge variant="ok">OK</Badge>,
  warn: <Badge variant="warn">Warning</Badge>,
  fail: <Badge variant="err">Failing</Badge>,
}

function DoctorTab({ data }: { data: Doctor }) {
  const s = data.summary ?? {}
  const groups = new Map<string, DoctorCheck[]>()
  for (const c of data.checks ?? []) groups.set(c.group, [...(groups.get(c.group) ?? []), c])
  return <>
    <p data-row={rowDef(PANE, "dg-doctor").id} className="-mb-3 scroll-mt-6 px-1 text-[12.5px] text-muted-foreground">
      {s.ok ?? 0} OK · {s.warnings ?? 0} warnings · {s.errors ?? 0} failing. The same checks as <span className="font-mono">agentx doctor</span>.
    </p>
    {[...groups].map(([g, checks]) => (
      <SettingsGroup key={g} pane={PANE} title={g}>
        {checks.map((c, i) => (
          <SettingsItem
            key={c.title + i} id={"check-" + g + "-" + i}
            name={<span className="font-normal">{c.title}</span>}
            meta={(c.detail || c.fix) && <span className="flex flex-col">
              {c.detail && <span className="break-words">{c.detail}</span>}
              {c.fix && <span>Fix: <span className="select-all break-all font-mono text-xs text-foreground">{c.fix}</span></span>}
            </span>}
            badge={SEVERITY[c.severity]}
          />
        ))}
      </SettingsGroup>
    ))}
  </>
}
