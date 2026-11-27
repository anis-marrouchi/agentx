// --- Settings: the controls the Work panes share (#2101 ST2b) ---
//
// A write with its one status line, the number and text fields that save
// when you leave them (Enter or blur), a list of chips and a copy button.
// The row's `…` menu, the confirm dialog and the input class are the ones
// in parts.tsx, so every pane draws them alike. Every save goes through the old
// Settings' endpoints (/api/admin/wall/settings/*), so the owner guard holds.
import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query"
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { apiFetch, apiGet } from "../api"
import { Button, Icon, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Tooltip, TooltipContent, TooltipTrigger, cn } from "../ui"
import { INPUT } from "./parts"
import type { WorkState } from "./work-data"

export const SETTINGS_API = "/api/admin/wall/settings/"

/** agentx.json as /api/admin/state shows it; General reads the same key. */
export const STATE_KEY = ["settings", "state"] as const
export function useWorkState() {
  return useQuery({ queryKey: STATE_KEY, queryFn: () => apiGet<WorkState>("/api/admin/state") })
}

export type Note = { tone: "ok" | "err"; text: string } | null

/** A write a dialog or a row is handed: `useWrite`'s `write` or `run`. */
export type Send = (method: string, path: string, body: unknown, done?: string) => Promise<unknown>

/** One write and its status line. `done` is what the line says after a
 *  real save; the server's summary (and hint) when there is none. */
export function useWrite(invalidate: QueryKey) {
  const client = useQueryClient()
  const [note, setNote] = useState<Note>(null)
  const m = useMutation({
    mutationFn: (v: { method: string; path: string; body: unknown; done?: string }) =>
      apiFetch<{ summary?: string; hint?: string }>(SETTINGS_API + v.path, { method: v.method, body: JSON.stringify(v.body), headers: { "Content-Type": "application/json" } }),
    onSuccess: (r, v) => {
      setNote({ tone: "ok", text: v.done ?? ([r?.summary, r?.hint].filter(Boolean).join(" ") || "Saved") })
      return client.invalidateQueries({ queryKey: invalidate })
    },
    onError: (e) => setNote({ tone: "err", text: "Not saved: " + (e as Error).message }),
  })
  const write = (method: string, path: string, body: unknown, done?: string) =>
    m.mutateAsync({ method, path, body, done }).then(() => true, () => false)
  /** The same write for a ConfirmDialog's `run`: it throws, so the dialog
   *  stays open with the server's reason. It hands back the server's reply
   *  (a new token, shown once). */
  const run = (method: string, path: string, body: unknown, done?: string) =>
    m.mutateAsync({ method, path, body, done })
  return { write, run, busy: m.isPending, note, setNote }
}

export function WriteNote({ note }: { note: Note }) {
  if (!note) return null
  return <p role="status" className={cn("py-2.5 text-xs", note.tone === "err" ? "text-destructive" : "text-muted-foreground")}>{note.text}</p>
}

/** Leave the field (Enter or blur) to save; Esc puts the saved value back. */
function useCommit(value: string, commit: (v: string) => void) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const done = () => { if (text !== value) commit(text) }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur() }
    else if (e.key === "Escape" && text !== value) { e.preventDefault(); e.stopPropagation(); setText(value) }
  }
  return { value: text, onChange: (e: { target: { value: string } }) => setText(e.target.value), onBlur: done, onKeyDown }
}

/** A number with its unit. `check` returns why a value is refused.
 *  `grouped` shows thousands with commas in a wider box (a pixel budget). */
export function NumberField({ value, unit, label, check, onCommit, disabled, step, grouped }: {
  value: number | undefined; unit?: string; label: string; check?: (n: number) => string | null
  onCommit: (n: number) => void; disabled?: boolean; step?: string; grouped?: boolean
}) {
  const [bad, setBad] = useState("")
  const f = useCommit(value == null ? "" : grouped ? value.toLocaleString("en-US") : String(value), (t) => {
    const n = Number(grouped ? t.replace(/[,\s]/g, "") : t)
    const why = t.trim() === "" || !Number.isFinite(n) ? "Type a number." : check?.(n) ?? null
    setBad(why ?? "")
    if (!why) onCommit(n)
  })
  return (
    <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
      <input
        {...f} inputMode={step ? "decimal" : "numeric"} aria-label={label} aria-invalid={!!bad} title={bad || undefined} disabled={disabled}
        className={cn(INPUT, grouped ? "w-24" : "w-16", "text-right tabular-nums")}
      />
      {unit}
    </span>
  )
}

/** A text field that saves when you leave it. */
export function TextField({ value, label, placeholder, onCommit, mono, disabled, className }: {
  value: string; label: string; placeholder?: string; onCommit: (v: string) => void; mono?: boolean; disabled?: boolean; className?: string
}) {
  const f = useCommit(value, (t) => onCommit(t.trim()))
  return <input {...f} aria-label={label} placeholder={placeholder} disabled={disabled} autoComplete="off" spellCheck={false} className={cn(INPUT, "w-[200px] max-w-full", mono && "font-mono", className)} />
}

