// --- Settings: small parts the list panes share (#2101 ST3a) ---
//
// What Guests, Business, Channels and WhatsApp (and General) draw the same
// way: a write through the old Settings' owner-guarded paths, the loading
// and error lines, a row's `…` menu, a copy button that turns into a check,
// a confirm step for a destructive action, form fields, and an agent shown
// as its engine logo and id. One copy each, so the panes look alike.
import { useQuery } from "@tanstack/react-query"
import { useEffect, useState, type FormEvent, type ReactNode } from "react"
import { engineIcon } from "../../daemon/ui/pages/engine-icons"
import { apiFetch, apiGet } from "../api"
import {
  Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Icon, Popover, PopoverContent, PopoverTrigger,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, Tooltip, TooltipContent, TooltipTrigger, cn,
} from "../ui"
import type { AdminState } from "./data"

/** A write; apiFetch throws with the server's error text when it fails. */
export async function save<T = { summary?: string; hint?: string }>(method: string, path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } })
}

/** agentx.json as /api/admin/state sends it (secrets as refs), shared by every pane. */
export function useAdminState<T extends AdminState = AdminState>() {
  return useQuery({ queryKey: ["settings", "state"], queryFn: () => apiGet<T>("/api/admin/state") })
}

export function EngineLogo({ tier }: { tier?: string }) {
  return <span aria-hidden="true" className="inline-flex size-3.5 shrink-0 [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: engineIcon(tier || "claude-code") }} />
}

/** One of your agents in a line: its engine's logo and its id in mono. */
export function AgentChip({ id, tier, at }: { id: string; tier?: string; at?: boolean }) {
  return <span className="inline-flex items-center gap-1.5"><EngineLogo tier={tier} /><span className="font-mono text-xs text-foreground">{at ? "@" : ""}{id}</span></span>
}

/** The square before an item: two letters, or an icon. */
export function Lead({ text, icon }: { text?: string; icon?: string }) {
  return (
    <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center self-start rounded-md border border-border bg-muted text-[11px] font-semibold text-muted-foreground">
      {icon ? <Icon name={icon} className="size-3.5" /> : text}
    </span>
  )
}

/** Parts of a meta line, split by a quiet dot. */
export function Dots({ items }: { items: ReactNode[] }) {
  const parts = items.filter((c) => c !== null && c !== undefined && c !== false && c !== "")
  return <>{parts.map((c, i) => <span key={i} className="inline-flex items-center gap-1.5">{i > 0 && <span aria-hidden="true">·</span>}{c}</span>)}</>
}

export function SkeletonRows() {
  return <div className="flex flex-col gap-3 py-4" aria-busy="true"><Skeleton className="h-5 w-2/3" /><Skeleton className="h-5 w-1/2" /><Skeleton className="h-5 w-3/5" /></div>
}

export function ErrorLine({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex items-center justify-between gap-4 py-3 text-sm">
      <span className="text-destructive">{text}</span>
      <Button variant="outline" size="sm" onClick={onRetry}>Retry</Button>
    </div>
  )
}

/** The answer to the last change, kept inline under its group. */
export type Note = { tone: "ok" | "err"; text: string } | null
export function NoteLine({ note }: { note: Note }) {
  if (!note) return null
  return <p role="status" className={cn("py-2.5 text-xs", note.tone === "err" ? "text-destructive" : "text-muted-foreground")}>{note.text}</p>
}

/** A quiet icon button with its tooltip and sr-only name (C14). */
export function IconButton({ icon, label, onClick, disabled }: { icon: string; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" aria-label={label} onClick={onClick} disabled={disabled}><Icon name={icon} className="size-3.5" /></Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** Copies a text; the icon turns into a check for 2 s (orca-design A6). */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false)
  useEffect(() => { if (!done) return; const t = window.setTimeout(() => setDone(false), 2000); return () => window.clearTimeout(t) }, [done])
  return <IconButton icon={done ? "check" : "copy"} label={done ? "Copied" : label} onClick={() => { void navigator.clipboard?.writeText(text); setDone(true) }} />
}

export interface MenuAction { label: string; icon: string; onSelect: () => void; destructive?: boolean }

/** A row's `…` menu (rare actions, principle 3). SettingsItem shows it on
 *  hover or focus with a pointer, always on touch. */
export function RowMenu({ name, items }: { name: string; items: MenuAction[] }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" aria-label={"More actions for " + name}><Icon name="ellipsis" className="size-3.5" /></Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>More actions</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-52 p-1" role="menu">
        {items.map((m, i) => (
          <div key={m.label}>
            {m.destructive && i > 0 && <div role="separator" className="-mx-1 my-1 h-px bg-border" />}
            <button
              type="button" role="menuitem"
              onClick={() => { setOpen(false); m.onSelect() }}
              className={cn("flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[13px] hover:bg-accent focus-visible:bg-accent focus-visible:outline-none", m.destructive && "text-destructive")}
            >
              <Icon name={m.icon} className="size-3.5" />{m.label}
            </button>
          </div>
        ))}
      </PopoverContent>
    </Popover>
  )
}

