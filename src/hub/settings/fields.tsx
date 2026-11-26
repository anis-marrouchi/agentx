// --- Settings: the controls the Work panes share (#2101 ST2b) ---
//
// A write with its one status line, the number and text fields that save
// when you leave them (Enter or blur), a list of chips, a row's `…` menu,
// a confirm dialog and a copy button. Every save goes through the old
// Settings' endpoints (/api/admin/wall/settings/*), so the owner guard holds.
import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query"
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { apiFetch, apiGet } from "../api"
import {
  Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Icon,
  Popover, PopoverContent, PopoverTrigger, Tooltip, TooltipContent, TooltipTrigger, cn,
} from "../ui"
import type { WorkState } from "./work-data"

export const SETTINGS_API = "/api/admin/wall/settings/"

/** agentx.json as /api/admin/state shows it; General reads the same key. */
export const STATE_KEY = ["settings", "state"] as const
export function useWorkState() {
  return useQuery({ queryKey: STATE_KEY, queryFn: () => apiGet<WorkState>("/api/admin/state") })
}

export type Note = { tone: "ok" | "err"; text: string } | null

/** One write and its status line. `done` is what the line says after a
 *  real save; the server's summary when there is none. */
export function useWrite(invalidate: QueryKey) {
  const client = useQueryClient()
  const [note, setNote] = useState<Note>(null)
  const m = useMutation({
    mutationFn: (v: { method: string; path: string; body: unknown; done?: string }) =>
      apiFetch<{ summary?: string }>(SETTINGS_API + v.path, { method: v.method, body: JSON.stringify(v.body), headers: { "Content-Type": "application/json" } }),
    onSuccess: (r, v) => {
      setNote({ tone: "ok", text: v.done ?? r?.summary ?? "Saved" })
      return client.invalidateQueries({ queryKey: invalidate })
    },
    onError: (e) => setNote({ tone: "err", text: "Not saved: " + (e as Error).message }),
  })
  const write = (method: string, path: string, body: unknown, done?: string) =>
    m.mutateAsync({ method, path, body, done }).then(() => true, () => false)
  return { write, busy: m.isPending, note, setNote }
}

export function WriteNote({ note }: { note: Note }) {
  if (!note) return null
  return <p role="status" className={cn("py-2.5 text-xs", note.tone === "err" ? "text-destructive" : "text-muted-foreground")}>{note.text}</p>
}

export const inputClass =
  "h-8 rounded-md border border-input bg-background px-2.5 text-base md:text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[invalid=true]:border-destructive disabled:opacity-50"

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

/** A number with its unit. `check` returns why a value is refused. */
export function NumberField({ value, unit, label, check, onCommit, disabled, step }: {
  value: number | undefined; unit?: string; label: string; check?: (n: number) => string | null
  onCommit: (n: number) => void; disabled?: boolean; step?: string
}) {
  const [bad, setBad] = useState("")
  const f = useCommit(value == null ? "" : String(value), (t) => {
    const n = Number(t)
    const why = t.trim() === "" || !Number.isFinite(n) ? "Type a number." : check?.(n) ?? null
    setBad(why ?? "")
    if (!why) onCommit(n)
  })
  return (
    <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
      <input
        {...f} inputMode={step ? "decimal" : "numeric"} aria-label={label} aria-invalid={!!bad} title={bad || undefined} disabled={disabled}
        className={cn(inputClass, "w-16 text-right tabular-nums")}
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
  return <input {...f} aria-label={label} placeholder={placeholder} disabled={disabled} autoComplete="off" spellCheck={false} className={cn(inputClass, "w-[200px] max-w-full", mono && "font-mono", className)} />
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
          className={cn(inputClass, "h-6 w-36 px-2 text-xs md:text-xs", mono && "font-mono")}
        />
      ) : addLabel !== false && (
        <button type="button" disabled={disabled} onClick={() => setAdding(true)} className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-md border border-dashed border-border px-2 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Icon name="plus" className="size-3" />{addLabel}
        </button>
      )}
    </div>
  )
}

export interface MenuItem { label: string; icon: string; onSelect: () => void; destructive?: boolean }

/** A row's `…` menu: the rare actions of one item. */
export function RowMenu({ name, items }: { name: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" className="size-7" aria-label={`More actions for ${name}`}><Icon name="ellipsis" className="size-3.5" /></Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>More actions</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-48 p-1" role="menu" aria-label={`Actions for ${name}`}>
        {items.map((it, i) => (
          <button
            key={it.label} type="button" role="menuitem"
            onClick={() => { setOpen(false); it.onSelect() }}
            className={cn(
              "flex h-8 w-full cursor-pointer items-center gap-2 rounded-sm px-2 text-[13px] hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
              it.destructive && "text-destructive", it.destructive && i > 0 && "mt-1 border-t border-border pt-1",
            )}
          >
            <Icon name={it.icon} className="size-3.5" />{it.label}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

/** Ask before a destructive step: Cancel quiet, the action red. */
export function ConfirmDialog({ open, onOpenChange, title, body, action, busy, onConfirm }: {
  open: boolean; onOpenChange: (v: boolean) => void; title: string; body: ReactNode; action: string; busy?: boolean; onConfirm: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{body}</DialogDescription></DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="destructive" disabled={busy} onClick={onConfirm}>{action}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
