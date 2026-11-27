// --- Settings: the dialogs every pane uses (#2101 ST3 review C1) ---
//
// The confirm step before a destructive action and the form dialog for
// adding or editing a row. Split out of parts.tsx, which re-exports them,
// so panes keep one import.
import { useEffect, useState, type FormEvent, type ReactNode } from "react"
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Icon, cn } from "../ui"

/** Yes or no before a destructive step: Cancel quiet, the step named on
 *  the button. `run` throws to keep the dialog open with its error. */
export function ConfirmDialog({ open, onOpenChange, title, text, yes, run }: {
  open: boolean; onOpenChange: (v: boolean) => void; title: string; text: ReactNode; yes: string; run: () => Promise<unknown>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const close = (v: boolean) => { onOpenChange(v); if (!v) setError("") }
  const go = async () => {
    setBusy(true)
    try { await run(); close(false) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{text}</DialogDescription></DialogHeader>
        {error && <p role="alert" className="text-xs text-destructive">Not done: {error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={() => close(false)}>Cancel</Button>
          <Button variant="destructive" disabled={busy} onClick={go}>{yes}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export interface ConfirmSpec { title: string; text: ReactNode; yes: string; run: () => Promise<unknown> }

/** A pane's one confirm step: `ask` opens it, `dialog` goes anywhere in the pane. */
export function useConfirm(): { ask: (s: ConfirmSpec) => void; dialog: ReactNode } {
  const [spec, setSpec] = useState<ConfirmSpec | null>(null)
  const dialog = spec && <ConfirmDialog open onOpenChange={(v) => { if (!v) setSpec(null) }} title={spec.title} text={spec.text} yes={spec.yes} run={spec.run} />
  return { ask: setSpec, dialog }
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
          {error?.text ? <p role="alert" className="text-xs text-destructive">{error.text}</p> : null}
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
