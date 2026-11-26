// --- Settings › Jobs › Webhooks (#2101 ST2b) ---
//
// Each webhook with its state, the address to paste into the other
// service, an on/off switch, and its routing (event triggers and the
// default workflow) folded under it. The old Settings' calls: PATCH
// webhooks, POST webhooks/triggers, DELETE webhooks.
import { useState } from "react"
import { Badge, Button, Icon, Switch, cn } from "../ui"
import { AddWebhookDialog } from "./JobsDialogs"
import { ChipList, ConfirmDialog, CopyButton, InlineFold, RowMenu, STATE_KEY, TextField, WriteNote, inputClass, type useWorkState, useWrite } from "./fields"
import { ErrorLine, SettingsGroup, SettingsItem, SkeletonRows } from "./parts"
import { hookState, hookUrl, sourceName, type Webhook } from "./work-data"

const PANE = "jobs"

export default function JobsHooks({ state }: { state: ReturnType<typeof useWorkState> }) {
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const w = useWrite(STATE_KEY)
  const hooks = state.data?.webhooks ?? []
  const add = <Button variant="outline" size="sm" onClick={() => setAdding(true)} data-row="add-webhook"><Icon name="plus" className="size-3.5" />Add webhook</Button>
  return (
    <>
      <SettingsGroup pane={PANE} row="webhooks" help="Addresses other services call when something happens. Each goes to an agent." action={add}>
        {state.isPending ? <SkeletonRows /> : state.isError ? (
          <ErrorLine text={`Could not read agentx.json: ${(state.error as Error).message}`} onRetry={() => state.refetch()} />
        ) : hooks.length === 0 ? (
          <div className="flex items-center justify-between gap-4 py-4 text-sm text-muted-foreground">No webhooks yet.{add}</div>
        ) : hooks.map((h) => (
          <HookItem key={h.id} hook={h} url={hookUrl(state.data?.daemonUrl, h)} busy={w.busy} write={w.write} onDelete={() => setDeleting(h.id)} />
        ))}
        <WriteNote note={w.note} />
      </SettingsGroup>
      <p className="flex items-start gap-2 px-1 text-xs text-muted-foreground">
        <Icon name="info" className="mt-px size-3.5" />Paste the address into the other service. A signed source refuses calls until its secret is set in .env.
      </p>
      <AddWebhookDialog open={adding} onOpenChange={setAdding} agents={state.data?.agents ?? []} taken={hooks.map((h) => h.id)} />
      <ConfirmDialog
        open={!!deleting} onOpenChange={(v) => !v && setDeleting(null)} busy={w.busy}
        title={`Delete ${deleting}?`} body="Calls to its address stop working." action="Delete webhook"
        onConfirm={() => { const id = deleting!; w.write("DELETE", "webhooks", { id }, `Deleted ${id}`).then(() => setDeleting(null)) }}
      />
    </>
  )
}

type Write = ReturnType<typeof useWrite>["write"]

