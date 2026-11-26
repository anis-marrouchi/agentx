// --- Settings › General (#2101 ST1) ---
//
// The mock's General (shots/2101-settings-mocks, settings/general.html):
// what needs you, the agents with their on/off switch, the machines this hub
// reaches with channels and tokens, and the wiki page curator under
// Advanced. Every change saves at once through the old Settings' endpoints,
// so there is no Save button on this pane.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState, type FormEvent, type ReactNode } from "react"
import { engineIcon } from "../../daemon/ui/pages/engine-icons"
import { apiFetch, apiGet } from "../api"
import {
  Badge, badgeVariants, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Icon,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, Switch, Tooltip, TooltipContent, TooltipTrigger,
} from "../ui"
import { settingsHash } from "./address"
import {
  AGENT_ID, ENGINE_CHOICES, activeTokens, channelSummary, engineName, initials, needsYou, nodeChecking, nodeDown, orgNode, restartWaiting,
  type AdminState, type LiveNode, type LiveReply, type OrgReply, type StateAgent, type TokenRow,
} from "./data"
import { Disclosure, PaneHeader, SettingsGroup, SettingsItem, SettingsRow, ToneDot } from "./parts"
import { paneDef } from "./panes"

const PANE = "general"
const RESTART = "agentx daemon restart --when-idle"
const OWNER_AGENT = "__owner"

/** A write; apiFetch throws with the server's error text when it fails. */
async function save(method: string, path: string, body: unknown): Promise<{ summary?: string }> {
  return apiFetch(path, { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } })
}

export function EngineLogo({ tier }: { tier?: string }) {
  return <span aria-hidden="true" className="inline-flex size-3.5 shrink-0 [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: engineIcon(tier || "claude-code") }} />
}

export function useGeneralData() {
  const state = useQuery({ queryKey: ["settings", "state"], queryFn: () => apiGet<AdminState>("/api/admin/state") })
  const org = useQuery({ queryKey: ["settings", "org"], queryFn: () => apiGet<OrgReply>("/api/admin/org") })
  const live = useQuery({ queryKey: ["settings", "live"], queryFn: () => apiGet<LiveReply>("/api/live?quick=1"), refetchInterval: 60_000 })
  const tokens = useQuery({ queryKey: ["settings", "tokens"], queryFn: () => apiGet<TokenRow[]>("/api/admin/tokens") })
  return { state, org, live, tokens }
}

export default function GeneralPane() {
  const pane = paneDef(PANE)
  const { state, org, live, tokens } = useGeneralData()
  const [adding, setAdding] = useState(false)
  const agents = state.data?.agents ?? []
  const fixes = needsYou(live.data, agents, org.data)
  return (
    <>
      <PaneHeader pane={pane} />
      <div className="flex flex-col gap-8">
        {fixes.length > 0 && (
          <SettingsGroup pane={PANE} row="needs-you" help={fixes.length === 1 ? "1 thing to fix" : `${fixes.length} things to fix`}>
            {fixes.map((f) => (
              <SettingsItem
                key={f.key} id={f.key}
                name={<><ToneDot tone={f.tone} />{f.text}</>}
                meta={f.help}
                control={<Button asChild variant="outline" size="sm"><a href={f.href}>{f.action}</a></Button>}
              />
            ))}
          </SettingsGroup>
        )}
        <AgentsGroup state={state} org={org.data} onAdd={() => setAdding(true)} />
        <MachinesGroup live={live} state={state.data} tokens={tokens.data} tokensFailed={tokens.isError} />
        <section data-slot="settings-group" aria-label="Advanced" className="rounded-xl border border-border bg-card/50 px-5 shadow-xs">
          <Disclosure id="general-advanced" label="Advanced">
            <CuratorRows state={state.data} />
          </Disclosure>
        </section>
      </div>
      <AddAgentDialog open={adding} onOpenChange={setAdding} taken={agents.map((a) => a.id)} />
    </>
  )
}

