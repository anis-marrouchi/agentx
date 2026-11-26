// --- Settings › Jobs › Wiki notes (#2101 ST2b) ---
//
// The old Schedules tab's wiki notes inbox: agents leave short notes for
// the agent that runs the wiki schedule. Same as `agentx wiki notes
// config`; each change saves at once (POST wiki-notes). The recent notes
// are a read (GET /api/admin/wiki-notes/list).
import { useQuery } from "@tanstack/react-query"
import { apiGet } from "../api"
import { Badge, Button, Icon, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch } from "../ui"
import { NumberField, STATE_KEY, WriteNote, type useWorkState, useWrite } from "./fields"
import { Disclosure, ErrorLine, SettingsGroup, SettingsItem, SettingsRow, SkeletonRows } from "./parts"
import type { WikiNote, WikiNotes } from "./work-data"

const PANE = "jobs"
const NONE = "__none"
export const NOTES_KEY = ["settings", "wiki-notes"] as const

const TONE: Record<string, "warn" | "ok" | "secondary"> = { open: "warn", deferred: "warn", patched: "ok" }

export default function JobsWiki({ state }: { state: ReturnType<typeof useWorkState> }) {
  const { write, busy, note } = useWrite(STATE_KEY)
  const n: WikiNotes = state.data?.wikiNotes ?? { enabled: false, inbox: "", crons: [], absorbAgent: "", maxNotesPerRun: 20, maxDeferrals: 3 }
  const agents = state.data?.agents ?? [], crons = state.data?.crons ?? []
  const off = !state.data || busy
  const save = (patch: Partial<WikiNotes>) => write("POST", "wiki-notes", patch)
  const agentSelect = (value: string, label: string, onChange: (v: string) => void) => (
    <Select value={value || NONE} disabled={off} onValueChange={(v) => onChange(v === NONE ? "" : v)}>
      <SelectTrigger className="w-[180px] font-mono" aria-label={label}><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>None</SelectItem>
        {agents.map((a) => <SelectItem key={a.id} value={a.id} className="font-mono">@{a.id}</SelectItem>)}
      </SelectContent>
    </Select>
  )
  return (
    <>
      <SettingsGroup pane={PANE} title="Wiki notes inbox" help="Agents leave short notes for the agent that runs your wiki schedule.">
        <SettingsRow pane={PANE} row="wn-on" control={<Switch checked={n.enabled} disabled={off} onCheckedChange={(v) => save({ enabled: v })} aria-label="Wiki notes on" />} />
        <SettingsRow pane={PANE} row="wn-inbox" control={agentSelect(n.inbox, "Inbox agent", (v) => save({ inbox: v }))} />
        <SettingsRow pane={PANE} row="wn-absorb" control={agentSelect(n.absorbAgent, "Absorb agent", (v) => save({ absorbAgent: v }))} />
        <SettingsRow
          pane={PANE} row="wn-crons" layout="stack"
          control={crons.length ? crons.map((c) => {
            const on = n.crons.includes(c.id)
            return (
              <label key={c.id} className="flex h-8 cursor-pointer items-center gap-2 rounded-md border border-border px-2.5 text-[13px] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
                <input type="checkbox" checked={on} disabled={off} className="size-3.5 accent-foreground"
                  onChange={() => save({ crons: on ? n.crons.filter((x) => x !== c.id) : [...n.crons, c.id] })} />
                <span className="font-mono">{c.id}</span><span className="text-xs text-muted-foreground">@{c.agent}</span>
              </label>
            )
          }) : <span className="text-[12.5px] text-muted-foreground">No schedules on this machine.</span>}
        />
        <Disclosure id="wn-adv" label="Advanced">
          <SettingsRow pane={PANE} row="wn-max" control={<NumberField value={n.maxNotesPerRun} label="Most notes per run" disabled={off} check={(v) => Number.isInteger(v) && v >= 1 && v <= 100 ? null : "1 to 100."} onCommit={(v) => save({ maxNotesPerRun: v })} />} />
          <SettingsRow pane={PANE} row="wn-defer" control={<NumberField value={n.maxDeferrals} label="Deferrals before a note expires" disabled={off} check={(v) => Number.isInteger(v) && v >= 1 && v <= 20 ? null : "1 to 20."} onCommit={(v) => save({ maxDeferrals: v })} />} />
        </Disclosure>
        <WriteNote note={note} />
      </SettingsGroup>
      <RecentNotes />
    </>
  )
}

function RecentNotes() {
  const list = useQuery({ queryKey: NOTES_KEY, queryFn: () => apiGet<{ notes?: WikiNote[] }>("/api/admin/wiki-notes/list") })
  const notes = list.data?.notes ?? []
  return (
    <SettingsGroup
      pane={PANE} row="wn-recent"
      action={<Button variant="ghost" size="sm" disabled={list.isFetching} onClick={() => list.refetch()}><Icon name="refresh-cw" className="size-3.5" />Refresh</Button>}
    >
      {list.isPending ? <SkeletonRows /> : list.isError ? (
        <ErrorLine text={`Could not read the notes: ${(list.error as Error).message}`} onRetry={() => list.refetch()} />
      ) : notes.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">No notes on this machine.</p>
      ) : notes.map((x) => (
        <SettingsItem
          key={x.id} id={"note-" + x.id}
          name={<span className="flex items-center gap-2"><Badge variant={TONE[x.status] ?? "secondary"}>{x.status}</Badge><span className="font-mono text-xs font-normal text-muted-foreground">{x.id}</span></span>}
          meta={<span className="flex w-full min-w-0 flex-col gap-1">
            <span className="text-[13px] text-foreground [overflow-wrap:anywhere]">{x.change}</span>
            <span>from <span className="font-mono">{x.from}</span> · {x.date}{x.handled && <> · {x.handled.outcome} by <span className="font-mono">{x.handled.by}</span>: {x.handled.reason}</>}</span>
          </span>}
        />
      ))}
    </SettingsGroup>
  )
}
