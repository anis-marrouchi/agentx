// --- Settings › Agent › Overview (#2101 ST2a) ---
//
// The old agent page's form (wall-settings-agent.client.ts), on the mock:
// a changed field says what it was, a bar counts the changes and says if
// they need a restart, and Review and save shows each change before and
// after (with the recurring jobs that follow the model and the spend
// against the cap) before one PATCH saves them all. The draft lives in
// AgentPane, so a tab switch or a refresh keeps what was typed, and a
// failed save leaves the form as it was.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState, type ReactNode } from "react"
import { apiGet } from "../api"
import { settingsHash } from "./address"
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch, cn } from "../ui"
import {
  INSTRUCTIONS_MAX, PERMISSIONS, RESTART_CMD, agentPatch, alsoLines, changedFields, draftValue, fieldLabel, isChanged, restartWords, savedValue, showValue,
  type AgentConfig, type AgentDraft, type AgentField, type AgentState,
} from "./agent-data"
import { ENGINE_CHOICES, engineName } from "./data"
import { EngineLogo, save } from "./GeneralPane"
import { ModelPicker } from "./ModelPicker"
import { ConfirmDialog, inputClass } from "./fields"
import { Disclosure, SettingsGroup, SettingsRow } from "./parts"
import { TestDrive } from "./TestDrive"

const PANE = "agent"
const CHANGED = "border-link ring-1 ring-link/30"

interface Props { agent: AgentConfig; state: AgentState; draft: AgentDraft; setDraft: (d: AgentDraft) => void }

