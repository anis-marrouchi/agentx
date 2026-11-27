// --- Settings › Channels: the developer tools (#2101 ST3a) ---
//
// GitLab (one connection, POST …/channels/gitlab[/toggle]), GitHub (its
// webhooks, read from /api/admin/state; they are added in Jobs ›
// Webhooks) and Calls (reads only: GET /api/admin/channels/webrtc/history).
import { useQuery } from "@tanstack/react-query"
import { Badge, Button, Icon, cn } from "../ui"
import { apiGet } from "../api"
import { settingsHash } from "./address"
import { callLength, secretName, type ChannelsState } from "./channels-data"
import { At, ConnectorRow, EnvInput, Mono, SaveFoot, badEnv, useFields } from "./ChannelsChat"
import { CopyButton, type Send } from "./fields"
import { Disclosure, Dots, EmptyLine, ErrorLine, INPUT, IconButton, Lead, SettingsGroup, SettingsItem, SettingsRow, SkeletonRows } from "./parts"
import { hookUrl } from "./work-data"

const PANE = "channels"
const field = cn(INPUT, "font-mono")

export function GitLabTab({ s, send }: { s?: ChannelsState; send: Send }) {
  const g = s?.gitlab ?? {}
  const configured = secretName(g.tokenRef).set
  const [f, set] = useFields(() => ({ token: secretName(g.tokenRef).name, host: g.host || "https://gitlab.com", port: String(g.webhookPort || 18810) }), g)
  return (
    <>
      <SettingsGroup pane={PANE} title="GitLab" help="Issues and merge requests reach agents through a webhook.">
        <ConnectorRow row="ch-gitlab" name="GitLab" on={g.enabled} toggle={configured ? "gitlab/toggle" : undefined} send={send}
          help={<Dots items={[g.host && <Mono>{g.host.replace(/^https?:\/\//, "")}</Mono>, `${g.routeCount ?? 0} routes`, `${g.agentMappingCount ?? 0} agent mappings`]} />} />
      </SettingsGroup>
      <SettingsGroup pane={PANE} title={configured ? "Connection" : "Connect GitLab"} help="Routes per project and tokens per agent are set in agentx.json.">
        <SettingsRow pane={PANE} row="gl-token" control={<EnvInput label="Admin token variable" r={g.tokenRef} value={f.token} onChange={(v) => set("token", v)} ph="GITLAB_TOKEN" />} />
        <Disclosure id="gl-adv" label="Advanced">
          <SettingsRow pane={PANE} row="gl-host" control={<input className={cn(field, "w-36 sm:w-[230px]")} aria-label="GitLab host" value={f.host} onChange={(e) => set("host", e.target.value)} placeholder="https://gitlab.com" autoComplete="off" spellCheck={false} />} />
          <SettingsRow pane={PANE} row="gl-port" control={<input className={cn(field, "w-24")} inputMode="numeric" aria-label="Webhook listen port" value={f.port} onChange={(e) => set("port", e.target.value)} placeholder="18810" />} />
        </Disclosure>
        <SaveFoot label={configured ? "Save" : "Connect"} run={async () => {
          const bad = badEnv(f.token.trim()); if (bad) return bad
          await send("POST", "channels/gitlab", { host: f.host.trim(), tokenEnv: f.token.trim(), webhookPort: parseInt(f.port, 10) })
        }} />
      </SettingsGroup>
    </>
  )
}

export function GitHubTab({ s }: { s?: ChannelsState }) {
  const hooks = (s?.webhooks ?? []).filter((w) => w.source === "github")
  return (
    <SettingsGroup
      pane={PANE} row="ch-github"
      action={<Button asChild variant="outline" size="sm"><a href={settingsHash("jobs", "add-webhook")}><Icon name="plus" className="size-3.5" />Add webhook</a></Button>}
    >
      {hooks.length === 0 ? <EmptyLine>No GitHub webhook yet.</EmptyLine> : hooks.map((w) => {
        const url = hookUrl(s?.daemonUrl, w)
        return (
          <SettingsItem
            key={w.id} id={"gh-" + w.id}
            lead={<Lead icon="webhook" />}
            name={w.id}
            meta={<>
              <span className="basis-full break-all font-mono text-xs">{url}</span>
              <span>Goes to <At id={w.agentId} /></span>
            </>}
            badge={<Badge variant={w.enabled !== false ? "ok" : "secondary"}>{w.enabled !== false ? "On" : "Off"}</Badge>}
            control={<CopyButton text={url} label="Copy address" />}
          />
        )
      })}
    </SettingsGroup>
  )
}

interface CallsReply {
  active?: { agentId: string; target: string; uptimeSec?: number }[]
  history?: { startedAt: string | number; agentId: string; target: string; durationSec?: number; transcriptChunks?: number }[]
}

export function CallsTab() {
  const calls = useQuery({ queryKey: ["settings", "calls"], queryFn: () => apiGet<CallsReply>("/api/admin/channels/webrtc/history") })
  const active = calls.data?.active ?? []
  const recent = calls.data?.history ?? []
  return (
    <>
      <SettingsGroup
        pane={PANE} row="ch-calls"
        action={<span className="flex items-center gap-1">
          <IconButton icon="refresh-cw" label="Refresh" disabled={calls.isFetching} onClick={() => void calls.refetch()} />
          <Button asChild variant="outline" size="sm"><a href="/call">Open /call<Icon name="arrow-up-right" className="size-3.5" /></a></Button>
        </span>}
      >
        {calls.isPending ? <SkeletonRows /> : calls.isError ? (
          <ErrorLine text={`Could not read the calls: ${(calls.error as Error).message}`} onRetry={() => calls.refetch()} />
        ) : active.length === 0 ? <EmptyLine>No active call.</EmptyLine> : active.map((c, i) => (
          <SettingsItem key={i} id={"call-" + i} lead={<Lead icon="phone" />} name={<><At id={c.agentId} /> with <Mono>{c.target}</Mono></>}
            meta={`Started ${callLength(c.uptimeSec)} ago`} badge={<Badge variant="ok">Live</Badge>} />
        ))}
      </SettingsGroup>
      {calls.data && (
        <SettingsGroup pane={PANE} row="calls-recent">
          {recent.length === 0 ? <EmptyLine>No finished call in this daemon's memory yet.</EmptyLine> : recent.map((h, i) => (
            <SettingsItem
              key={i} id={"callh-" + i} lead={<Lead icon="phone" />}
              name={<><At id={h.agentId} /> with {h.target}</>}
              meta={<Dots items={[new Date(h.startedAt).toLocaleString(), callLength(h.durationSec), `${h.transcriptChunks ?? 0} transcript parts`]} />}
            />
          ))}
        </SettingsGroup>
      )}
    </>
  )
}
