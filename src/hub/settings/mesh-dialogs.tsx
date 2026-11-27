// --- Settings › Mesh: Add peer, Make token and the one-time token (#2101 ST3b) ---
//
// The old Settings' forms (wall-settings-mesh.client.ts) in FormDialogs, as
// the mock draws them. A peer's token is taken as the NAME of the .env
// variable that holds it and written as a ${NAME} reference, never as a
// value. A new token is shown once, then forgotten.
import { useEffect, useState } from "react"
import { Button, Icon, cn } from "../ui"
import { CopyButton, Field, FieldRow, dialogInput, type Send } from "./fields"
import { FormDialog, type Invalid } from "./parts"
import { tokenScopes } from "./system-data"
import { ENV_NAME } from "./work-data"

const mono = dialogInput + " font-mono"

export function AddPeerDialog({ open, onOpenChange, send }: { open: boolean; onOpenChange: (v: boolean) => void; send: Send }) {
  const [f, setF] = useState({ name: "", url: "", env: "" })
  useEffect(() => { if (open) setF({ name: "", url: "", env: "" }) }, [open])
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }))
  const submit = async (): Promise<Invalid> => {
    const name = f.name.trim(), url = f.url.trim(), env = f.env.trim()
    if (!name) return { field: "name", text: "Give the peer a name." }
    if (!/^https?:\/\//.test(url)) return { field: "url", text: "Start the address with http:// or https://." }
    // A token typed here would be stored as it is: only a name goes.
    if (env && !ENV_NAME.test(env)) return { field: "env", text: "Type the name of the .env variable, such as PEER_TOKEN, not the token itself." }
    await send("POST", "mesh/peers", { name, url, ...(env ? { token: "${" + env + "}" } : {}) }, `Added the peer ${name}.`)
  }
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title="Add peer" description="Another AgentX machine this one shares work with." submit="Add peer" onSubmit={submit}>
      <FieldRow>
        <Field label="Peer name"><input autoFocus className={mono} value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="office-server" autoComplete="off" spellCheck={false} /></Field>
        <Field label="Address"><input className={mono} value={f.url} onChange={(e) => set("url", e.target.value)} placeholder="http://192.168.1.50:18800" autoComplete="off" spellCheck={false} /></Field>
      </FieldRow>
      <Field label="Token" help="The name of the .env variable that holds a mesh:peer token. Optional.">
        <input className={mono} value={f.env} onChange={(e) => set("env", e.target.value)} placeholder="PEER_TOKEN" autoComplete="off" spellCheck={false} />
      </Field>
    </FormDialog>
  )
}

export function MakeTokenDialog({ open, onOpenChange, agents, send, onMade }: {
  open: boolean; onOpenChange: (v: boolean) => void; agents: { id: string; name?: string; access?: string }[]; send: Send; onMade: (token: string) => void
}) {
  const [name, setName] = useState("")
  const [days, setDays] = useState("")
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => { if (open) { setName(""); setDays(""); setPicked(new Set()) } }, [open])
  const flip = (s: string) => setPicked((x) => { const n = new Set(x); if (n.has(s)) n.delete(s); else n.add(s); return n })
  const submit = async (): Promise<Invalid> => {
    if (!name.trim()) return { field: "name", text: "Give the token a name." }
    if (!picked.size) return { field: "scopes", text: "Pick at least one scope." }
    const d = days.trim() ? Number(days) : undefined
    if (d !== undefined && !(Number.isInteger(d) && d > 0)) return { field: "days", text: "Days is a whole number above 0, or empty for never." }
    const r = (await send("POST", "tokens", { name: name.trim(), scopes: [...picked], ...(d ? { expiresInDays: d } : {}) }, `Made the token ${name.trim()}.`)) as { token?: string }
    onMade(r?.token ?? "")
  }
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title="Make token" description="It is shown once, right after it is made." submit="Make token" onSubmit={submit}>
      <Field label="Name" help="Who or what it is for.">
        <input autoFocus className={dialogInput} value={name} onChange={(e) => setName(e.target.value)} placeholder="Chat bridge" autoComplete="off" />
      </Field>
      <fieldset className="flex flex-col gap-0.5 text-sm">
        <legend className="mb-1">Scopes</legend>
        {tokenScopes(agents).map(([s, label]) => (
          <label key={s} className="flex cursor-pointer items-start gap-2.5 rounded-md px-1 py-1.5 hover:bg-accent/60">
            <input type="checkbox" className="mt-0.5 size-4 accent-foreground" checked={picked.has(s)} onChange={() => flip(s)} />
            <span className="flex flex-col"><span className="font-mono text-[13px]">{s}</span><span className="text-xs text-muted-foreground">{label}</span></span>
          </label>
        ))}
      </fieldset>
      <Field label="Expires after (days)" help="Empty: never.">
        <input className={cn(dialogInput, "w-28")} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} placeholder="90" />
      </Field>
    </FormDialog>
  )
}

/** The token just made, once. Copy turns into a check for 2 s (A6). */
export function NewToken({ token, onDone }: { token: string; onDone: () => void }) {
  return (
    <section role="status" data-slot="settings-new-token" className="flex flex-col gap-3 rounded-xl border border-ok/50 bg-card/50 p-5 shadow-xs">
      <h3 className="flex items-center gap-2 text-sm font-semibold"><Icon name="key-round" className="size-3.5" />Copy it now: it is not shown again</h3>
      <div className="flex items-start gap-2">
        <code className="block min-w-0 flex-1 select-all break-all rounded-md bg-muted px-3 py-2 font-mono text-[13px]">{token}</code>
        <CopyButton text={token} label="Copy token" />
      </div>
      <div><Button variant="ghost" size="sm" onClick={onDone}>Done</Button></div>
    </section>
  )
}
