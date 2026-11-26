// --- Settings › Agent › Channels and Handovers (#2101 ST2a) ---
//
// Channels: the agent's integrations (credentials as environment variable
// names, never values; /api/admin/state) and the Telegram bots bound to it,
// which Settings › Channels edits. Handovers: the chats routed to and away
// from it (GET /api/admin/agent/<id>/handovers), released or handed over
// with the old page's calls under the Settings prefix.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState, type FormEvent, type ReactNode } from "react"
import { apiGet } from "../api"
import {
  Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Icon,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue, cn,
} from "../ui"
import { settingsHash } from "./address"
import type { AgentConfig, AgentState, Integration } from "./agent-data"
import { save } from "./GeneralPane"
import { ConfirmDialog, ErrorLine, INPUT, RowMenu, SettingsGroup, SettingsItem, SettingsRow, SkeletonRows } from "./parts"

const PANE = "agent"
const INT_KINDS = ["gitlab-user", "github-user", "gmail", "hotmail", "smtp", "telegram-bot", "whatsapp", "slack-bot", "discord-bot", "hubspot", "salesforce",
  "pipedrive", "odoo", "trello", "linear", "asana", "jira", "notion", "stripe", "sentry", "vercel", "twilio", "custom"]

/** An integration's state in one word: its sign-in, else its credentials. */
export function integrationBadge(i: Integration): { variant: "ok" | "warn" | "secondary"; text: string } {
  if (i.enabled === false) return { variant: "secondary", text: "Off" }
  if (i.oauth) return !i.oauth.connected ? { variant: "warn", text: "Not connected" } : i.oauth.problems?.length ? { variant: "warn", text: "Needs attention" } : { variant: "ok", text: "Connected" }
  const st = Object.values(i.credStatus ?? {})
  return st.includes("unset") ? { variant: "warn", text: "Not set" } : { variant: "ok", text: "Set" }
}

function integrationMeta(i: Integration): ReactNode {
  if (i.oauth) {
    const exp = i.oauth.expiresAt ? new Date(i.oauth.expiresAt).toISOString().slice(0, 10) : ""
    return [i.oauth.title, i.oauth.refreshes && "renews itself", exp && "expires " + exp, ...(i.oauth.problems ?? [])].filter(Boolean).join(" · ")
  }
  const unset = Object.entries(i.credStatus ?? {}).filter(([, s]) => s === "unset").map(([k]) => i.credentials?.[k])
  const refs = Object.values(i.credentials ?? {})
  const meta = Object.entries(i.metadata ?? {}).map(([k, v]) => `${k}=${v}`)
  return <>
    {refs.map((r) => <span key={r} className="font-mono text-xs">{r}</span>)}
    {unset.length > 0 && <span>is not in the environment</span>}
    {meta.length > 0 && <><span aria-hidden="true">·</span><span>{meta.join(" · ")}</span></>}
  </>
}