export function AgentOverview({ agent: a, state, draft, setDraft }: Props) {
  const [reviewing, setReviewing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [note, setNote] = useState<{ tone: "ok" | "err"; text: string } | null>(null)
  const v = (k: AgentField) => draftValue(a, draft, k)
  const changed = (k: AgentField) => isChanged(a, draft, k)
  const set = (k: AgentField, val: string, more?: AgentDraft) => { setDraft({ ...draft, [k]: val, ...more }); setNote(null) }
  const changes = changedFields(a, draft)
  const restart = restartWords(changes)
  /** A row's help: what it was, once changed. */
  const was = (k: AgentField) => changed(k) ? <span className="text-link">Changed from {showValue(k, savedValue(a, k), engineName)}</span> : undefined
  const label = (k: AgentField, text: string) => changed(k) ? <span className="flex items-center gap-1.5">{text}<span aria-label="changed" className="size-1.5 rounded-full bg-link" /></span> : undefined
  const text = (k: AgentField, aria: string, mono?: boolean) => (
    <input aria-label={aria} value={v(k)} onChange={(e) => set(k, e.target.value)} className={cn(inputClass, "w-[220px]", mono && "font-mono", changed(k) && CHANGED)} />
  )
  const num = (k: AgentField, aria: string, max: number, unit?: string) => (
    <span className="flex items-center gap-2 text-xs text-muted-foreground">
      <input type="number" min={1} max={max} aria-label={aria} value={v(k)} onChange={(e) => set(k, e.target.value)} className={cn(inputClass, "w-20 tabular-nums", changed(k) && CHANGED)} />{unit}
    </span>
  )
  const sw = (k: AgentField, aria: string) => <Switch checked={v(k) === "on"} onCheckedChange={(on) => set(k, on ? "on" : "off")} aria-label={aria} />
  const row = (k: AgentField, row: string, control: ReactNode) => <SettingsRow pane={PANE} row={row} label={label(k, fieldLabel(k))} help={was(k)} control={control} />

  return (
    <div className="flex flex-col gap-8">
      <SettingsGroup pane={PANE} title="Identity">
        {row("name", "name", text("name", "Display name"))}
        {row("triggerWords", "wake", text("triggerWords", "Wake words", true))}
      </SettingsGroup>
      <SettingsGroup pane={PANE} title="Engine" help="What runs this agent. The model and tool permissions apply after a daemon restart.">
        {row("tier", "engine", (
          <Select value={v("tier")} onValueChange={(t) => set("tier", t)}>
            <SelectTrigger className={cn("h-8 w-[200px]", changed("tier") && CHANGED)} aria-label="AI engine"><SelectValue /></SelectTrigger>
            <SelectContent align="end">
              {ENGINE_CHOICES.map((t) => <SelectItem key={t} value={t}><span className="flex items-center gap-2"><EngineLogo tier={t} />{engineName(t)}</span></SelectItem>)}
            </SelectContent>
          </Select>
        ))}
        {row("model", "model", <ModelPicker value={v("model")} tier={v("tier")} className={changed("model") ? CHANGED : undefined} onChange={(m, t) => set("model", m, t ? { tier: t } : undefined)} />)}
        {row("permissionMode", "permissions", (
          <Select value={v("permissionMode")} onValueChange={(p) => set("permissionMode", p)}>
            <SelectTrigger className={cn("h-8 w-[200px]", changed("permissionMode") && CHANGED)} aria-label="Tool permissions"><SelectValue /></SelectTrigger>
            <SelectContent align="end">{PERMISSIONS.map(([p, l]) => <SelectItem key={p} value={p}>{l}</SelectItem>)}</SelectContent>
          </Select>
        ))}
        <Disclosure id="agent-advanced" label="Advanced">
          {row("maxConcurrent", "concurrent", num("maxConcurrent", "Conversations at once", 20))}
          {row("maxExecutionMinutes", "longest", num("maxExecutionMinutes", "Longest task", 240, "minutes"))}
          <SettingsRow pane={PANE} row="public" label={label("access", fieldLabel("access"))} help={was("access") ?? `A token with agent:${a.id} scope can reach it.`} control={sw("access", "Answers on the public API")} />
          {row("wikiAbsorb", "absorb", sw("wikiAbsorb", "In the wiki absorb"))}
        </Disclosure>
      </SettingsGroup>
      <SettingsGroup pane={PANE} row="instructions" help="Its system prompt. The longer files it reads are under Personality.">
        <div className="flex flex-col gap-1.5 py-4">
          <textarea
            rows={5} maxLength={INSTRUCTIONS_MAX} aria-label="Instructions" value={v("systemPrompt")} onChange={(e) => set("systemPrompt", e.target.value)}
            className={cn(inputClass, "h-auto w-full resize-y py-2 leading-6", changed("systemPrompt") && CHANGED)}
          />
          <span className={cn("text-xs", changed("systemPrompt") ? "text-link" : "text-muted-foreground")}>
            {changed("systemPrompt") && "Changed · "}{v("systemPrompt").length.toLocaleString("en")} of {INSTRUCTIONS_MAX.toLocaleString("en")} characters
          </span>
        </div>
      </SettingsGroup>
      <TestDrive key={a.id} agent={a} />
      <SettingsGroup pane={PANE} title="Delete">
        <SettingsRow
          pane={PANE} row="delete" label={<>Delete <span className="font-mono text-[13px]">@{a.id}</span></>}
          help="Removes it from agentx.json and unbinds its Telegram bots. Its workspace folder stays."
          control={<Button variant="outline" size="sm" className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setDeleting(true)}>Delete…</Button>}
        />
      </SettingsGroup>
      {(changes.length > 0 || note) && (
        <div role="region" aria-label="Changes not saved" className="sticky bottom-4 z-10 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border bg-popover px-4 py-3 shadow-float max-sm:order-first max-sm:top-2 max-sm:bottom-auto">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-sm" role="status">
            {changes.length > 0 ? <>
              <span>{changes.length === 1 ? "1 change not saved" : `${changes.length} changes not saved`}</span>
              <span className="text-xs text-muted-foreground">{restart ? `The new ${restart} applies after a daemon restart.` : "Applies from its next run."}</span>
            </> : note && <span className={cn("text-xs", note.tone === "err" ? "text-destructive" : "text-muted-foreground")}>{note.text}</span>}
          </div>
          <div className="ml-auto flex items-center gap-2">
            {changes.length > 0 ? <>
              <Button variant="ghost" size="sm" onClick={() => { setDraft({}); setNote(null) }}>Discard</Button>
              <Button size="sm" onClick={() => setReviewing(true)}>Review and save</Button>
            </> : <Button variant="ghost" size="sm" onClick={() => setNote(null)}>Dismiss</Button>}
          </div>
        </div>
      )}
      <ReviewDialog open={reviewing} onOpenChange={setReviewing} agent={a} state={state} draft={draft} onSaved={(t) => { setDraft({}); setNote({ tone: "ok", text: t }) }} onFailed={(t) => setNote({ tone: "err", text: t })} />
      <DeleteDialog open={deleting} onOpenChange={setDeleting} agent={a} />
    </div>
  )
}

