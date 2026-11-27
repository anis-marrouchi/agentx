// --- Settings › WhatsApp (#2101 ST3a) ---
//
// The approved mock (settings-mock/full/whatsapp.html): pairing, watched
// chats with their watch rules (WhatsAppRules.tsx), and the chats with the
// sweep into a wiki (WhatsAppChats.tsx). The old Channels › WhatsApp calls
// (wall-settings-whatsapp.client.ts): GET channels/whatsapp/state, read
// every 3 s until paired, and qr.svg, drawn as an image so its markup never
// runs in the page; POST …/whatsapp-triage under the Settings prefix. The
// watched chats' secret shows as its variable's name and Set or Not set,
// never its value.
import { useQuery } from "@tanstack/react-query"
import { apiGet, apiText } from "../api"
import { Badge, Button, Icon, Switch } from "../ui"
import { oldSettingsHash } from "./address"
import type { ChannelsState } from "./channels-data"
import { CopyButton, STATE_KEY, WriteNote, useWorkState, useWrite } from "./fields"
import { ErrorLine, PaneHeader, SettingsGroup, SettingsRow, SkeletonRows, ToneDot } from "./parts"
import { paneDef } from "./panes"
import { WhatsAppChats } from "./WhatsAppChats"
import { WatchRules } from "./WhatsAppRules"

const PANE = "whatsapp"

interface PairState { connection?: string; detail?: string; qr?: string | null; qrUpdatedAt?: string }

export default function WhatsAppPane() {
  const pane = paneDef(PANE)
  const state = useWorkState()
  const s = state.data as ChannelsState | undefined
  const t = s?.whatsappTriage ?? {}
  const { write, run: send, note } = useWrite(STATE_KEY)
  const url = String(s?.daemonUrl || "").replace(/\/+$/, "") + "/webhook/wacli"
  return (
    <>
      <PaneHeader pane={pane} />
      {state.isPending ? <SkeletonRows /> : state.isError ? (
        <ErrorLine text={`Could not read agentx.json: ${(state.error as Error).message}`} onRetry={() => state.refetch()} />
      ) : (
        <div className="flex flex-col gap-8">
          <SettingsGroup pane={PANE} title="Pairing">
            <Pairing enabled={!!s?.whatsapp?.enabled} />
            <SettingsRow
              pane={PANE} row="wa-session"
              help={`${s?.whatsapp?.routeCount ?? 0} routes · pairing needs @whiskeysockets/baileys where the daemon runs.`}
              control={<span className="font-mono text-xs text-muted-foreground">{s?.whatsapp?.sessionDir}</span>}
            />
            <SettingsRow
              pane={PANE} row="wa-routes"
              control={<Button asChild variant="ghost" size="sm"><a href={oldSettingsHash("advanced")}>Open agentx.json<Icon name="chevron-right" className="size-3.5" /></a></Button>}
            />
          </SettingsGroup>

          <SettingsGroup pane={PANE} title="Watched chats" help="Messages from watched chats go to an agent, which drafts replies. Nothing is sent until you approve it.">
            <SettingsRow
              pane={PANE} row="wt-on"
              control={<Switch checked={!!t.enabled} onCheckedChange={(v) => write("POST", "whatsapp-triage", { enabled: v }, `Watched chats are ${v ? "on" : "off"}.`)} aria-label="Watched chats on" />}
            />
            <SettingsRow
              pane={PANE} row="wt-url"
              help={<span className="inline-flex flex-wrap items-center gap-1.5"><span className="rounded-sm border border-border px-1 font-mono text-[10.5px]">POST</span><span className="break-all font-mono text-xs text-foreground">{url}</span></span>}
              control={<CopyButton text={url} label="Copy address" />}
            />
            <SettingsRow
              pane={PANE} row="wt-secret" label="Secret"
              help={<><span className="font-mono text-xs">{t.secretEnv || "WACLI_WEBHOOK_SECRET"}</span> in .env. Every message is refused until it is set.</>}
              control={t.secretSet ? <Badge variant="ok">Set</Badge> : <Badge variant="warn">Not set</Badge>}
            />
            {t.error && <p role="alert" className="py-2.5 text-xs text-destructive">{t.error}</p>}
          </SettingsGroup>
          <WatchRules rules={t.rules ?? []} agents={s?.agents ?? []} write={write} send={send} />
          <WriteNote note={note} />
          <WhatsAppChats agents={s?.agents ?? []} />
        </div>
      )}
    </>
  )
}

/** The pairing row: read every 3 s until the daemon is paired. */
function Pairing({ enabled }: { enabled: boolean }) {
  const pair = useQuery({
    queryKey: ["settings", "wa-state"], enabled,
    queryFn: () => apiGet<PairState>("/api/admin/channels/whatsapp/state"),
    refetchInterval: (q) => (q.state.data?.connection === "open" ? false : 3000),
  })
  const qr = useQuery({
    queryKey: ["settings", "wa-qr", pair.data?.qrUpdatedAt], enabled: enabled && !!pair.data?.qr,
    queryFn: async () => { const svg = await apiText("/api/admin/channels/whatsapp/qr.svg"); return svg ? "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg) : "" },
  })
  const p = pair.data
  if (!enabled) {
    return (
      <SettingsRow
        pane={PANE} row="wa-pair" label="WhatsApp is off"
        help="Turn on channels.whatsapp.enabled in agentx.json and restart the daemon; the pairing code shows here."
        control={<Badge variant="secondary">Off</Badge>}
      />
    )
  }
  if (pair.isError) return <ErrorLine text={`Could not read the pairing state: ${(pair.error as Error).message}`} onRetry={() => pair.refetch()} />
  if (p?.connection === "open") {
    return <SettingsRow pane={PANE} row="wa-pair" label={<><ToneDot tone="ok" />Paired</>} help="The daemon is signed in to WhatsApp as a linked device." control={<Badge variant="ok">Connected</Badge>} />
  }
  if (p?.qr) {
    return (
      <SettingsRow
        pane={PANE} row="wa-pair" layout="stack" label="Scan to pair"
        help="On your phone, open WhatsApp › Settings › Linked devices › Link a device, and scan. The code changes about every 20 seconds."
        control={qr.data ? <img src={qr.data} alt="WhatsApp pairing code" className="size-60 max-w-full rounded-lg border border-border bg-white p-2" /> : <SkeletonRows />}
      />
    )
  }
  return (
    <SettingsRow
      pane={PANE} row="wa-pair" label="Waiting for the daemon"
      help={`${p?.connection || "init"}${p?.detail ? ` (${p.detail})` : ""}: the pairing code shows here once WhatsApp asks for one.`}
      control={<Badge variant="warn">Not paired</Badge>}
    />
  )
}
