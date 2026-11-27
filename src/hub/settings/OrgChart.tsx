// --- Settings › Business › Org chart (#2101 ST3a) ---
//
// The org chart as the mock draws it: each member under its boss, with its
// role, hours and other lines, Edit on hover and Remove under `…`. It is
// the /org editor's model (#1678, org-setup.ts): it reads GET
// /api/admin/org and sends one change at a time to POST
// /api/admin/wall/settings/org/chart (owner guard). A move or a removal
// says what changes (orgConfirmFor) and waits for "Save the move"; if a
// later step is refused, the undo steps put the old line back.
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState, type CSSProperties } from "react"
import { orgConfirmFor, type OrgChange } from "../../daemon/ui/pages/org-setup"
import { apiGet, apiPost } from "../api"
import { Badge, Button, Icon, cn } from "../ui"
import { DAY_NAMES, WEEK, hoursText, lineTo, orgRows, type OrgSetupReply, type SetupMember } from "./business-data"
import { initials } from "./data"
import { Choice, Field, FieldRow, SETTINGS_API, WriteNote, dialogInput, type Note } from "./fields"
import { AddButton, Dots, EmptyLine, ErrorLine, FormDialog, Lead, RowMenu, SettingsGroup, SettingsItem, SkeletonRows, useConfirm } from "./parts"

const PANE = "business"
const post = (c: OrgChange) => apiPost<{ summary?: string }>(SETTINGS_API + "org/chart", c)

export function useOrgSetup() {
  return useQuery({ queryKey: ["settings", "org"], queryFn: () => apiGet<OrgSetupReply>("/api/admin/org") })
}

/** The undo after a refused step failed too: the chart is half changed. */
export class OrgUndoFailed extends Error {}

/** Sends the steps in order; when a later one is refused, the undo steps
 *  put back what the earlier ones changed. If an undo is refused as well,
 *  it throws OrgUndoFailed so the dialog says to reload (#2443 review C2). */
export async function applyOrgSteps(steps: OrgChange[], undo: OrgChange[], send: (c: OrgChange) => Promise<unknown> = post) {
  let done = 0
  try { for (; done < steps.length; done++) await send(steps[done]) }
  catch (e) {
    let undone = true
    if (done > 0) for (const u of undo) await send(u).catch(() => { undone = false })
    if (!undone) throw new OrgUndoFailed(`Not saved, and the old line could not be put back: reload. The server said: ${(e as Error).message}`)
    throw e
  }
}

