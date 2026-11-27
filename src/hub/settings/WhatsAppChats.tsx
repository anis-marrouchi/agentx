// --- Settings › WhatsApp: chats and the sweep (#2101 ST3a) ---
//
// What WhatsApp shows this daemon (GET channels/whatsapp/chats and
// contacts, read only when asked, the first 100 of each), and the sweep
// that writes them into an agent's wiki, as agentx whatsapp ingest-all does
// (POST …/channels/whatsapp/ingest). Dry run is on until you turn it off.
import { useMutation, useQuery } from "@tanstack/react-query"
import { useState, type ReactNode } from "react"
import { apiGet, apiPost } from "../api"
import { Button, Icon, Switch } from "../ui"
import { sweepLine } from "./channels-data"
import { AgentSelect, SETTINGS_API } from "./fields"
import { Disclosure, ErrorLine, IconButton, SettingsGroup, SettingsRow, SkeletonRows } from "./parts"

const PANE = "whatsapp"
const MAX = 100

interface Chat { jid: string; name?: string; isGroup?: boolean; unreadCount?: number }
interface Contact { jid: string; name?: string; phone?: string }

export function WhatsAppChats({ agents }: { agents: readonly { id: string }[] }) {
  const [shown, setShown] = useState(false)
  const [agent, setAgent] = useState("")
  const [dry, setDry] = useState(true)
  const [force, setForce] = useState(false)
  const lists = useQuery({
    queryKey: ["settings", "wa-lists"], enabled: shown,
    queryFn: async () => {
      const [c, p] = await Promise.all([apiGet<{ chats?: Chat[] }>("/api/admin/channels/whatsapp/chats"), apiGet<{ contacts?: Contact[] }>("/api/admin/channels/whatsapp/contacts")])
      return { chats: c.chats ?? [], contacts: p.contacts ?? [] }
    },
  })
  const sweep = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPost<Parameters<typeof sweepLine>[1]>(SETTINGS_API + "channels/whatsapp/ingest", body),
  })
  const go = () => sweep.mutate({ dryRun: dry, force, ...(agent ? { agent } : {}) })
  return (
    <SettingsGroup pane={PANE} title="Chats" help="Write the chats and contacts into an agent's wiki. Same as agentx whatsapp ingest-all.">
      {!shown ? (
        <SettingsRow pane={PANE} row="wa-chats" control={<Button variant="outline" size="sm" onClick={() => setShown(true)}>Show</Button>} />
      ) : lists.isPending ? <SkeletonRows /> : lists.isError ? (
        <ErrorLine text={`Could not read them: ${(lists.error as Error).message}`} onRetry={() => lists.refetch()} />
      ) : (
        <div data-row="wa-chats" className="grid grid-cols-1 gap-4 py-3 sm:grid-cols-2">
          <List title="Chats" count={lists.data.chats.length} items={lists.data.chats.slice(0, MAX).map((c) => [c.jid, c.name || c.jid, (c.isGroup ? "group" : "chat") + (c.unreadCount ? ` · ${c.unreadCount} unread` : "")])} />
          <List title="Contacts" count={lists.data.contacts.length} items={lists.data.contacts.slice(0, MAX).map((c) => [c.jid, c.name || c.phone || c.jid, c.phone && c.name !== c.phone ? c.phone : ""])}
            action={<IconButton icon="refresh-cw" label="Refresh" disabled={lists.isFetching} onClick={() => void lists.refetch()} />} />
        </div>
      )}
      <SettingsRow pane={PANE} row="wa-sweep" control={<AgentSelect label="Agent whose wiki gets them" className="h-8 w-44 sm:w-[230px]" value={agent} onChange={setAgent} agents={agents} none="WhatsApp's default agent" />} />
      <SettingsRow pane={PANE} row="wa-dry" control={<Switch checked={dry} onCheckedChange={setDry} aria-label="Dry run" />} />
      <Disclosure id="wa-adv" label="Advanced">
        <SettingsRow pane={PANE} row="wa-force" control={<Switch checked={force} onCheckedChange={setForce} aria-label="Sweep even when ingest is off" />} />
      </Disclosure>
      <div className="flex items-center justify-end gap-3 py-3">
        <span role="status" className={sweep.isError ? "mr-auto text-xs text-destructive" : "mr-auto text-xs text-muted-foreground"}>
          {sweep.isError ? "Not swept: " + (sweep.error as Error).message : sweep.data ? sweepLine(!!sweep.variables?.dryRun, sweep.data) : ""}
        </span>
        <Button variant="outline" size="sm" disabled={sweep.isPending} onClick={go}>
          <Icon name={sweep.isPending ? "loader-circle" : "download"} className={sweep.isPending ? "size-3.5 animate-spin motion-reduce:animate-none" : "size-3.5"} />
          {sweep.isPending ? "Sweeping…" : "Sweep now"}
        </Button>
      </div>
    </SettingsGroup>
  )
}

function List({ title, count, items, action }: { title: string; count: number; items: [string, string, string][]; action?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-h-7 items-center justify-between gap-2 text-[13px] font-medium">
        <span>{title} <span className="font-normal tabular-nums text-muted-foreground">{count}</span></span>{action}
      </div>
      {items.length === 0 ? <p className="text-xs text-muted-foreground">None.</p> : (
        <ul className="max-h-56 overflow-y-auto rounded-md border border-border px-3 py-1 text-[13px]">
          {items.map(([k, name, meta]) => (
            <li key={k} className="flex items-baseline justify-between gap-3 py-1">
              <span className="truncate">{name}</span>{meta && <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground">{meta}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
