// --- Settings › Business: the forms (#2101 ST3a) ---
//
// Add or edit a project, set up a client, map a chat to a client, add or
// edit a board and add a column, each in a FormDialog with its rare fields
// under Advanced. The bodies are the old Business section's
// (wall-settings-business.client.ts); `send` throws, so a refusal stays in
// the dialog.
import { useEffect, useState } from "react"
import { splitList, type Board, type ClientRow, type ContactMapping, type Project } from "./business-data"
import { AgentSelect, Choice, Field, FieldRow, dialogInput, type Send } from "./fields"
import { FormDialog, type Invalid } from "./parts"

export const NEXT_START = "Applies at the next daemon start."

/** Form state that resets each time its dialog opens on a new subject. */
function useForm<T>(open: boolean, init: () => T): [T, <K extends keyof T>(k: K, v: T[K]) => void] {
  const [f, setF] = useState<T>(init)
  useEffect(() => { if (open) setF(init()) }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  return [f, (k, v) => setF((x) => ({ ...x, [k]: v }))]
}

const mono = dialogInput + " font-mono"
const Text = ({ label, help, value, onChange, ph, plain, readOnly }: {
  label: string; help?: string; value: string; onChange: (v: string) => void; ph?: string; plain?: boolean; readOnly?: boolean
}) => (
  <Field label={label} help={help}>
    <input className={plain ? dialogInput : mono} value={value} readOnly={readOnly} onChange={(e) => onChange(e.target.value)} placeholder={ph} autoComplete="off" spellCheck={false} />
  </Field>
)
const close = (onClose: () => void) => (v: boolean) => { if (!v) onClose() }

export function ProjectDialog({ project: p, agents, onClose, send }: { project: Project | null | undefined; agents: readonly { id: string }[]; onClose: () => void; send: Send }) {
  const open = p !== undefined
  const [f, set] = useForm(open, () => ({ id: p?.id ?? "", pm: p?.pm ?? "", client: p?.client ?? "", name: p?.name ?? "", lead: p?.lead ?? "", team: (p?.team ?? []).join(", ") }))
  const submit = async (): Promise<Invalid> => {
    const id = f.id.trim()
    if (!id) return { field: "id", text: "Give the project an id." }
    // A blank keeps what is saved; a field emptied on edit is cleared (#1687).
    const body: Record<string, unknown> = { id, pm: f.pm, client: f.client.trim() }
    const team = splitList(f.team)
    if (f.name.trim()) body.name = f.name.trim()
    if (f.lead.trim()) body.lead = f.lead.trim()
    if (team.length) body.team = team
    const clear = p ? (["name", "lead", "team"] as const).filter((k) => (k === "team" ? !team.length && p.team?.length : !f[k].trim() && p[k])) : []
    if (clear.length) body.clear = clear
    await send("POST", "business/project", body, `Saved ${id}. ${NEXT_START}`)
  }
  return (
    <FormDialog
      open={open} onOpenChange={close(onClose)} title={p ? `Edit ${p.id}` : "Add project"} description={NEXT_START} submit={p ? "Save project" : "Add project"} onSubmit={submit}
      advanced={<>
        <Text label="Lead" value={f.lead} onChange={(v) => set("lead", v)} ph="person:sam" />
        <Text label="Team" help="Comma separated. Replaces the team; empty clears it." value={f.team} onChange={(v) => set("team", v)} ph="agent:coder, person:kim" />
      </>}
    >
      <Text label="Project id" help="owner/repo on GitLab or GitHub" value={f.id} readOnly={!!p} onChange={(v) => set("id", v)} ph="example/app" />
      <FieldRow>
        <Field label="PM"><AgentSelect label="PM" value={f.pm} onChange={(v) => set("pm", v)} agents={agents} none={p?.pm ? undefined : "No PM"} /></Field>
        <Text label="Client" value={f.client} onChange={(v) => set("client", v)} ph="example" />
      </FieldRow>
      <Text label="Name" help="Shown on the Org page" plain value={f.name} onChange={(v) => set("name", v)} ph="Example app" />
    </FormDialog>
  )
}

const KIND_OPTIONS = [
  { value: "client", label: "Client: waits on you" },
  { value: "own", label: "Own: your product" },
  { value: "internal", label: "Internal: machinery" },
]

export function ClientDialog({ row, onClose, send }: { row: ClientRow | null | undefined; onClose: () => void; send: Send }) {
  const open = row !== undefined
  const c = row?.cfg
  const [f, set] = useForm(open, () => ({ id: row?.id ?? "", name: c?.name ?? "", kind: c?.kind || "client", within: c?.respondWithin ?? "", standing: (c?.standing ?? []).join(", ") }))
  const submit = async (): Promise<Invalid> => {
    const id = f.id.trim()
    if (!id) return { field: "id", text: "Give the client an id." }
    if (f.within.trim() && !/^\d+\s*[mhd]$/.test(f.within.trim())) return { field: "within", text: "Respond within looks like 4h, 90m or 2d." }
    await send("POST", "business/client", { id, name: f.name.trim(), kind: f.kind, respondWithin: f.within.trim(), standing: splitList(f.standing) }, `Saved ${id}. ${NEXT_START}`)
  }
  return (
    <FormDialog
      open={open} onOpenChange={close(onClose)}
      title={c ? `Edit ${c.name || row?.id}` : row ? `Set up ${row.id}` : "Set up a client"}
      description="Only to treat a client differently from the default." submit="Save client" onSubmit={submit}
      advanced={<Text label="Standing authorizations" help="What agents may do without asking. * for all; ignored for kind Client." value={f.standing} onChange={(v) => set("standing", v)} ph="rebase-branch, open-followup-issue" />}
    >
      <FieldRow>
        <Text label="Client id" value={f.id} readOnly={!!row} onChange={(v) => set("id", v)} ph="example" />
        <Text label="Display name" plain value={f.name} onChange={(v) => set("name", v)} ph="Example Co" />
      </FieldRow>
      <FieldRow>
        <Field label="Kind"><Choice label="Kind" value={f.kind} onChange={(v) => set("kind", v)} options={KIND_OPTIONS} /></Field>
        <Text label="Respond within" help="4h, 90m, 2d; empty for no clock" value={f.within} onChange={(v) => set("within", v)} ph="4h" />
      </FieldRow>
    </FormDialog>
  )
}

const CHANNEL_OPTIONS = [{ value: "", label: "Any channel" }, { value: "telegram", label: "Telegram" }, { value: "whatsapp", label: "WhatsApp" }]

export function MappingDialog({ open, onOpenChange, send }: { open: boolean; onOpenChange: (v: boolean) => void; send: Send }) {
  const [f, set] = useForm(open, () => ({ channel: "", chatId: "", username: "", senderId: "", client: "", project: "", displayName: "" }))
  const submit = async (): Promise<Invalid> => {
    const t = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.trim()])) as typeof f
    if (!t.chatId && !t.username && !t.senderId) return { field: "chatId", text: "Give a chat id, a username or a sender id." }
    if (!t.client) return { field: "client", text: "Name the client." }
    await send("POST", "business/contact", t satisfies ContactMapping, `Mapping saved. ${NEXT_START}`)
  }
  return (
    <FormDialog
      open={open} onOpenChange={onOpenChange} title="Add a contact mapping" description="Match a chat by at least one of chat id, username and sender id." submit="Save mapping" onSubmit={submit}
      advanced={<FieldRow>
        <Text label="Username" value={f.username} onChange={(v) => set("username", v)} ph="alex" />
        <Text label="Sender id" value={f.senderId} onChange={(v) => set("senderId", v)} ph="123456789" />
      </FieldRow>}
    >
      <FieldRow>
        <Field label="Channel"><Choice label="Channel" value={f.channel} onChange={(v) => set("channel", v)} options={CHANNEL_OPTIONS} /></Field>
        <Text label="Chat id" value={f.chatId} onChange={(v) => set("chatId", v)} ph="-1001234567890" />
      </FieldRow>
      <FieldRow>
        <Text label="Client" value={f.client} onChange={(v) => set("client", v)} ph="example" />
        <Text label="Project" help="Optional" value={f.project} onChange={(v) => set("project", v)} ph="example/app" />
      </FieldRow>
      <Text label="Display name" help="Optional" plain value={f.displayName} onChange={(v) => set("displayName", v)} ph="Alex Chen" />
    </FormDialog>
  )
}