function AgentsGroup({ state, org, onAdd }: { state: ReturnType<typeof useGeneralData>["state"]; org?: OrgReply; onAdd: () => void }) {
  const client = useQueryClient()
  const [note, setNote] = useState<{ tone: "ok" | "err"; text: string } | null>(null)
  const hold = useMutation({
    mutationFn: (v: { agent: string; paused: boolean }) => save("POST", "/api/admin/wall/settings/org/hold", v),
    onSuccess: (_r, v) => {
      setNote({ tone: "ok", text: v.paused ? `@${v.agent} is off: it starts no run until you turn it back on.` : `@${v.agent} is on.` })
      return client.invalidateQueries({ queryKey: ["settings", "org"] })
    },
    onError: (e, v) => setNote({ tone: "err", text: `@${v.agent} not changed: ${(e as Error).message}` }),
  })
  const agents = state.data?.agents ?? []
  const on = agents.filter((a) => orgNode(org, a.id)?.status !== "paused" && orgNode(org, a.id)?.status !== "waiting").length
  const help = state.data ? `${agents.length} agents · ${on} on · Off stops an agent starting new runs` : undefined
  return (
    <SettingsGroup
      pane={PANE} row="agents" help={help}
      action={<Button variant="outline" size="sm" onClick={onAdd} data-row="add-agent"><Icon name="plus" className="size-3.5" />Add agent</Button>}
    >
      {state.isPending ? <SkeletonRows /> : state.isError ? (
        <ErrorLine text={`Could not read agentx.json: ${(state.error as Error).message}`} onRetry={() => state.refetch()} />
      ) : agents.length === 0 ? (
        <div className="flex items-center justify-between gap-4 py-4 text-sm text-muted-foreground">
          No agents yet.<Button variant="outline" size="sm" onClick={onAdd}>Add agent</Button>
        </div>
      ) : agents.map((a) => <AgentItem key={a.id} agent={a} org={org} busy={hold.isPending && hold.variables?.agent === a.id} onHold={(paused) => hold.mutate({ agent: a.id, paused })} />)}
      {note && <p role="status" className={note.tone === "err" ? "py-2.5 text-xs text-destructive" : "py-2.5 text-xs text-muted-foreground"}>{note.text}</p>}
    </SettingsGroup>
  )
}