export function OrgGroup() {
  const client = useQueryClient()
  const org = useOrgSetup()
  const [edit, setEdit] = useState<SetupMember | null>(null)
  const [adding, setAdding] = useState(false)
  const confirm = useConfirm()
  const [note, setNote] = useState<Note>(null)
  const setup = org.data?.setup
  const canEdit = !!org.data?.canEdit && !!setup
  const rows = orgRows(setup)
  const name = (ref?: string) => setup?.members.find((m) => m.ref === ref)?.name ?? ref?.replace(/^(agent|person):/, "") ?? ""
  const reload = () => client.invalidateQueries({ queryKey: ["settings", "org"] })
  const remove = (m: SetupMember) => {
    const c = setup && orgConfirmFor(setup, { op: "remove-member", member: m.ref })
    confirm.ask({
      title: `Remove ${m.name} from the org chart?`, yes: "Remove",
      text: c?.text ?? "",
      run: async () => { try { await post({ op: "remove-member", member: m.ref }); setNote({ tone: "ok", text: `${m.name} left the org chart.` }) } finally { await reload() } },
    })
  }
  return (
    <SettingsGroup
      pane={PANE} row="org"
      action={canEdit && <AddButton label="Add member" onClick={() => setAdding(true)} />}
    >
      {org.isPending ? <SkeletonRows /> : org.isError ? (
        <ErrorLine text={`Could not read the org chart: ${(org.error as Error).message}`} onRetry={() => org.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyLine>No one in the org chart yet.{canEdit ? " Add a member to start it." : ""}</EmptyLine>
      ) : rows.map(({ member: m, depth, lines }) => (
        <div key={m.ref} style={{ "--d": Math.min(depth, 4) } as CSSProperties} className="pl-[calc(var(--d)*14px)] sm:pl-[calc(var(--d)*28px)]">
          <SettingsItem
            id={"om-" + m.id}
            lead={m.kind === "person" ? <Lead icon="user-round" /> : <Lead text={initials(m.name)} />}
            name={<>{m.name}{m.kind === "agent" ? <span className="ml-1.5 font-mono text-xs font-normal text-muted-foreground">@{m.id}</span> : <Badge variant="outline" className="ml-1.5 px-1.5 py-0 font-mono text-[10.5px] font-normal text-muted-foreground">person</Badge>}</>}
            meta={<>
              <Dots items={[
                m.title || "No role",
                depth === 0 && !lines.length && "Reports to no one",
                hoursText(m.schedule) && <span className="inline-flex items-center gap-1"><Icon name="clock" className="size-3" />{hoursText(m.schedule)}</span>,
              ]} />
              {lines.length > 0 && <span className="basis-full">{lines.join(" · ")}</span>}
            </>}
            menu={canEdit && <>
              <Button variant="ghost" size="sm" onClick={() => setEdit(m)}>Edit</Button>
              <RowMenu label={m.name} items={[
                { label: "Edit role and lines", icon: "pencil", onSelect: () => setEdit(m) },
                { label: "Remove from the chart", icon: "trash-2", destructive: true, onSelect: () => remove(m) },
              ]} />
            </>}
          />
        </div>
      ))}
      <WriteNote note={note} />
      {org.data && setup && <MemberDialog reply={org.data} member={edit} onClose={() => setEdit(null)} onDone={(t) => { setNote({ tone: "ok", text: t }); return reload() }} nameOf={name} />}
      {org.data && <AddMemberDialog reply={org.data} open={adding} onOpenChange={setAdding} onDone={(t) => { setNote({ tone: "ok", text: t }); return reload() }} />}
      {confirm.dialog}
    </SettingsGroup>
  )
}

function MemberSelect({ label, value, onChange, members, self, none }: {
  label: string; value: string; onChange: (v: string) => void; members: SetupMember[]; self: string; none: string
}) {
  return (
    <Field label={label}>
      <Choice label={label} value={value} onChange={onChange} options={[
        { value: "", label: none },
        ...members.filter((x) => x.ref !== self).map((x) => ({ value: x.ref, label: x.name + (x.kind === "person" ? " (person)" : "") })),
      ]} />
    </Field>
  )
}

function MemberDialog({ reply, member: m, onClose, onDone, nameOf }: {
  reply: OrgSetupReply; member: SetupMember | null; onClose: () => void; onDone: (text: string) => Promise<unknown>; nameOf: (ref?: string) => string
}) {
  const setup = reply.setup!
  const blank = { role: "", boss: "", dotted: "", acts: "", start: "", end: "", days: [] as string[] }
  const [f, setF] = useState(blank)
  const [moves, setMoves] = useState<string[] | null>(null)
  useEffect(() => {
    if (!m) return
    setMoves(null)
    setF({
      role: m.title || "", boss: lineTo(setup, m.ref, "reports-to"), dotted: lineTo(setup, m.ref, "dotted-line"), acts: lineTo(setup, m.ref, "acts-for"),
      start: m.schedule?.start || "", end: m.schedule?.end || "", days: m.schedule?.days ?? [],
    })
  }, [m, setup])
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => { setF((x) => ({ ...x, [k]: v })); setMoves(null) }
  if (!m) return null

  const plan = () => {
    const now: OrgChange[] = []
    if (f.role.trim() !== (m.title || "")) now.push({ op: "set-role", member: m.ref, role: f.role.trim() })
    const s = m.schedule
    if (m.kind === "agent" && (f.start !== (s?.start || "") || f.end !== (s?.end || "") || f.days.join() !== (s?.days ?? []).join())) {
      now.push({ op: "set-schedule", member: m.ref, start: f.start, end: f.end, days: WEEK.filter((d) => f.days.includes(d)) })
    }
    const lines: OrgChange[] = []
    for (const [type, to] of [["reports-to", f.boss], ["dotted-line", f.dotted], ["acts-for", f.acts]] as const) {
      const was = lineTo(setup, m.ref, type)
      if (was === to) continue
      // The server keeps one boss each, and orgConfirmFor swaps it; other lines are removed first.
      if (was && (!to || type !== "reports-to")) lines.push({ op: "remove-relation", from: m.ref, type, to: was })
      if (to) lines.push({ op: "add-relation", from: m.ref, type, to })
    }
    return { now, moves: lines.map((c) => orgConfirmFor(setup, c) ?? { text: "", steps: [c], undo: [] }) }
  }

  const submit = async () => {
    const p = plan()
    if (p.moves.length && !moves) { setMoves(p.moves.map((x) => x.text).filter(Boolean)); return { text: "" } }
    for (const c of p.now) await post(c)
    try { for (const x of p.moves) await applyOrgSteps(x.steps, x.undo) }
    catch (e) { if (e instanceof OrgUndoFailed) return { text: e.message }; throw e }
    await onDone(p.now.length + p.moves.length ? `Saved ${m.name}.` : `Nothing changed for ${m.name}.`)
  }
  const roles = reply.choices?.roles ?? []
  return (
    <FormDialog
      open={!!m} onOpenChange={(v) => { if (!v) onClose() }} title={`Edit ${m.name}`}
      description="A new line or a move asks you to confirm before it saves." submit={moves ? "Save the move" : "Save"} onSubmit={submit}
      advanced={<>
        <FieldRow>
          <MemberSelect label="Dotted line to" value={f.dotted} onChange={(v) => set("dotted", v)} members={setup.members} self={m.ref} none="None" />
          <MemberSelect label="Acts for" value={f.acts} onChange={(v) => set("acts", v)} members={setup.members} self={m.ref} none="None" />
        </FieldRow>
        {m.kind === "agent" && <>
          <FieldRow>
            <Field label="Works from"><input type="time" className={dialogInput + " font-mono"} value={f.start} onChange={(e) => set("start", e.target.value)} /></Field>
            <Field label="Until"><input type="time" className={dialogInput + " font-mono"} value={f.end} onChange={(e) => set("end", e.target.value)} /></Field>
          </FieldRow>
          <div role="group" aria-label="Working days" className="flex flex-col gap-1 text-sm">Days
            <span className="flex flex-wrap gap-1">
              {WEEK.map((d) => {
                const on = f.days.includes(d)
                return <Button key={d} type="button" size="xs" variant={on ? "secondary" : "ghost"} aria-pressed={on} className={cn(!on && "text-muted-foreground")} onClick={() => set("days", on ? f.days.filter((x) => x !== d) : [...f.days, d])}>{DAY_NAMES[d]}</Button>
              })}
            </span>
            <span className="text-xs text-muted-foreground">Empty hours or no day: 09:00 to 17:00, Monday to Friday.</span>
          </div>
        </>}
      </>}
    >
      <FieldRow>
        <Field label="Role">
          <input className={dialogInput} list="st-org-roles" maxLength={80} value={f.role} onChange={(e) => set("role", e.target.value)} placeholder="Engineer" autoComplete="off" />
          <datalist id="st-org-roles">{roles.map((r) => <option key={r.key} value={r.title} />)}</datalist>
        </Field>
        <MemberSelect label="Reports to" value={f.boss} onChange={(v) => set("boss", v)} members={setup.members} self={m.ref} none="No one" />
      </FieldRow>
      {moves && (
        <div role="status" className="rounded-md border border-border bg-muted/60 px-3 py-2 text-sm">
          {moves.length ? moves.map((t) => <p key={t}>{t}</p>) : <p>{nameOf(m.ref)}'s lines change.</p>}
        </div>
      )}
    </FormDialog>
  )
}

function AddMemberDialog({ reply, open, onOpenChange, onDone }: {
  reply: OrgSetupReply; open: boolean; onOpenChange: (v: boolean) => void; onDone: (text: string) => Promise<unknown>
}) {
  const inChart = new Set(reply.setup?.members.map((m) => m.ref))
  const agents = (reply.choices?.agents ?? []).filter((x) => !inChart.has(x.ref))
  const people = (reply.choices?.people ?? []).filter((x) => !inChart.has(x.ref))
  const [who, setWho] = useState("")
  const [role, setRole] = useState("")
  useEffect(() => { if (open) { setWho(agents[0]?.ref ?? people[0]?.ref ?? ""); setRole("") } }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const submit = async () => {
    if (!who) return { text: "Everyone is in the chart already." }
    await post({ op: "add-member", member: who, role: role.trim() })
    await onDone("Added to the org chart.")
  }
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title="Add to the org chart" description="An agent or a person, with a role. Saves at once." submit="Add member" onSubmit={submit}>
      <FieldRow>
        <Field label="Member">
          <Choice
            label="Member" value={who} onChange={setWho} disabled={!agents.length && !people.length}
            options={agents.length || people.length
              ? [...agents.map((x) => ({ value: x.ref, label: "@" + x.ref.replace(/^agent:/, "") })), ...people.map((x) => ({ value: x.ref, label: x.name + " (person)" }))]
              : [{ value: "", label: "Everyone is in the chart" }]}
          />
        </Field>
        <Field label="Role">
          <input className={dialogInput} list="st-org-roles-add" maxLength={80} value={role} onChange={(e) => setRole(e.target.value)} placeholder="Engineer" autoComplete="off" />
          <datalist id="st-org-roles-add">{(reply.choices?.roles ?? []).map((r) => <option key={r.key} value={r.title} />)}</datalist>
        </Field>
      </FieldRow>
    </FormDialog>
  )
}