export function BoardDialog({ board: b, onClose, send }: { board: Board | null | undefined; onClose: () => void; send: Send }) {
  const open = b !== undefined
  const [f, set] = useForm(open, () => ({
    id: b?.id ?? "", name: b?.name ?? "", projects: (b?.source?.projects ?? []).join(", "), label: b?.primaryToolLabel ?? "",
    open: String(b?.timeRangeDays ?? 30), closed: String(b?.closedWindowDays ?? 30),
  }))
  const submit = async (): Promise<Invalid> => {
    const id = f.id.trim()
    if (!id) return { field: "id", text: "Give the board an id." }
    await send("POST", "boards", {
      id, name: f.name.trim(), projects: splitList(f.projects).join(","), primaryToolLabel: f.label.trim(),
      timeRangeDays: parseInt(f.open, 10) || 30, closedWindowDays: parseInt(f.closed, 10) || 30,
    }, `Saved the board ${id}.`)
  }
  return (
    <FormDialog
      open={open} onOpenChange={close(onClose)} title={b ? `Edit ${b.name}` : "Add board"}
      description="A board shows the issues of one or more GitLab projects." submit="Save board" onSubmit={submit}
      advanced={<>
        <Text label="Main label" help="Optional: every card has it" value={f.label} onChange={(v) => set("label", v)} ph="Tool::Agent" />
        <FieldRow>
          <Text label="Open window (days)" plain value={f.open} onChange={(v) => set("open", v)} />
          <Text label="Closed window (days)" plain value={f.closed} onChange={(v) => set("closed", v)} />
        </FieldRow>
      </>}
    >
      <FieldRow>
        <Text label="Board id" value={f.id} readOnly={!!b} onChange={(v) => set("id", v)} ph="example" />
        <Text label="Name" plain value={f.name} onChange={(v) => set("name", v)} ph="Example app" />
      </FieldRow>
      <Text label="GitLab projects" help="Comma separated paths" value={f.projects} onChange={(v) => set("projects", v)} ph="example/app, example/site" />
    </FormDialog>
  )
}