function AgentItem({ agent: a, org, busy, onHold }: { agent: StateAgent; org?: OrgReply; busy: boolean; onHold: (paused: boolean) => void }) {
  const node = orgNode(org, a.id)
  const name = a.name || a.id
  const waiting = node?.status === "waiting"
  const isOn = node?.status !== "paused"
  const open = settingsHash("agent", a.id)
  return (
    <SettingsItem
      id={"agent-" + a.id}
      muted={!waiting && !isOn}
      lead={<span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-[11px] font-semibold text-muted-foreground">{initials(name)}</span>}
      name={<a href={open} className="font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{name}<span className="ml-1.5 font-mono text-xs font-normal text-muted-foreground">@{a.id}</span></a>}
      meta={<>
        {node?.title && <><span>{node.title}</span><span aria-hidden="true">·</span></>}
        <EngineLogo tier={a.tier} /><span>{engineName(a.tier)}</span>
        {a.model && <><span aria-hidden="true">·</span><span className="font-mono text-xs">{a.model}</span></>}
        {a.access === "public" && <><span aria-hidden="true">·</span><span>public API</span></>}
      </>}
      badge={waiting ? (
        <a href="#status=open&view=decide" title="It starts once you approve it" className={badgeVariants({ variant: "warn" })}>Waits for approval</a>
      ) : undefined}
      control={<>
        {!waiting && <Switch checked={isOn} disabled={busy} onCheckedChange={(v) => onHold(!v)} aria-label={(isOn ? "Turn off " : "Turn on ") + name} />}
        <Tooltip>
          <TooltipTrigger asChild>
            <a href={open} aria-label={"Open " + name} className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <Icon name="chevron-right" className="size-3.5" />
            </a>
          </TooltipTrigger>
          <TooltipContent>Open settings</TooltipContent>
        </Tooltip>
      </>}
    />
  )
}

function machineBadge(n: LiveNode) {
  if (nodeChecking(n)) return <Badge variant="secondary">Checking</Badge>
  if (nodeDown(n)) return <Badge variant="err">Not answering</Badge>
  if (restartWaiting(n)) return <Badge variant="warn">Restart waiting</Badge>
  return <Badge variant="ok">Answering</Badge>
}

function MachinesGroup({ live, state, tokens, tokensFailed }: {
  live: ReturnType<typeof useGeneralData>["live"]; state?: AdminState; tokens?: TokenRow[]; tokensFailed: boolean
}) {
  const nodes = live.data?.nodes ?? []
  const ch = state?.exists === false ? null : state ? channelSummary(state) : undefined
  const off = ch ? ch.set.filter((c) => !ch.on.includes(c)) : []
  const nTokens = activeTokens(tokens)
  const link = (href: string, text: string) => (
    <Button asChild variant="ghost" size="sm"><a href={href}>{text}<Icon name="chevron-right" className="size-3.5" /></a></Button>
  )
  return (
    <SettingsGroup pane={PANE} row="machines">
      {live.isPending ? <SkeletonRows /> : live.isError ? (
        <ErrorLine text="Could not reach the machines just now." onRetry={() => live.refetch()} />
      ) : nodes.map((n) => {
        const who = (n.agents ?? []).map((a) => a.id || a.name).filter(Boolean).join(", ")
        const since = nodeDown(n) && n.staleSince ? <Ago iso={n.staleSince} prefix="Last answered " /> : null
        const meta = [n.version && !since ? `v${n.version}` : "", who].filter(Boolean).join(" · ")
        return <SettingsItem key={n.name} id={"machine-" + n.name} name={<span className="font-mono text-[13px] font-normal">{n.name}</span>} meta={<>{since}{since && meta && <span aria-hidden="true">·</span>}{meta}</>} badge={machineBadge(n)} />
      })}
      <SettingsRow
        pane={PANE} row="channels"
        help={ch ? (ch.set.length ? `${ch.on.join(", ") || "None"} on${off.length ? ` · ${off.join(", ")} off` : ""}` : "None set up yet") : undefined}
        control={ch && link(settingsHash("channels"), `${ch.on.length} of ${ch.set.length} on`)}
      />
      <SettingsRow
        pane={PANE} row="tokens"
        control={tokensFailed ? <span className="text-xs text-muted-foreground">Could not read</span> : nTokens != null && link(settingsHash("mesh"), `${nTokens} active`)}
      />
    </SettingsGroup>
  )
}

function CuratorRows({ state }: { state?: AdminState }) {
  const client = useQueryClient()
  const cur = state?.wikiCurator ?? { enabled: true, agent: "" }
  const [error, setError] = useState("")
  const put = useMutation({
    mutationFn: (v: { enabled: boolean; agent: string }) => save("POST", "/api/admin/wall/settings/wiki/curator", v),
    onSuccess: () => { setError(""); return client.invalidateQueries({ queryKey: ["settings", "state"] }) },
    onError: (e) => setError("Not saved: " + (e as Error).message),
  })
  const enabled = cur.enabled !== false
  const agent = cur.agent || ""
  return (
    <>
      <SettingsRow
        pane={PANE} row="curator"
        help={error ? <span className="text-destructive">{error}</span> : undefined}
        control={<Switch checked={enabled} disabled={!state || put.isPending} onCheckedChange={(v) => put.mutate({ enabled: v, agent })} aria-label="Wiki page curator" />}
      />
      <SettingsRow
        pane={PANE} row="curator-agent"
        control={
          <Select value={agent || OWNER_AGENT} disabled={!state || put.isPending} onValueChange={(v) => put.mutate({ enabled, agent: v === OWNER_AGENT ? "" : v })}>
            <SelectTrigger className="w-[180px]" aria-label="Agent that answers"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={OWNER_AGENT}>The page's owner</SelectItem>
              {(state?.agents ?? []).map((a) => <SelectItem key={a.id} value={a.id}>{a.name || a.id}</SelectItem>)}
            </SelectContent>
          </Select>
        }
      />
    </>
  )
}

interface AddForm { id: string; name: string; triggerWords: string; tier: string; model: string; personality: string; public: boolean }
const EMPTY: AddForm = { id: "", name: "", triggerWords: "", tier: "claude-code", model: "", personality: "", public: false }

function AddAgentDialog({ open, onOpenChange, taken }: { open: boolean; onOpenChange: (v: boolean) => void; taken: string[] }) {
  const client = useQueryClient()
  const [f, setF] = useState<AddForm>(EMPTY)
  const [more, setMore] = useState(false)
  const [error, setError] = useState<{ field?: keyof AddForm; text: string } | null>(null)
  const [done, setDone] = useState("")
  const add = useMutation({
    mutationFn: async (v: AddForm) => {
      await save("POST", "/api/admin/wall/settings/agents", {
        id: v.id, name: v.name || undefined, triggerWords: v.triggerWords, tier: v.tier,
        model: v.model || undefined, personality: v.personality || undefined, access: v.public ? "public" : "private",
      })
      if (v.public) await save("POST", "/api/admin/wall/settings/agents/access", { id: v.id, access: "public" })
    },
    onSuccess: (_r, v) => {
      setDone(`Added @${v.id}. It starts after ${RESTART}.`)
      setF(EMPTY)
      return client.invalidateQueries({ queryKey: ["settings"] })
    },
    onError: (e) => setError({ text: "Not added: " + (e as Error).message }),
  })
  const set = <K extends keyof AddForm>(k: K, v: AddForm[K]) => { setF((x) => ({ ...x, [k]: v })); setError(null) }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const id = f.id.trim()
    if (!id) return setError({ field: "id", text: "Give the agent an id." })
    if (!AGENT_ID.test(id)) return setError({ field: "id", text: "Use lowercase letters, digits, - and _." })
    if (taken.includes(id)) return setError({ field: "id", text: `@${id} already exists.` })
    add.mutate({ ...f, id, name: f.name.trim(), triggerWords: f.triggerWords.trim(), model: f.model.trim(), personality: f.personality.trim() })
  }
  const close = (v: boolean) => { onOpenChange(v); if (!v) { setDone(""); setError(null); setMore(false) } }
  const input = "h-9 w-full rounded-md border border-input bg-background px-3 text-base md:text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add agent</DialogTitle>
          <DialogDescription>An agent is a role with its own wake words and workspace.</DialogDescription>
        </DialogHeader>
        {done ? (
          <>
            <p role="status" className="text-sm">{done}</p>
            <DialogFooter><Button onClick={() => close(false)}>Done</Button></DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm">Agent id
                <input autoFocus className={input + " font-mono"} value={f.id} onChange={(e) => set("id", e.target.value)} placeholder="sales" autoComplete="off" aria-invalid={error?.field === "id"} />
                <span className="text-xs text-muted-foreground">Lowercase letters, digits, - and _</span>
              </label>
              <label className="flex flex-col gap-1 text-sm">Name
                <input className={input} value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="Sales Desk" />
              </label>
            </div>
            <label className="flex flex-col gap-1 text-sm">Wake words
              <input className={input} value={f.triggerWords} onChange={(e) => set("triggerWords", e.target.value)} placeholder="@sales, sales" />
              <span className="text-xs text-muted-foreground">Comma or space separated.</span>
            </label>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1 text-sm">AI engine
                <Select value={f.tier} onValueChange={(v) => set("tier", v)}>
                  <SelectTrigger className="h-9 w-full" aria-label="AI engine"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ENGINE_CHOICES.map((t) => <SelectItem key={t} value={t}><span className="flex items-center gap-2"><EngineLogo tier={t} />{engineName(t)}</span></SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <label className="flex flex-col gap-1 text-sm">Model
                <input className={input + " font-mono"} value={f.model} onChange={(e) => set("model", e.target.value)} placeholder="The engine's default" />
              </label>
            </div>
            <Disclosed open={more} onOpenChange={setMore}>
              <label className="flex flex-col gap-1 text-sm">Instructions
                <textarea rows={3} maxLength={4000} className={input + " h-auto py-2"} value={f.personality} onChange={(e) => set("personality", e.target.value)} placeholder="You answer pricing questions and pass support questions to @cx." />
              </label>
              <div className="flex items-center justify-between gap-4 text-sm">
                <span className="flex flex-col gap-0.5">Answer on the public API<span className="text-xs text-muted-foreground">A token with agent:&lt;id&gt; scope can reach it.</span></span>
                <Switch checked={f.public} onCheckedChange={(v) => set("public", v)} aria-label="Answer on the public API" />
              </div>
            </Disclosed>
            {error && <p role="alert" className="text-xs text-destructive">{error.text}</p>}
            <DialogFooter className="items-center">
              <span className="mr-auto text-xs text-muted-foreground">Starts after a daemon restart</span>
              <Button type="button" variant="ghost" onClick={() => close(false)}>Cancel</Button>
              <Button type="submit" disabled={add.isPending}>{add.isPending ? "Adding…" : "Add agent"}</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** The dialog's own Advanced fold (not a pane row, so not in search). */
function Disclosed({ open, onOpenChange, children }: { open: boolean; onOpenChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <div className="border-t border-border pt-1">
      <button type="button" aria-expanded={open} onClick={() => onOpenChange(!open)} className="flex min-h-9 w-full cursor-pointer items-center gap-2 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Icon name="chevron-right" className={"size-3.5 text-muted-foreground transition-transform duration-150 ease-out motion-reduce:transition-none" + (open ? " rotate-90" : "")} />
        Advanced
      </button>
      <div hidden={!open} className="flex flex-col gap-3 pb-1 pl-5">{children}</div>
    </div>
  )
}

/** One relative time format (orca-design C17): `now`, `2m`, `1h`, `2d`, the
 *  full stamp in its tooltip. */
function Ago({ iso, prefix = "" }: { iso: string; prefix?: string }) {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild><time dateTime={iso}>{prefix}{relTime(ms) === "now" ? "now" : relTime(ms) + " ago"}</time></TooltipTrigger>
      <TooltipContent>{new Date(ms).toLocaleString()}</TooltipContent>
    </Tooltip>
  )
}

export function relTime(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return "now"
  if (s < 3600) return Math.floor(s / 60) + "m"
  if (s < 86400) return Math.floor(s / 3600) + "h"
  return Math.floor(s / 86400) + "d"
}

function SkeletonRows() {
  return <div className="flex flex-col gap-3 py-4" aria-busy="true"><Skeleton className="h-5 w-2/3" /><Skeleton className="h-5 w-1/2" /><Skeleton className="h-5 w-3/5" /></div>
}

function ErrorLine({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex items-center justify-between gap-4 py-3 text-sm">
      <span className="text-destructive">{text}</span>
      <Button variant="outline" size="sm" onClick={onRetry}>Retry</Button>
    </div>
  )
}
