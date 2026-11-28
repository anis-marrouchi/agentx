// --- Settings › Machine (#2101 ST3b) ---
//
// The mock's Machine (settings-mock/full/machine.html): screen capture with
// its rare tuning under Advanced, the recent frames buffer, and agentx.json
// itself. Each screen field saves on its own as a partial patch (POST
// …/screen, as `agentx screen config`; the daemon applies it without a
// restart). agentx.json is read with its secrets hidden (GET
// /api/admin/config/hidden) and saved whole with a backup (POST
// …/config/raw), as the old Advanced section.
import { useQuery } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { apiGet } from "../api"
import { Button, Icon, Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue, Switch, cn } from "../ui"
import { NumberField, STATE_KEY, WriteNote, useWorkState, useWrite, type Note } from "./fields"
import { Disclosure, ErrorLine, INPUT, PaneHeader, SettingsGroup, SettingsRow, SkeletonRows } from "./parts"
import { paneDef, rowDef } from "./panes"
import { BUILT_IN_REGIONS, kb, regionsPatch, regionsText, type ScreenState, type SystemState } from "./system-data"

const PANE = "machine"
const TEXTAREA = cn(INPUT, "h-auto w-full py-2 font-mono leading-6")
const CONFIG_KEY = ["settings", "config"] as const

type Key = "maxPixels" | "intervalMs" | "changeThreshold" | "stableMs" | "timeoutMs" | "seconds" | "fps"
const within = (lo: number, hi?: number) => (v: number) => (v < lo || (hi != null && v > hi) ? (hi != null ? `Use ${lo} to ${hi}.` : `Use ${lo} or more.`) : null)

export default function MachinePane() {
  const state = useWorkState()
  const w = useWrite(STATE_KEY)
  const sc = (state.data as SystemState | undefined)?.screen
  const b = sc?.buffer ?? {}
  const off = !sc || w.busy
  const put = (patch: Record<string, unknown>) => w.write("POST", "screen", patch, "Saved. It applies without a restart.")
  const n = (row: string, key: Key, o: { unit?: string; lo: number; hi?: number; step?: string; grouped?: boolean; buffer?: boolean }) => (
    <SettingsRow
      pane={PANE} row={row}
      control={<NumberField
        label={rowDef(PANE, row).label} unit={o.unit} check={within(o.lo, o.hi)} step={o.step} grouped={o.grouped} disabled={off}
        value={(o.buffer ? (b as Record<string, number | undefined>) : (sc as Record<string, number | undefined> | undefined) ?? {})[key]}
        onCommit={(v) => put(o.buffer ? { buffer: { [key]: v } } : { [key]: v })}
      />}
    />
  )

  return (
    <>
      <PaneHeader pane={paneDef(PANE)} />
      <div className="flex flex-col gap-8">
        <SettingsGroup pane={PANE} row="screen">
          {state.isPending ? <SkeletonRows /> : state.isError ? (
            <ErrorLine text={`Could not read agentx.json: ${(state.error as Error).message}`} onRetry={() => state.refetch()} />
          ) : <>
            {n("sc-pixels", "maxPixels", { unit: "px", lo: 1, grouped: true })}
            {n("sc-interval", "intervalMs", { unit: "ms", lo: 1 })}
            <Regions screen={sc} disabled={off} onSave={(regions) => put({ regions })} onRefused={(text) => w.setNote({ tone: "err", text })} />
            <Disclosure id="screen-advanced" label="Advanced">
              {n("sc-threshold", "changeThreshold", { lo: 0, hi: 1, step: "0.001" })}
              {n("sc-stable", "stableMs", { unit: "ms", lo: 0 })}
              {n("sc-timeout", "timeoutMs", { unit: "ms", lo: 1, grouped: true })}
            </Disclosure>
            <WriteNote note={w.note} />
          </>}
        </SettingsGroup>

        <SettingsGroup pane={PANE} row="frames">
          {/* Loading and read error, as the Screen capture group above (Hakim, review of #2450, F3). */}
          {state.isPending ? <SkeletonRows /> : state.isError ? (
            <ErrorLine text={`Could not read agentx.json: ${(state.error as Error).message}`} onRetry={() => state.refetch()} />
          ) : <>
            <SettingsRow
              pane={PANE} row="fb-on"
              control={<Switch checked={!!b.enabled} disabled={off} onCheckedChange={(v) => put({ buffer: { enabled: v } })} aria-label="Keep recent frames" />}
            />
            <SettingsRow pane={PANE} row="fb-region" control={<RegionSelect value={b.region || "screen"} named={Object.keys(sc?.regions ?? {})} disabled={off} onChange={(region) => put({ buffer: { region } })} />} />
            {n("fb-seconds", "seconds", { unit: "s", lo: 1, hi: 120, buffer: true })}
            {n("fb-fps", "fps", { unit: "fps", lo: 1, hi: 10, buffer: true })}
            {n("fb-pixels", "maxPixels", { unit: "px", lo: 1, grouped: true, buffer: true })}
          </>}
        </SettingsGroup>

        <ConfigFile />
      </div>
    </>
  )
}

