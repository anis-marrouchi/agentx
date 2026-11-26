// --- Settings › Jobs: Add schedule and Add webhook (#2101 ST2b) ---
//
// The old Settings' two add forms as dialogs, with its calls: POST crons
// (and crons/preview for the next runs, as you type) and POST webhooks.
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState, type FormEvent, type ReactNode } from "react"
import { apiFetch } from "../api"
import {
  Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue, cn,
} from "../ui"
import type { StateAgent } from "./data"
import { SETTINGS_API, inputClass } from "./fields"
import { CRON_PRESETS, ENV_NAME, WEBHOOK_SOURCES } from "./work-data"

const ID = /^[a-z0-9][a-z0-9_-]*$/
const field = cn(inputClass, "h-9 w-full")

const post = (path: string, body: unknown) =>
  apiFetch<{ summary?: string; human?: string; next?: string[]; timezone?: string }>(SETTINGS_API + path, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } })

/** A form in a dialog: the error under it, Cancel quiet, one primary. */
function FormDialog({ open, onOpenChange, title, help, submit, busy, error, onSubmit, children }: {
  open: boolean; onOpenChange: (v: boolean) => void; title: string; help: string; submit: string; busy: boolean
  error: string; onSubmit: () => void; children: ReactNode
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{help}</DialogDescription></DialogHeader>
        <form noValidate className="flex flex-col gap-3" onSubmit={(e: FormEvent) => { e.preventDefault(); onSubmit() }}>
          {children}
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? "Adding…" : submit}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const Field = ({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) => (
  <label className="flex min-w-0 flex-col gap-1 text-sm">{label}{children}{hint && <span className="text-xs text-muted-foreground">{hint}</span>}</label>
)

function AgentSelect({ value, onChange, agents }: { value: string; onChange: (v: string) => void; agents: StateAgent[] }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-9 w-full font-mono" aria-label="Agent"><SelectValue placeholder="Pick an agent" /></SelectTrigger>
      <SelectContent>{agents.map((a) => <SelectItem key={a.id} value={a.id} className="font-mono">@{a.id}</SelectItem>)}</SelectContent>
    </Select>
  )
}

function useAdd(path: string, onDone: () => void) {
  const client = useQueryClient()
  const [error, setError] = useState("")
  const m = useMutation({
    mutationFn: (body: unknown) => post(path, body),
    onSuccess: () => { onDone(); return client.invalidateQueries({ queryKey: ["settings", "state"] }) },
    onError: (e) => setError("Not added: " + (e as Error).message),
  })
  return { add: m.mutate, busy: m.isPending, error, setError }
}

export function AddScheduleDialog({ open, onOpenChange, agents, taken }: { open: boolean; onOpenChange: (v: boolean) => void; agents: StateAgent[]; taken: string[] }) {
  const empty = { id: "", agent: agents[0]?.id ?? "", schedule: "0 9 * * 1-5", prompt: "" }
  const [f, setF] = useState(empty)
  const [preview, setPreview] = useState<{ text: string; err?: boolean }>({ text: "" })
  const close = (v: boolean) => { onOpenChange(v); if (!v) { setF(empty); setError("") } }
  const { add, busy, error, setError } = useAdd("crons", () => close(false))
  const set = (k: keyof typeof f, v: string) => { setF((x) => ({ ...x, [k]: v })); setError("") }

  // The next three runs, from the server's clock, 300 ms after typing stops.
  useEffect(() => {
    const expr = f.schedule.trim()
    if (!open || !expr) { setPreview({ text: "" }); return }
    let live = true
    const t = window.setTimeout(() => post("crons/preview", { schedule: expr }).then(
      (r) => live && setPreview({ text: [r.human || expr, (r.next ?? []).slice(0, 3).map((iso) => new Date(iso).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })).join(" · ")].filter(Boolean).join(` · next (${r.timezone ?? ""}): `) }),
      (e) => live && setPreview({ text: (e as Error).message, err: true }),
    ), 300)
    return () => { live = false; window.clearTimeout(t) }
  }, [open, f.schedule])

  const submit = () => {
    const id = f.id.trim()
    if (!id) return setError("Give the schedule a name.")
    if (!ID.test(id)) return setError("Use lowercase letters, digits, - and _.")
    if (taken.includes(id)) return setError(`${id} already exists.`)
    if (!f.agent) return setError("Pick the agent that runs it.")
    if (f.schedule.trim().split(/\s+/).length !== 5) return setError("Five fields: minute, hour, day, month, weekday.")
    if (!f.prompt.trim()) return setError("Say what the agent does.")
    add({ id, agent: f.agent, schedule: f.schedule.trim(), prompt: f.prompt.trim() })
  }
  return (
    <FormDialog open={open} onOpenChange={close} title="Add schedule" help="Make an agent do something on a timer." submit="Add schedule" busy={busy} error={error} onSubmit={submit}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Name"><input autoFocus className={cn(field, "font-mono")} value={f.id} onChange={(e) => set("id", e.target.value)} placeholder="weekly-report" autoComplete="off" spellCheck={false} /></Field>
        <div className="flex flex-col gap-1 text-sm">Agent<AgentSelect value={f.agent} onChange={(v) => set("agent", v)} agents={agents} /></div>
      </div>
      <Field label="When" hint={<span aria-live="polite" className={preview.err ? "text-destructive" : undefined}>{preview.text}</span>}>
        <input className={cn(field, "font-mono")} value={f.schedule} onChange={(e) => set("schedule", e.target.value)} placeholder="0 9 * * 1" autoComplete="off" spellCheck={false} />
      </Field>
      <div className="-mt-1 flex flex-wrap gap-1.5">
        {CRON_PRESETS.map(([expr, name]) => (
          <Button key={expr} type="button" size="xs" variant={f.schedule.trim() === expr ? "secondary" : "outline"} onClick={() => set("schedule", expr)}>{name}</Button>
        ))}
      </div>
      <Field label="What to do"><textarea rows={3} className={cn(field, "h-auto py-2")} value={f.prompt} onChange={(e) => set("prompt", e.target.value)} placeholder="Send me this week's numbers." /></Field>
    </FormDialog>
  )
}