function ReviewDialog({ open, onOpenChange, agent: a, state, draft, onSaved, onFailed }: {
  open: boolean; onOpenChange: (v: boolean) => void; agent: AgentConfig; state: AgentState; draft: AgentDraft; onSaved: (t: string) => void; onFailed: (t: string) => void
}) {
  const client = useQueryClient()
  const changes = changedFields(a, draft)
  const moves = changes.includes("model") || changes.includes("tier")
  const budgets = useQuery({
    queryKey: ["settings", "budgets"], enabled: open && moves,
    queryFn: () => apiGet<{ agents?: { agentId: string; spentUsd?: number; capUsd?: number }[] }>("/api/admin/observability/budgets"),
  })
  const budget = budgets.isError ? undefined : budgets.data ? budgets.data.agents?.find((r) => r.agentId === a.id) ?? null : undefined
  const put = useMutation({
    mutationFn: () => save("PATCH", "/api/admin/wall/settings/agents", { id: a.id, patch: agentPatch(a, draft) }),
    onSuccess: () => {
      const r = restartWords(changes)
      onSaved(r ? `Saved. Restart the daemon for the new ${r}: ${RESTART_CMD}` : "Saved. It applies from its next run.")
      onOpenChange(false)
      return client.invalidateQueries({ queryKey: ["settings", "state"] })
    },
    onError: (e) => { onFailed(`Not saved: ${(e as Error).message}. The form keeps what you typed.`); onOpenChange(false) },
  })
  const name = a.name || a.id
  const emptyName = !draftValue(a, draft, "name").trim()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Save {changes.length === 1 ? "1 change" : `${changes.length} changes`} to {name}?</DialogTitle>
          <DialogDescription className="sr-only">Each change before and after.</DialogDescription>
        </DialogHeader>
        <table className="w-full overflow-hidden rounded-lg border border-border text-[13px]">
          <tbody>
            {changes.map((k) => (
              <tr key={k} className="border-t border-border first:border-t-0">
                <th scope="row" className="w-2/5 px-3 py-2 text-left font-normal text-muted-foreground">{fieldLabel(k)}</th>
                <td className="px-3 py-2 [overflow-wrap:anywhere]">
                  <s className="font-mono text-xs text-muted-foreground">{showValue(k, savedValue(a, k), engineName)}</s> → <span className="font-mono text-xs">{showValue(k, draftValue(a, draft, k), engineName)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-sm text-muted-foreground">{moves && budgets.isPending ? "Reading its spend…" : alsoLines(a, changes, state.crons, budget).join(" ")}</p>
        {emptyName && <p role="alert" className="text-xs text-destructive">The display name cannot be empty.</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Back</Button>
          <Button autoFocus disabled={put.isPending || emptyName} onClick={() => put.mutate()}>{put.isPending ? "Saving…" : "Save changes"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DeleteDialog({ open, onOpenChange, agent: a }: { open: boolean; onOpenChange: (v: boolean) => void; agent: AgentConfig }) {
  const client = useQueryClient()
  return (
    <ConfirmDialog
      open={open} onOpenChange={onOpenChange} title={`Delete @${a.id}?`} action={`Delete @${a.id}`}
      body={`It is removed from agentx.json and its Telegram bots are unbound. Its workspace folder stays on disk. The daemon stops it after a restart: ${RESTART_CMD}.`}
      run={async () => {
        await save("DELETE", "/api/admin/wall/settings/agents", { id: a.id })
        location.replace(settingsHash("general"))
        await client.invalidateQueries({ queryKey: ["settings"] })
      }}
    />
  )
}