/** The named regions, one per line; saved when the box is left. */
function Regions({ screen, disabled, onSave, onRefused }: {
  screen?: ScreenState; disabled: boolean; onSave: (r: Record<string, string | null>) => void; onRefused: (t: string) => void
}) {
  const def = rowDef(PANE, "sc-regions")
  const shown = regionsText(screen?.regions)
  const [text, setText] = useState(shown)
  const [bad, setBad] = useState(false)
  useEffect(() => { setText(shown); setBad(false) }, [shown])
  const commit = () => {
    if (text.trim() === shown.trim()) return
    const patch = regionsPatch(text, screen?.regions)
    setBad("error" in patch)
    if ("error" in patch) onRefused("Not saved: " + patch.error)
    else onSave(patch)
  }
  return (
    <SettingsRow
      pane={PANE} row="sc-regions" layout="stack"
      control={<textarea
        rows={3} spellCheck={false} aria-label={def.label} aria-invalid={bad || undefined} disabled={disabled}
        placeholder="chat=0,60,720,800" value={text} onChange={(e) => setText(e.target.value)} onBlur={commit}
        className={TEXTAREA}
      />}
    />
  )
}

function RegionSelect({ value, named, disabled, onChange }: { value: string; named: string[]; disabled: boolean; onChange: (v: string) => void }) {
  const known: string[] = [...BUILT_IN_REGIONS, ...named]
  return (
    <Select value={value} disabled={disabled} onValueChange={onChange}>
      <SelectTrigger className="h-8 w-[150px] font-mono text-[13px]" aria-label="Region"><SelectValue /></SelectTrigger>
      <SelectContent>
        {BUILT_IN_REGIONS.map((r) => <SelectItem key={r} value={r} className="font-mono">{r}</SelectItem>)}
        {named.length > 0 && <><SelectSeparator /><SelectGroup><SelectLabel>Named</SelectLabel>{named.map((r) => <SelectItem key={r} value={r} className="font-mono">{r}</SelectItem>)}</SelectGroup></>}
        {!known.includes(value) && <><SelectSeparator /><SelectItem value={value} className="font-mono">{value}</SelectItem></>}
      </SelectContent>
    </Select>
  )
}

interface Hidden { exists?: boolean; raw?: string; hidden?: number }

/** agentx.json, edited in place; secrets typed into it stay hidden. */
function ConfigFile() {
  const file = useQuery({ queryKey: CONFIG_KEY, queryFn: () => apiGet<Hidden>("/api/admin/config/hidden") })
  const w = useWrite(["settings"])
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState("")
  const raw = file.data?.raw ?? ""
  useEffect(() => { setText(raw) }, [raw])
  const say = (note: Note) => w.setNote(note)
  const save = async () => {
    try { JSON.parse(text) } catch (e) { say({ tone: "err", text: `Not saved: it is not valid JSON (${(e as Error).message}).` }); return }
    // A refused save is already on the status line (useWrite's onError).
    const r = (await w.run("POST", "config/raw", { raw: text }).catch(() => null)) as { backupPath?: string } | null
    if (!r) return
    const bak = r.backupPath?.split("/").pop()
    say({ tone: "ok", text: "Saved" + (bak ? ", with a backup in " + bak : "") + "." })
  }
  const reload = () => { say(null); void file.refetch().then((r) => setText(r.data?.raw ?? "")) }
  const h = file.data?.hidden ?? 0
  const size = file.data?.exists ? kb(raw.length) + (h ? ` · ${h} secret${h === 1 ? "" : "s"} typed into the file ${h === 1 ? "is" : "are"} hidden and kept on save.` : "") : undefined
  return (
    <>
      <SettingsGroup pane={PANE} title="agentx.json" help={rowDef(PANE, "cfg").help}>
        {file.isPending ? <SkeletonRows /> : file.isError ? (
          <ErrorLine text={`Could not read agentx.json: ${(file.error as Error).message}`} onRetry={() => file.refetch()} />
        ) : (
          <SettingsRow
            pane={PANE} row="cfg"
            label={<span className="font-mono text-[13px]">agentx.json</span>}
            help={size ?? "This machine has no agentx.json yet. Run agentx init to make one."}
            control={file.data?.exists && (
              <Button variant="outline" size="sm" onClick={() => { setEditing(!editing); say(null) }} aria-expanded={editing}>
                <Icon name={editing ? "x" : "file-pen-line"} className="size-3.5" />{editing ? "Close editor" : "Edit file"}
              </Button>
            )}
          />
        )}
        {editing && file.data?.exists && (
          <div className="flex flex-col gap-2.5 py-3">
            <textarea autoFocus rows={22} spellCheck={false} aria-label="agentx.json" value={text} onChange={(e) => setText(e.target.value)} className={TEXTAREA} />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[12.5px] text-muted-foreground">Saving keeps a backup next to the file and reloads the daemon.</span>
              <span className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={reload}>Reload from disk</Button>
                <Button size="sm" disabled={w.busy || text === raw} onClick={save}>{w.busy ? "Saving…" : "Save"}</Button>
              </span>
            </div>
          </div>
        )}
        <WriteNote note={w.note} />
      </SettingsGroup>
      <p className="-mt-5 flex items-start gap-2 px-1 text-[12.5px] text-muted-foreground">
        <Icon name="info" className="mt-0.5 size-3.5 shrink-0" />
        <span>Leave a hidden secret as it is, or put a {"${NAME}"} reference there and the secret in .env.</span>
      </p>
    </>
  )
}
