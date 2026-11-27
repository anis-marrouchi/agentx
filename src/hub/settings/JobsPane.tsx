// --- Settings › Jobs (#2101 ST2b) ---
//
// The mock's Jobs (settings-mock/full/jobs.html): three tabs. Schedules
// lists the recurring jobs with their value line, the sensors and host
// jobs past their end; Webhooks (JobsHooks.tsx) and Wiki notes
// (JobsWiki.tsx). A tab is a fold of the shell (DisclosureContext), so
// search can open it before it scrolls to a row inside.
import { useContext, useState, type ReactNode } from "react"
import { Button, Icon, Tabs, TabsContent, TabsList, TabsTrigger, cn } from "../ui"
import { AddScheduleDialog } from "./JobsDialogs"
import JobsHooks from "./JobsHooks"
import JobsWiki from "./JobsWiki"
import { InlineFold, STATE_KEY, WriteNote, useWorkState, useWrite } from "./fields"
import { Ago, ConfirmDialog, DisclosureContext, ErrorLine, PaneHeader, RowMenu, SettingsGroup, SettingsItem, SkeletonRows, TAB_TRIGGER } from "./parts"
import { paneDef } from "./panes"
import { cronHuman, valueLine, type Cron, type Sensor } from "./work-data"

const PANE = "jobs"
const TABS = ["schedules", "webhooks", "wiki"] as const
type Tab = (typeof TABS)[number]
/** The Advanced fold inside the Wiki notes tab opens that tab too. */
const INSIDE: Record<string, Tab> = { "wn-adv": "wiki" }

export default function JobsPane() {
  const pane = paneDef(PANE)
  const state = useWorkState()
  const { isOpen, setOpen } = useContext(DisclosureContext)
  const tab: Tab = TABS.find((t) => isOpen("jobs-tab-" + t)) ?? Object.entries(INSIDE).find(([id]) => isOpen(id))?.[1] ?? "schedules"
  const pick = (t: string) => TABS.forEach((x) => setOpen("jobs-tab-" + x, x === t))
  const crons = state.data?.crons ?? [], hooks = state.data?.webhooks ?? []
  const n = (k: number) => state.data ? <span className="ml-1.5 text-[11.5px] font-normal tabular-nums text-muted-foreground">{k}</span> : null

  return (
    <>
      <PaneHeader pane={pane} />
      <Tabs value={tab} onValueChange={pick} className="flex flex-col gap-8">
        <TabsList aria-label="Jobs" className="-mt-2 h-auto w-full justify-start gap-1 rounded-none border-b border-border bg-transparent p-0">
          <TabsTrigger value="schedules" className={TAB_TRIGGER}>Schedules{n(crons.length)}</TabsTrigger>
          <TabsTrigger value="webhooks" className={TAB_TRIGGER}>Webhooks{n(hooks.length)}</TabsTrigger>
          <TabsTrigger value="wiki" className={TAB_TRIGGER}>Wiki notes</TabsTrigger>
        </TabsList>
        <TabsContent value="schedules" className="mt-0 flex flex-col gap-8"><Schedules state={state} /></TabsContent>
        <TabsContent value="webhooks" className="mt-0 flex flex-col gap-8"><JobsHooks state={state} /></TabsContent>
        <TabsContent value="wiki" className="mt-0 flex flex-col gap-8"><JobsWiki state={state} /></TabsContent>
      </Tabs>
    </>
  )
}

function Schedules({ state }: { state: ReturnType<typeof useWorkState> }) {
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const { run, note } = useWrite(STATE_KEY)
  const crons = state.data?.crons ?? [], sensors = state.data?.sensors ?? [], hostJobs = state.data?.hostJobs ?? []
  const add = <Button variant="outline" size="sm" onClick={() => setAdding(true)} data-row="add-schedule"><Icon name="plus" className="size-3.5" />Add schedule</Button>
  return (
    <>
      <SettingsGroup pane={PANE} row="schedules" help="Five-field cron, in this machine's time zone." action={add}>
        {state.isPending ? <SkeletonRows /> : state.isError ? (
          <ErrorLine text={`Could not read agentx.json: ${(state.error as Error).message}`} onRetry={() => state.refetch()} />
        ) : crons.length === 0 ? (
          <div className="flex items-center justify-between gap-4 py-4 text-sm text-muted-foreground">No schedules yet.{add}</div>
        ) : crons.map((c) => <CronItem key={c.id} cron={c} onDelete={() => setDeleting(c.id)} />)}
        <WriteNote note={note} />
      </SettingsGroup>
      {sensors.length > 0 && (
        <SettingsGroup pane={PANE} row="sensors" help="Built-in readers with no model. They wake an agent when a reading crosses its level.">
          {sensors.map((s) => <SensorItem key={s.id} sensor={s} />)}
        </SettingsGroup>
      )}
      {hostJobs.length > 0 && (
        <SettingsGroup pane={PANE} row="host-jobs">
          {hostJobs.map((h) => <SettingsItem key={h.label} id={"host-" + h.label} name={<span className="font-mono text-[13px]">{h.label}</span>} meta={<><span className="font-mono">@{h.owner}</span><span aria-hidden="true">·</span><span className="text-warn-ink">{h.text}</span></>} />)}
        </SettingsGroup>
      )}
      <AddScheduleDialog open={adding} onOpenChange={setAdding} agents={state.data?.agents ?? []} taken={crons.map((c) => c.id)} />
      <ConfirmDialog
        open={!!deleting} onOpenChange={(v) => !v && setDeleting(null)}
        title={`Delete ${deleting}?`} text="It stops running. The agent and its work are kept." yes="Delete schedule"
        run={() => run("DELETE", "crons", { id: deleting! }, `Deleted ${deleting}`)}
      />
    </>
  )
}