function HookItem({ hook: h, url, busy, write, onDelete }: { hook: Webhook; url: string; busy: boolean; write: Write; onDelete: () => void }) {
  const st = hookState(h)
  const badge = st === "no-secret" ? <Badge variant="warn">Signing secret missing</Badge> : st === "on" ? <Badge variant="ok">Receiving</Badge> : <Badge variant="secondary">Off</Badge>
  const trig = Object.entries(h.triggers ?? {})
  const routing = ["Routing", trig.length ? `${trig.length} trigger${trig.length > 1 ? "s" : ""}` : "", h.defaultWorkflow ? `default ${h.defaultWorkflow}` : ""].filter(Boolean).join(" · ")
  const setTriggers = (next: Record<string, string>, done: string) => write("POST", "webhooks/triggers", { id: h.id, triggers: next }, done)
  return (
    <SettingsItem
      id={"hook-" + h.id}
      muted={!h.enabled}
      lead={<span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center self-start rounded-md border border-border bg-muted text-muted-foreground"><Icon name="webhook" className="size-3.5" /></span>}
      name={<span className="font-mono text-[13px]">{h.id}</span>}
      badge={badge}
      meta={<span className="flex w-full min-w-0 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-x-1.5">
          <span>{sourceName(h.source)}</span><span aria-hidden="true">·</span><span>goes to <span className="font-mono">@{h.agentId}</span></span>
          {h.secretEnv && <><span aria-hidden="true">·</span><span>secret <span className="font-mono">{"${" + h.secretEnv + "}"}</span></span></>}
          {h.description && <><span aria-hidden="true">·</span><span>{h.description}</span></>}
        </span>
        <span className="flex min-w-0 items-start gap-2 pt-1">
          <span className="mt-px shrink-0 rounded-sm border border-border px-1 font-mono text-[10.5px]">POST</span>
          <code className="min-w-0 font-mono text-[11.5px] leading-relaxed text-foreground [overflow-wrap:anywhere]">{url}</code>
          <CopyButton text={url} label="Copy address" />
        </span>
        <InlineFold label={routing}>
          <Routing hook={h} busy={busy} write={write} setTriggers={setTriggers} trig={trig} />
        </InlineFold>
      </span>}
      control={<Switch checked={h.enabled} disabled={busy} aria-label={(h.enabled ? "Turn off " : "Turn on ") + h.id}
        onCheckedChange={(v) => write("PATCH", "webhooks", { id: h.id, patch: { enabled: v } }, v ? `${h.id} is on: it receives calls` : `${h.id} is off: calls to it are refused`)} />}
      menu={<RowMenu name={h.id} items={[
        { label: "Copy address", icon: "copy", onSelect: () => void navigator.clipboard?.writeText(url) },
        { label: "Delete webhook", icon: "trash-2", destructive: true, onSelect: onDelete },
      ]} />}
    />
  )
}

function Routing({ hook: h, busy, write, setTriggers, trig }: {
  hook: Webhook; busy: boolean; write: Write; trig: [string, string][]; setTriggers: (next: Record<string, string>, done: string) => Promise<boolean>
}) {
  const [ev, setEv] = useState("")
  const [wf, setWf] = useState("")
  const addTrigger = () => {
    if (!ev.trim() || !wf.trim()) return
    setTriggers({ ...h.triggers, [ev.trim()]: wf.trim() }, `${ev.trim()} now runs ${wf.trim()}`).then((ok) => { if (ok) { setEv(""); setWf("") } })
  }
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border/70 p-3">
      {trig.length ? (
        <ChipList
          label="Event triggers" values={trig.map(([e, w]) => `${e} → ${w}`)} disabled={busy}
          onChange={(next) => setTriggers(Object.fromEntries(trig.filter(([e, w]) => next.includes(`${e} → ${w}`))), "Trigger removed")}
          addLabel={false}
        />
      ) : <span className="text-[12.5px]">No triggers: every event runs the default workflow.</span>}
      <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); addTrigger() }}>
        <input value={ev} onChange={(e) => setEv(e.target.value)} placeholder="issues.opened" aria-label="Event type" className={cn(inputClass, "w-44 font-mono")} />
        <input value={wf} onChange={(e) => setWf(e.target.value)} placeholder="Workflow id" aria-label="Workflow id" className={cn(inputClass, "w-36 font-mono")} />
        <Button type="submit" variant="outline" size="sm" disabled={busy || !ev.trim() || !wf.trim()}>Add trigger</Button>
      </form>
      <label className="flex flex-wrap items-center gap-2 text-[12.5px]">Default workflow
        <TextField value={h.defaultWorkflow} label="Default workflow" placeholder="none" mono disabled={busy} className="w-40"
          onCommit={(d) => write("POST", "webhooks/triggers", { id: h.id, defaultWorkflow: d }, d ? `Default workflow: ${d}` : "No default workflow")} />
      </label>
    </div>
  )
}