/** A list as chips: x removes one, Add opens a field (Enter adds, Esc closes). */
export function ChipList({ values, label, onChange, addLabel = "Add", mono = true, disabled }: {
  values: readonly string[]; label: string; onChange: (next: string[]) => void; mono?: boolean; disabled?: boolean
  /** false: remove only (the list is added to elsewhere). */
  addLabel?: string | false
}) {
  const [adding, setAdding] = useState(false)
  const [text, setText] = useState("")
  const add = () => {
    const v = text.trim()
    setText(""); setAdding(false)
    if (v && !values.includes(v)) onChange([...values, v])
  }
  return (
    <div data-slot="chip-list" role="group" aria-label={label} className="flex flex-wrap items-center gap-1.5">
      {values.map((v) => (
        <span key={v} className={cn("inline-flex h-6 items-center gap-1 rounded-md border border-border bg-muted/60 pl-2 pr-0.5 text-xs", mono && "font-mono")}>
          {v}
          <button type="button" disabled={disabled} aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))} className="flex size-5 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Icon name="x" className="size-3" />
          </button>
        </span>
      ))}
      {adding ? (
        <input
          autoFocus value={text} onChange={(e) => setText(e.target.value)} onBlur={add} aria-label={`${addLabel}: ${label}`}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add() } else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setText(""); setAdding(false) } }}
          className={cn(INPUT, "h-6 w-36 px-2 text-xs md:text-xs", mono && "font-mono")}
        />
      ) : addLabel !== false && (
        <button type="button" disabled={disabled} onClick={() => setAdding(true)} className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-md border border-dashed border-border px-2 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Icon name="plus" className="size-3" />{addLabel}
        </button>
      )}
    </div>
  )
}

/** Copy a value; the icon turns into a check for 2 s (orca-design A6). */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false)
  const t = useRef<number>(0)
  useEffect(() => () => window.clearTimeout(t.current), [])
  const copy = () => navigator.clipboard?.writeText(text).then(() => {
    setDone(true); window.clearTimeout(t.current); t.current = window.setTimeout(() => setDone(false), 2000)
  })
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className="size-6" aria-label={label} onClick={copy}><Icon name={done ? "check" : "copy"} className="size-3.5" /></Button>
      </TooltipTrigger>
      <TooltipContent>{done ? "Copied" : label}</TooltipContent>
    </Tooltip>
  )
}

/** A fold inside an item (a change log, the wakes): closed until asked. */
export function InlineFold({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-1">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-sm text-[12.5px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Icon name="chevron-right" className={cn("size-3.5 transition-transform duration-150 ease-out motion-reduce:transition-none", open && "rotate-90")} />{label}
      </button>
      {open && <div className="mt-1.5 pl-[18px]">{children}</div>}
    </div>
  )
}

/** A labelled field in a dialog, with one line of help under it. */
export function Field({ label, help, children }: { label: string; help?: ReactNode; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-sm">
      {label}{children}
      {help && <span className="text-xs text-muted-foreground">{help}</span>}
    </label>
  )
}

/** Two fields side by side from 640 px. */
export function FieldRow({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{children}</div>
}

/** A dialog's text field: full width, `h-9`. */
export const dialogInput = cn(INPUT, "h-9 w-full")

const EMPTY = "__none"
export interface ChoiceOption { value: string; label: ReactNode }

/** One pick from a short list. An empty value is a real choice here
 *  ("None", "No one"), which Radix does not allow, so it travels as a
 *  placeholder value. In a dialog, put it in a Field. */
export function Choice({ label, value, onChange, options, className, disabled }: {
  label: string; value: string; onChange: (v: string) => void; options: ChoiceOption[]; className?: string; disabled?: boolean
}) {
  return (
    <Select value={value || EMPTY} disabled={disabled} onValueChange={(v) => onChange(v === EMPTY ? "" : v)}>
      <SelectTrigger className={cn("h-9 w-full", className)} aria-label={label}><SelectValue /></SelectTrigger>
      <SelectContent>
        {options.map((o) => <SelectItem key={o.value || EMPTY} value={o.value || EMPTY}>{o.label}</SelectItem>)}
      </SelectContent>
    </Select>
  )
}

/** Pick one of your agents (`@id` in mono); `none` adds an empty choice. */
export function AgentSelect({ agents, none, ...props }: Omit<Parameters<typeof Choice>[0], "options"> & { agents: readonly { id: string }[]; none?: string }) {
  const options: ChoiceOption[] = [
    ...(none !== undefined ? [{ value: "", label: none }] : []),
    ...agents.map((a) => ({ value: a.id, label: <span className="font-mono text-xs">@{a.id}</span> })),
  ]
  return <Choice {...props} options={options} />
}