export function ChannelsTab({ agent: a, state }: { agent: AgentConfig; state: AgentState }) {
  const client = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<Integration | null>(null)
  const list = a.integrations ?? []
  const bots = (state.telegram?.accounts ?? []).filter((t) => t.agentBinding === a.id)
  return (
    <div className="flex flex-col gap-8">
      <SettingsGroup
        pane={PANE} row="integrations" help="Credentials for outside services. Only the variable names are kept; secrets stay in .env or the keyring."
        action={<Button variant="outline" size="sm" onClick={() => setAdding(true)}><Icon name="plus" className="size-3.5" />Add integration</Button>}
      >
        {list.length ? list.map((i) => {
          const b = integrationBadge(i)
          return (
            <SettingsItem
              key={i.kind + "/" + i.label} id={`int-${i.kind}-${i.label}`}
              lead={<span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground"><Icon name={i.oauth ? "mail" : "plug"} className="size-3.5" /></span>}
              name={<>{i.label}<Badge variant="outline" className="ml-1.5 rounded-sm px-1 py-0 font-mono text-[11px] font-normal text-muted-foreground">{i.kind}</Badge></>}
              meta={integrationMeta(i)}
              badge={<Badge variant={b.variant}>{b.text}</Badge>}
              menu={<RowMenu label={i.label} items={[{ label: "Remove", icon: "trash-2", destructive: true, onSelect: () => setRemoving(i) }]} />}
            />
          )
        }) : <div className="flex items-center justify-between gap-4 py-4 text-sm text-muted-foreground">None yet.<Button variant="outline" size="sm" onClick={() => setAdding(true)}>Add integration</Button></div>}
      </SettingsGroup>
      <SettingsGroup pane={PANE} title="Chats and bots">
        <SettingsRow
          pane={PANE} row="bots" label="Telegram bot"
          help={bots.length ? <>{bots.map((t) => <span key={t.id} className="font-mono">@{t.botUsername || t.id} </span>)}answer{bots.length === 1 ? "s" : ""} as this agent</> : "No Telegram bot answers as this agent."}
          control={<Button asChild variant="outline" size="sm"><a href={settingsHash("channels")}>Open in Channels</a></Button>}
        />
      </SettingsGroup>
      <AddIntegrationDialog open={adding} onOpenChange={setAdding} agent={a.id} />
      <ConfirmDialog
        open={!!removing} onOpenChange={(v) => { if (!v) setRemoving(null) }}
        title={`Remove ${removing?.label ?? ""}?`} text={`${removing?.kind} is removed from @${a.id}. The secret stays in the environment.`} yes="Remove"
        run={async () => {
          await save("DELETE", "/api/admin/wall/settings/agents/integrations", { agentId: a.id, kind: removing!.kind, label: removing!.label })
          await client.invalidateQueries({ queryKey: ["settings", "state"] })
        }}
      />
    </div>
  )
}

function AddIntegrationDialog({ open, onOpenChange, agent }: { open: boolean; onOpenChange: (v: boolean) => void; agent: string }) {
  const client = useQueryClient()
  const empty = { kind: "", label: "", env: "", meta: "" }
  const [f, setF] = useState(empty)
  const [error, setError] = useState("")
  const add = useMutation({
    mutationFn: () => {
      const metadata: Record<string, string> = {}
      f.meta.split(",").forEach((pair) => { const i = pair.indexOf("="), k = (i < 0 ? pair : pair.slice(0, i)).trim(); if (k) metadata[k] = i < 0 ? "" : pair.slice(i + 1).trim() })
      return save("POST", "/api/admin/wall/settings/agents/integrations", { agentId: agent, kind: f.kind, label: f.label.trim(), credentials: { tokenEnv: f.env.trim() }, metadata })
    },
    onSuccess: () => { close(false); return client.invalidateQueries({ queryKey: ["settings", "state"] }) },
    onError: (e) => setError("Not added: " + (e as Error).message),
  })
  const close = (v: boolean) => { onOpenChange(v); if (!v) { setF(empty); setError("") } }
  const set = (k: keyof typeof empty, v: string) => { setF((x) => ({ ...x, [k]: v })); setError("") }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!f.kind || !f.label.trim()) return setError("Pick a kind and write a label.")
    if (!/^[A-Z][A-Z0-9_]*$/.test(f.env.trim())) return setError("Write the token's environment variable, in capitals, such as CRM_TOKEN.")
    add.mutate()
  }
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add integration</DialogTitle>
          <DialogDescription>Only the variable's name is kept. Keyring and sign-in folders are set with the agentx CLI.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1 text-sm">Kind
              <Select value={f.kind} onValueChange={(v) => set("kind", v)}>
                <SelectTrigger className="h-9 w-full font-mono text-xs" aria-label="Kind"><SelectValue placeholder="Pick one" /></SelectTrigger>
                <SelectContent>{INT_KINDS.map((k) => <SelectItem key={k} value={k} className="font-mono text-xs">{k}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <label className="flex flex-col gap-1 text-sm">Label
              <input className={cn(INPUT, "h-9 w-full")} maxLength={80} value={f.label} onChange={(e) => set("label", e.target.value)} placeholder="Team CRM" />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-sm">Token environment variable
            <input className={cn(INPUT, "h-9 w-full font-mono")} value={f.env} onChange={(e) => set("env", e.target.value)} placeholder="CRM_TOKEN" autoComplete="off" />
          </label>
          <label className="flex flex-col gap-1 text-sm">Details
            <input className={cn(INPUT, "h-9 w-full font-mono")} value={f.meta} onChange={(e) => set("meta", e.target.value)} placeholder="host=gitlab.com" />
            <span className="text-xs text-muted-foreground">Optional. key=value, comma separated.</span>
          </label>
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => close(false)}>Cancel</Button>
            <Button type="submit" disabled={add.isPending}>{add.isPending ? "Adding…" : "Add integration"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

interface Handover { channel: string; chatId: string; accountId?: string; toAgent?: string; fromAgent?: string; expiresAt?: string; summary?: string; summaryConsumedAt?: string }

export function HandoversTab({ agent: a, agents }: { agent: AgentConfig; agents: AgentConfig[] }) {
  const client = useQueryClient()
  const key = ["settings", "handovers", a.id]
  const path = "/api/admin/agent/" + encodeURIComponent(a.id) + "/handovers"
  const ho = useQuery({ queryKey: key, queryFn: () => apiGet<{ outgoing?: Handover[]; incoming?: Handover[] }>(path) })
  const [releasing, setReleasing] = useState<Handover | null>(null)
  const [adding, setAdding] = useState(false)
  const name = a.name || a.id
  const rows = (list: Handover[] | undefined, out: boolean) => !list?.length
    ? <p className="py-4 text-sm text-muted-foreground">{out ? `No chat is routed away from ${name}.` : `No chat is routed to ${name}.`}</p>
    : list.map((o) => (
      <SettingsItem
        key={o.channel + o.chatId + (o.accountId ?? "")} id={`ho-${o.channel}-${o.chatId}`}
        name={<>{o.channel[0].toUpperCase() + o.channel.slice(1)} · <span className="font-mono text-[13px] font-normal">{o.chatId}</span></>}
        meta={<>
          {out ? <>Handed to <span className="font-mono text-xs">@{o.toAgent}</span></> : <>From <span className="font-mono text-xs">@{o.fromAgent}</span></>}
          <span aria-hidden="true">·</span>{o.expiresAt ? "until " + o.expiresAt.slice(0, 10) : "no end"}
          {o.summary && <><span aria-hidden="true">·</span>{o.summaryConsumedAt ? "note read" : "note not read yet"}</>}
        </>}
        control={<Button variant="ghost" size="sm" onClick={() => setReleasing(o)}>Release</Button>}
      />
    ))
  if (ho.isPending) return <SkeletonRows />
  if (ho.isError) return <ErrorLine text={`Could not read the handovers: ${(ho.error as Error).message}`} onRetry={() => ho.refetch()} />
  return (
    <div className="flex flex-col gap-8">
      <SettingsGroup
        pane={PANE} row="handovers" title={`Routed away from ${name}`} help="Every message from these chats goes to another agent until you release it."
        action={<Button variant="outline" size="sm" onClick={() => setAdding(true)}><Icon name="arrow-right-left" className="size-3.5" />Hand a chat over</Button>}
      >
        {rows(ho.data.outgoing, true)}
      </SettingsGroup>
      <SettingsGroup pane={PANE} title={`Routed to ${name}`}>{rows(ho.data.incoming, false)}</SettingsGroup>
      <ConfirmDialog
        open={!!releasing} onOpenChange={(v) => { if (!v) setReleasing(null) }}
        title={`Release ${releasing?.channel} ${releasing?.chatId}?`} text="Its next message goes where agentx.json routes it." yes="Release"
        run={async () => { await save("DELETE", "/api/admin/wall/settings/agent/" + encodeURIComponent(a.id) + "/handovers", { channel: releasing!.channel, chatId: releasing!.chatId, accountId: releasing!.accountId || undefined }); await client.invalidateQueries({ queryKey: key }) }}
      />
      <HandOverDialog open={adding} onOpenChange={setAdding} agent={a} others={agents.filter((x) => x.id !== a.id)} onDone={() => client.invalidateQueries({ queryKey: key })} />
    </div>
  )
}

function HandOverDialog({ open, onOpenChange, agent: a, others, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; agent: AgentConfig; others: AgentConfig[]; onDone: () => void }) {
  const empty = { channel: "telegram", chatId: "", toAgent: "", accountId: "", summary: "", expiresAt: "" }
  const [f, setF] = useState(empty)
  const [error, setError] = useState("")
  const add = useMutation({
    mutationFn: () => save("POST", "/api/admin/wall/settings/agent/" + encodeURIComponent(a.id) + "/handovers", {
      channel: f.channel, chatId: f.chatId.trim(), toAgent: f.toAgent, accountId: f.accountId.trim() || undefined, summary: f.summary.trim() || undefined, expiresAt: f.expiresAt.trim() || undefined,
    }),
    onSuccess: () => { close(false); onDone() },
    onError: (e) => setError("Not handed over: " + (e as Error).message),
  })
  const close = (v: boolean) => { onOpenChange(v); if (!v) { setF(empty); setError("") } }
  const set = (k: keyof typeof empty, v: string) => { setF((x) => ({ ...x, [k]: v })); setError("") }
  const submit = (e: FormEvent) => { e.preventDefault(); if (!f.chatId.trim() || !f.toAgent) return setError("Write the chat id and pick the agent that takes it."); add.mutate() }
  const field = "flex flex-col gap-1 text-sm"
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Hand a chat over</DialogTitle>
          <DialogDescription>Every message from the chat goes to the agent you pick until you release it.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className={field}>Channel
              <Select value={f.channel} onValueChange={(v) => set("channel", v)}>
                <SelectTrigger className="h-9 w-full" aria-label="Channel"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="telegram">Telegram</SelectItem><SelectItem value="whatsapp">WhatsApp</SelectItem></SelectContent>
              </Select>
            </div>
            <label className={field}>Chat id<input className={cn(INPUT, "h-9 w-full font-mono")} value={f.chatId} onChange={(e) => set("chatId", e.target.value)} autoComplete="off" /></label>
          </div>
          <div className={field}>Hand to
            <Select value={f.toAgent} onValueChange={(v) => set("toAgent", v)}>
              <SelectTrigger className="h-9 w-full" aria-label="Hand to"><SelectValue placeholder="Pick an agent" /></SelectTrigger>
              <SelectContent>{others.map((x) => <SelectItem key={x.id} value={x.id}>{x.name || x.id} <span className="font-mono text-xs text-muted-foreground">@{x.id}</span></SelectItem>)}</SelectContent>
            </Select>
          </div>
          <label className={field}>A note for the agent that takes it
            <textarea rows={3} className={cn(INPUT, "h-auto w-full py-2")} value={f.summary} onChange={(e) => set("summary", e.target.value)} />
            <span className="text-xs text-muted-foreground">Optional. Read once, with the next message.</span>
          </label>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className={field}>Until<input className={cn(INPUT, "h-9 w-full font-mono")} value={f.expiresAt} onChange={(e) => set("expiresAt", e.target.value)} placeholder="2026-12-01" /></label>
            <label className={field}>Bot account<input className={cn(INPUT, "h-9 w-full font-mono")} value={f.accountId} onChange={(e) => set("accountId", e.target.value)} placeholder="default" /></label>
          </div>
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => close(false)}>Cancel</Button>
            <Button type="submit" disabled={add.isPending}>{add.isPending ? "Handing over…" : "Hand over"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