const ItemIcon = ({ name }: { name: string }) => (
  <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center self-start rounded-md border border-border bg-muted text-muted-foreground"><Icon name={name} className="size-3.5" /></span>
)
const Sep = () => <span aria-hidden="true">·</span>
const Line = ({ children, className }: { children: ReactNode; className?: string }) => <span className={cn("text-[12.5px] leading-snug text-muted-foreground [overflow-wrap:anywhere] [&_b]:font-medium [&_b]:text-foreground", className)}>{children}</span>

function CronItem({ cron: c, onDelete }: { cron: Cron; onDelete: () => void }) {
  const v = valueLine(c)
  const human = cronHuman(c.schedule)
  return (
    <SettingsItem
      id={"cron-" + c.id}
      muted={c.enabled === false}
      lead={<ItemIcon name={c.kind === "command" ? "square-terminal" : "calendar-clock"} />}
      name={<span className="font-mono text-[13px]">{c.id}</span>}
      meta={<span className="flex w-full min-w-0 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-x-1.5">
          <code className="rounded-sm bg-muted px-1.5 font-mono text-[11.5px] text-foreground">{c.schedule}</code>
          {human && <span>{human}</span>}<Sep /><span>runs <span className="font-mono">@{c.agent}</span></span>
          {c.enabled === false && <><Sep /><span>off</span></>}
        </span>
        {c.prompt && <span className={cn("text-foreground [overflow-wrap:anywhere]", c.kind === "command" ? "font-mono text-xs" : "text-[13px]")}>{c.prompt}</span>}
        {(v.why || v.goal || v.missing.length > 0) && (
          <Line>
            {v.why && <>Why: {v.why} · Proves it: <b>{v.metric}</b></>}
            {v.goal && <>{v.why ? " · " : ""}Goal: <b>{v.goal}</b></>}
            {v.missing.length > 0 && <span className="text-warn-ink">{v.why || v.goal ? " · " : ""}{v.missing.join(" · ")}</span>}
          </Line>
        )}
        {c.lastVerdict && <Line>Owner says: {c.lastVerdict.text} <Ago iso={c.lastVerdict.at} /></Line>}
        {c.endedAt ? <Line>Ended <Ago iso={c.endedAt} /></Line> : c.until && <Line>Ends after {new Date(c.until).toLocaleString()}</Line>}
        {c.goalLines?.map((l) => <Line key={l} className="text-warn-ink">{l}</Line>)}
        {!!c.changes?.length && (
          <InlineFold label={`Change log (${c.changes.length})`}>
            <ul className="flex flex-col gap-1.5 text-[12.5px]">
              {c.changes.map((r, i) => (
                <li key={i} className="[overflow-wrap:anywhere]">
                  <Ago iso={r.at} /> <b className="font-medium text-foreground">{r.field}</b> by @{r.by}
                  {(r.old != null || r.new != null) && <>: <code className="font-mono">{String(r.old ?? "—").slice(0, 80)}</code> → <code className="font-mono">{String(r.new ?? "—").slice(0, 80)}</code></>}
                  {r.reason && <> · {r.reason}</>}
                </li>
              ))}
            </ul>
          </InlineFold>
        )}
      </span>}
      menu={<RowMenu label={c.id} items={[{ label: "Delete schedule", icon: "trash-2", destructive: true, onSelect: onDelete }]} />}
    />
  )
}

function SensorItem({ sensor: s }: { sensor: Sensor }) {
  return (
    <SettingsItem
      id={"sensor-" + s.id}
      lead={<ItemIcon name="gauge" />}
      name={<span className="font-mono text-[13px]">{s.id}</span>}
      meta={<span className="flex w-full min-w-0 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-x-1.5">
          <span>Reads {s.reading} every {s.every}</span><Sep />
          <span>{s.targets.length ? <>wakes {s.targets.map((t, i) => <span key={t} className="font-mono">{i ? ", " : ""}@{t}</span>)}</> : "wakes nobody"}</span>
        </span>
        <Line>Last reading: <b>{s.last || "none yet"}</b>{s.lastAt != null && <> <Ago iso={new Date(s.lastAt).toISOString()} /></>}</Line>
        {s.wakes.length > 0 && (
          <InlineFold label={`Wakes (${s.wakes.length})`}>
            <ul className="flex flex-col gap-1.5 text-[12.5px]">
              {s.wakes.map((w, i) => <li key={i}><Ago iso={w.at} /> {w.level} → @{w.target} · {w.reading}{w.ok ? "" : " · " + (w.error || "failed")}</li>)}
            </ul>
          </InlineFold>
        )}
      </span>}
    />
  )
}