export function AddWebhookDialog({ open, onOpenChange, agents, taken }: { open: boolean; onOpenChange: (v: boolean) => void; agents: StateAgent[]; taken: string[] }) {
  const empty = { id: "", source: "gitlab", agentId: agents[0]?.id ?? "", secretEnv: "", description: "" }
  const [f, setF] = useState(empty)
  const close = (v: boolean) => { onOpenChange(v); if (!v) { setF(empty); setError("") } }
  const { add, busy, error, setError } = useAdd("webhooks", () => close(false))
  const set = (k: keyof typeof f, v: string) => { setF((x) => ({ ...x, [k]: v })); setError("") }
  const submit = () => {
    const id = f.id.trim(), secret = f.secretEnv.trim()
    if (!id) return setError("Give the webhook a name.")
    if (!ID.test(id)) return setError("Use lowercase letters, digits, - and _.")
    if (taken.includes(id)) return setError(`${id} already exists.`)
    if (!f.agentId) return setError("Pick the agent it goes to.")
    if (secret && !ENV_NAME.test(secret)) return setError("Type the .env variable name, such as GITLAB_WEBHOOK_SECRET, not the secret itself.")
    add({ id, source: f.source, agentId: f.agentId, secretEnv: secret, description: f.description.trim() })
  }
  return (
    <FormDialog open={open} onOpenChange={close} title="Add webhook" help="An address another service calls; each call goes to an agent." submit="Add webhook" busy={busy} error={error} onSubmit={submit}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Name"><input autoFocus className={cn(field, "font-mono")} value={f.id} onChange={(e) => set("id", e.target.value)} placeholder="main-repo" autoComplete="off" spellCheck={false} /></Field>
        <div className="flex flex-col gap-1 text-sm">Source
          <Select value={f.source} onValueChange={(v) => set("source", v)}>
            <SelectTrigger className="h-9 w-full" aria-label="Source"><SelectValue /></SelectTrigger>
            <SelectContent>{WEBHOOK_SOURCES.map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex flex-col gap-1 text-sm">Agent<AgentSelect value={f.agentId} onChange={(v) => set("agentId", v)} agents={agents} /></div>
      <Field label="Signing secret" hint="The .env variable that holds it. A signed source refuses calls until it is set.">
        <input className={cn(field, "font-mono")} value={f.secretEnv} onChange={(e) => set("secretEnv", e.target.value)} placeholder="GITLAB_WEBHOOK_SECRET" autoComplete="off" spellCheck={false} />
      </Field>
      <Field label="Description"><input className={field} value={f.description} onChange={(e) => set("description", e.target.value)} placeholder="Issues and MRs on the main repo" autoComplete="off" /></Field>
    </FormDialog>
  )
}