const COLUMN_KINDS = [
  { value: "scoped-label", label: "Scoped label" }, { value: "label", label: "Label" }, { value: "open-backlog", label: "Open backlog" }, { value: "closed", label: "Closed" },
]

export function ColumnDialog({ board: b, onClose, send }: { board: Board | null; onClose: () => void; send: Send }) {
  const [f, set] = useForm(!!b, () => ({ id: "", title: "", kind: "scoped-label", value: "" }))
  const submit = async (): Promise<Invalid> => {
    if (!b) return
    const id = f.id.trim(), title = f.title.trim()
    if (!id || !title) return { field: id ? "title" : "id", text: "Give the column an id and a title." }
    const body: Record<string, string> = { boardId: b.id, columnId: id, title, kind: f.kind }
    if (f.kind === "scoped-label") body.scopedLabel = f.value.trim()
    else if (f.kind === "label") body.mapsToLabel = f.value.trim()
    await send("POST", "boards/columns", body, `Added the column ${title}.`)
  }
  const needsLabel = f.kind === "scoped-label" || f.kind === "label"
  return (
    <FormDialog open={!!b} onOpenChange={close(onClose)} title={`Add a column to ${b?.name ?? ""}`} description="A card dropped in the column gets its label." submit="Add column" onSubmit={submit}>
      <FieldRow>
        <Text label="Column id" value={f.id} onChange={(v) => set("id", v)} ph="doing" />
        <Text label="Title" plain value={f.title} onChange={(v) => set("title", v)} ph="Doing" />
      </FieldRow>
      <FieldRow>
        <Field label="Kind"><Choice label="Kind" value={f.kind} onChange={(v) => set("kind", v)} options={COLUMN_KINDS} /></Field>
        {needsLabel && <Text label="Label" value={f.value} onChange={(v) => set("value", v)} ph={f.kind === "label" ? "doing" : "Status::Doing"} />}
      </FieldRow>
    </FormDialog>
  )
}
