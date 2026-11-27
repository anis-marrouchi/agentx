// --- Settings › WhatsApp: watch rules (#2101 ST3a) ---
//
// Each rule sends some chats to one agent. On or off on the row, Delete
// under `…`, Add in a dialog with the rare fields (only from, quiet hours)
// under Advanced. POST|PATCH|DELETE …/whatsapp-triage/rules, as the old
// page (wall-settings-whatsapp.client.ts).
import { useState } from "react"
import { Switch, cn } from "../ui"
import type { WatchRule } from "./channels-data"
import { AgentSelect, Field, FieldRow, dialogInput, type Send } from "./fields"
import { AddButton, Dots, EmptyLine, FormDialog, Lead, RowMenu, SettingsGroup, SettingsItem, useConfirm, type Invalid } from "./parts"

const PANE = "whatsapp"
const PATH = "whatsapp-triage/rules"

const Pill = ({ text }: { text: string }) => <span className="inline-flex h-5 items-center rounded-sm border border-border bg-muted/60 px-1.5 font-mono text-[11px]">{text}</span>

export function WatchRules({ rules, agents, write, send }: { rules: WatchRule[]; agents: readonly { id: string }[]; write: Send; send: Send }) {
  const [adding, setAdding] = useState(false)
  const confirm = useConfirm()
  return (
    <>
      <SettingsGroup
        pane={PANE} row="wa-rules" action={<AddButton row="wa-add-rule" label="Add watch rule" onClick={() => setAdding(true)} />}
        help={`${rules.length} ${rules.length === 1 ? "rule" : "rules"}. Each sends some chats to one agent.`}
      >
        {rules.length === 0 ? <EmptyLine>No watch rule yet.</EmptyLine> : rules.map((r) => {
          const on = r.enabled !== false
          return (
            <SettingsItem
              key={r.id} id={"wr-" + r.id} muted={!on}
              lead={<Lead icon="eye" />}
              name={<span className="font-mono text-[13px]">{r.id}</span>}
              meta={<>
                <Dots items={[<>goes to <span className="font-mono text-xs">@{r.agent}</span></>, r.quietHours && `quiet ${r.quietHours.start}–${r.quietHours.end}`]} />
                <span className="mt-1 flex basis-full flex-wrap items-center gap-1">
                  {(r.chats ?? []).map((c) => <Pill key={c} text={c} />)}
                  {!!r.senders?.length && <><span className="mx-1">only from</span>{r.senders.map((c) => <Pill key={c} text={c} />)}</>}
                </span>
              </>}
              control={<Switch checked={on} onCheckedChange={(v) => write("PATCH", PATH, { id: r.id, patch: { enabled: v } }, `The watch rule ${r.id} is ${v ? "on" : "off"}.`)} aria-label={(on ? "Turn off " : "Turn on ") + r.id} />}
              menu={<RowMenu label={r.id} items={[
                { label: "Delete watch rule", icon: "trash-2", destructive: true, onSelect: () => confirm.ask({
                  title: `Delete ${r.id}?`, text: `Messages from its chats no longer reach @${r.agent}.`, yes: "Delete watch rule",
                  run: () => send("DELETE", PATH, { id: r.id }, `Deleted the watch rule ${r.id}.`),
                }) },
              ]} />}
            />
          )
        })}
      </SettingsGroup>
      <RuleDialog open={adding} onOpenChange={setAdding} agents={agents} send={send} taken={rules.map((r) => r.id)} />
      {confirm.dialog}
    </>
  )
}

function RuleDialog({ open, onOpenChange, agents, send, taken }: { open: boolean; onOpenChange: (v: boolean) => void; agents: readonly { id: string }[]; send: Send; taken: string[] }) {
  const blank = { id: "", agent: agents[0]?.id ?? "", chats: "", prompt: "", senders: "", quietStart: "", quietEnd: "" }
  const [f, setF] = useState(blank)
  const set = (k: keyof typeof blank, v: string) => setF((x) => ({ ...x, [k]: v }))
  const close = (v: boolean) => { onOpenChange(v); if (!v) setF(blank) }
  const submit = async (): Promise<Invalid> => {
    const id = f.id.trim()
    if (!/^[a-z0-9_-]+$/.test(id)) return { field: "id", text: "Use lowercase letters, digits, - and _." }
    if (taken.includes(id)) return { field: "id", text: `${id} already exists.` }
    if (!f.chats.trim()) return { field: "chats", text: "Add at least one chat." }
    if (!f.quietStart.trim() !== !f.quietEnd.trim()) return { field: "quietEnd", text: "Quiet hours need a start and an end." }
    await send("POST", PATH, { ...f, id, quietStart: f.quietStart.trim(), quietEnd: f.quietEnd.trim() }, `Added the watch rule ${id}.`)
    setF(blank)
  }
  const text = (k: keyof typeof blank, label: string, ph: string, help?: string) => (
    <Field label={label} help={help}><input className={cn(dialogInput, "font-mono")} value={f[k]} onChange={(e) => set(k, e.target.value)} placeholder={ph} autoComplete="off" spellCheck={false} /></Field>
  )
  return (
    <FormDialog
      open={open} onOpenChange={close} title="Add watch rule" description="Messages from these chats go to the agent you pick." submit="Add watch rule" onSubmit={submit}
      advanced={<>
        {text("senders", "Only from", "+1 555 000 2222", "People in those chats. Empty: everyone.")}
        <FieldRow>{text("quietStart", "Quiet from", "22:00")}{text("quietEnd", "Quiet until", "07:00")}</FieldRow>
      </>}
    >
      <FieldRow>
        {text("id", "Rule name", "front-desk", "Lowercase")}
        <Field label="Agent"><AgentSelect label="Agent" value={f.agent} onChange={(v) => set("agent", v)} agents={agents} /></Field>
      </FieldRow>
      {text("chats", "Chats", "+1 555 000 1111", "Phone numbers or chat ids, comma-separated")}
      <Field label="Instructions for the agent" help="Optional">
        <textarea rows={3} className={cn(dialogInput, "h-auto py-2")} value={f.prompt} onChange={(e) => set("prompt", e.target.value)} placeholder="Who this contact is, where issues go, how to reply." />
      </Field>
    </FormDialog>
  )
}