export interface ConfirmSpec { title: string; text: ReactNode; yes: string; run: () => Promise<unknown> }

/** The confirm step for something that cannot be undone. Cancel is quiet,
 *  the action is the one destructive button; the error stays in the dialog. */
export function ConfirmDialog({ spec, onClose }: { spec: ConfirmSpec | null; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  useEffect(() => { setError(""); setBusy(false) }, [spec])
  const go = async () => {
    if (!spec) return
    setBusy(true); setError("")
    try { await spec.run(); onClose() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <Dialog open={!!spec} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{spec?.title}</DialogTitle>
          <DialogDescription>{spec?.text}</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="text-xs text-destructive">Not done: {error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" disabled={busy} onClick={go}>{busy ? "Working…" : spec?.yes}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export const inputClass = "h-9 w-full rounded-md border border-input bg-background px-3 text-base md:text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[invalid=true]:border-destructive"

/** A labelled field with one line of help under it. */
export function Field({ label, help, children, className }: { label: string; help?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn("flex min-w-0 flex-col gap-1 text-sm", className)}>
      {label}
      {children}
      {help && <span className="text-xs text-muted-foreground">{help}</span>}
    </label>
  )
}

const NONE = "__none"

/** Pick one of your agents; `none` adds an empty choice with that label. */
export function AgentSelect({ value, onChange, agents, none, label, className }: {
  value: string; onChange: (v: string) => void; agents: { id: string; name?: string }[]; none?: string; label: string; className?: string
}) {
  return (
    <Select value={value || (none ? NONE : undefined)} onValueChange={(v) => onChange(v === NONE ? "" : v)}>
      <SelectTrigger className={cn("h-9 w-full", className)} aria-label={label}><SelectValue placeholder="Choose an agent" /></SelectTrigger>
      <SelectContent>
        {none && <SelectItem value={NONE}>{none}</SelectItem>}
        {agents.map((a) => <SelectItem key={a.id} value={a.id}><span className="font-mono text-xs">@{a.id}</span></SelectItem>)}
      </SelectContent>
    </Select>
  )
}

/** A `${NAME}` reference in agentx.json → NAME, for the edit fields; empty for a literal. */
export function envName(ref: unknown): string {
  return typeof ref === "string" ? ref.replace(/^\$\{|\}$/g, "") : ""
}
/** agentx.json holds the secret itself (`{ literal: true }`, never sent). */
export const isLiteral = (ref: unknown) => !!ref && typeof ref === "object"
/** A .env variable name, not a token pasted by mistake. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** One relative time format (orca-design C17): `now`, `2m`, `1h`, `2d`. */
export function relTime(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return "now"
  if (s < 3600) return Math.floor(s / 60) + "m"
  if (s < 86400) return Math.floor(s / 3600) + "h"
  return Math.floor(s / 86400) + "d"
}

/** What a form's submit says back: a field and its sentence, or nothing. */
export type Invalid = { field?: string; text: string } | void

/** A form in a dialog: the fields, a collapsed Advanced for rare ones, the
 *  error under them, a quiet Cancel and the one primary button. `onSubmit`
 *  returns a validation error, or throws the server's; it closes on success. */
export function FormDialog({ open, onOpenChange, title, description, submit, onSubmit, advanced, footNote, children }: {
  open: boolean; onOpenChange: (v: boolean) => void; title: string; description?: ReactNode; submit: string
  onSubmit: () => Promise<Invalid> | Invalid; advanced?: ReactNode; footNote?: ReactNode; children: ReactNode
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Invalid>(undefined)
  const [more, setMore] = useState(false)
  useEffect(() => { if (open) { setError(undefined); setBusy(false); setMore(false) } }, [open])
  const go = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true); setError(undefined)
    try {
      const bad = await onSubmit()
      if (bad) setError(bad)
      else onOpenChange(false)
    } catch (err) { setError({ text: "Not saved: " + (err as Error).message }) } finally { setBusy(false) }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <form onSubmit={go} noValidate className="flex flex-col gap-3" data-invalid={error?.field}>
          {children}
          {advanced && (
            <div className="border-t border-border pt-1">
              <button type="button" aria-expanded={more} onClick={() => setMore(!more)} className="flex min-h-9 w-full cursor-pointer items-center gap-2 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <Icon name="chevron-right" className={cn("size-3.5 text-muted-foreground transition-transform duration-150 ease-out motion-reduce:transition-none", more && "rotate-90")} />
                Advanced
              </button>
              <div hidden={!more} className="flex flex-col gap-3 pb-1 pl-5">{advanced}</div>
            </div>
          )}
          {error ? <p role="alert" className="text-xs text-destructive">{error.text}</p> : null}
          <DialogFooter className="items-center">
            {footNote && <span className="mr-auto text-xs text-muted-foreground">{footNote}</span>}
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? "Saving…" : submit}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Two fields side by side from 640 px. */
export function FieldRow({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{children}</div>
}
