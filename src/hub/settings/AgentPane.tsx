// --- Settings › Agent (#2101 ST2a) ---
//
// The mock's Agent (shots/2101-settings-mocks, settings/agent.html): one
// agent, picked at the top right, with its on/off switch, and the old agent
// page's five tabs. Overview is a form saved all at once (AgentOverview);
// the other tabs read and write their own lists (AgentFiles, AgentLinks).
//
// Which agent: `agent=` in the address (address.ts agentHash), else the
// first one. The tabs are folds of the shell (DisclosureContext): search
// opens `agent-tab:<tab>` and this pane switches to it, so a row on any tab
// is one search away (condition 1).
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useContext, useEffect, useState } from "react"
import { buildHash, useHashParams } from "../router"
import { Badge, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch, Tabs, TabsContent, TabsList, TabsTrigger, badgeVariants } from "../ui"
import { SETTINGS_PAGE } from "./address"
import type { AgentConfig, AgentDraft, AgentState } from "./agent-data"
import { AgentOverview } from "./AgentOverview"
import { FilesTab } from "./AgentFiles"
import { ChannelsTab, HandoversTab } from "./AgentLinks"
import { initials, orgNode } from "./data"
import { save, useGeneralData } from "./GeneralPane"
import { DisclosureContext, ErrorLine, PaneHeader, SkeletonRows } from "./parts"
import { paneDef } from "./panes"

const PANE = "agent"
const TABS = [["overview", "Overview"], ["personality", "Personality"], ["skills", "Skills"], ["channels", "Channels"], ["handovers", "Handovers"]] as const
type Tab = (typeof TABS)[number][0]

export default function AgentPane() {
  const { state, org, live } = useGeneralData()
  const params = useHashParams()
  const agents = (state.data as AgentState | undefined)?.agents ?? []
  const agent = agents.find((a) => a.id === params.get("agent")) ?? agents[0]
  const tab = useTabFolds()
  const [drafts, setDrafts] = useState<Record<string, AgentDraft>>({})

  if (state.isPending) return <><PaneHeader pane={paneDef(PANE)} /><SkeletonRows /></>
  if (state.isError) return <><PaneHeader pane={paneDef(PANE)} /><ErrorLine text={`Could not read agentx.json: ${(state.error as Error).message}`} onRetry={() => state.refetch()} /></>
  if (!agent) return <><PaneHeader pane={paneDef(PANE)} /><p className="py-4 text-sm text-muted-foreground">No agents yet. Add one on <a className="underline" href={buildHash({ page: SETTINGS_PAGE, section: "general", row: "add-agent" })}>General</a>.</p></>

  const node = orgNode(org.data, agent.id)
  const machine = live.data?.nodes?.find((n) => n.agents?.some((x) => (x.id || x.name) === agent.id))?.name
  const draft = drafts[agent.id] ?? {}
  const setDraft = (d: AgentDraft) => setDrafts((all) => ({ ...all, [agent.id]: d }))
  return (
    <>
      <header data-slot="settings-pane-header" className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span aria-hidden="true" className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-sm font-semibold text-muted-foreground">{initials(agent.name || agent.id)}</span>
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="text-2xl font-semibold leading-tight">{agent.name || agent.id}</h2>
            <p className="text-sm text-muted-foreground">
              <span className="font-mono text-xs">@{agent.id}</span>
              {node?.title && <> · {node.title}</>}
              {machine && <> · runs on <span className="font-mono text-xs">{machine}</span></>}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 max-sm:w-full">
          <AgentSelect agents={agents} value={agent.id} />
          <OnSwitch agent={agent} status={node?.status} />
        </div>
      </header>
      <Tabs value={tab.value} onValueChange={(v) => tab.set(v as Tab)}>
        <TabsList variant="line" aria-label={(agent.name || agent.id) + " settings"}>
          {TABS.map(([k, l]) => <TabsTrigger key={k} value={k}>{l}</TabsTrigger>)}
        </TabsList>
        <TabsContent value="overview" className="mt-6"><AgentOverview agent={agent} state={state.data as AgentState} draft={draft} setDraft={setDraft} /></TabsContent>
        <TabsContent value="personality" className="mt-6"><FilesTab agent={agent} part="identity" /></TabsContent>
        <TabsContent value="skills" className="mt-6"><FilesTab agent={agent} part="skills" /></TabsContent>
        <TabsContent value="channels" className="mt-6"><ChannelsTab agent={agent} state={state.data as AgentState} /></TabsContent>
        <TabsContent value="handovers" className="mt-6"><HandoversTab agent={agent} agents={agents} /></TabsContent>
      </Tabs>
    </>
  )
}

/** The tab shown. Search opens `agent-tab:<tab>` on the shell; the pane
 *  takes it and closes the fold again, so the next search opens it anew. */
function useTabFolds() {
  const { isOpen, setOpen } = useContext(DisclosureContext)
  const [value, set] = useState<Tab>("overview")
  const asked = TABS.map(([k]) => k).find((k) => isOpen("agent-tab:" + k))
  useEffect(() => {
    if (!asked) return
    set(asked)
    setOpen("agent-tab:" + asked, false)
  }, [asked, setOpen])
  return { value, set }
}

function AgentSelect({ agents, value }: { agents: AgentConfig[]; value: string }) {
  const pick = (id: string) => location.replace(buildHash({ page: SETTINGS_PAGE, section: PANE, agent: id }))
  return (
    <Select value={value} onValueChange={pick}>
      <SelectTrigger className="h-8 min-w-[150px] font-mono text-xs max-sm:flex-1" aria-label="Switch agent"><SelectValue /></SelectTrigger>
      <SelectContent align="end">
        {agents.map((a) => <SelectItem key={a.id} value={a.id} className="font-mono text-xs">@{a.id}</SelectItem>)}
      </SelectContent>
    </Select>
  )
}

/** On or off, as on General: off starts no new run. An agent that waits for
 *  approval has no switch, only the way to approve it. */
function OnSwitch({ agent, status }: { agent: AgentConfig; status?: string }) {
  const client = useQueryClient()
  const [error, setError] = useState("")
  const hold = useMutation({
    mutationFn: (paused: boolean) => save("POST", "/api/admin/wall/settings/org/hold", { agent: agent.id, paused }),
    onSuccess: () => { setError(""); return client.invalidateQueries({ queryKey: ["settings", "org"] }) },
    onError: (e) => setError("Not changed: " + (e as Error).message),
  })
  if (status === "waiting") return <a href="#status=open&view=decide" title="It starts once you approve it" className={badgeVariants({ variant: "warn" })}>Waits for approval</a>
  const on = status !== "paused"
  return (
    <span className="flex items-center gap-2 text-sm text-muted-foreground">
      {error ? <Badge variant="err" title={error}>Not changed</Badge> : on ? "On" : "Off"}
      <Switch checked={on} disabled={hold.isPending} onCheckedChange={(v) => hold.mutate(!v)} aria-label={(on ? "Turn off " : "Turn on ") + (agent.name || agent.id)} />
    </span>
  )
}
