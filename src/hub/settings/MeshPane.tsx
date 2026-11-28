// --- Settings › Mesh (#2101 ST3b) ---
//
// The mock's Mesh (settings-mock/full/mesh.html): mesh on or off, the peers
// with the health check under Advanced, and the tokens with the revoked
// ones folded. Every change saves at once through the old Settings'
// endpoints (wall-settings-mesh.client.ts): mesh/toggle, mesh/peers,
// mesh/health, tokens. A new token is shown once, right after it is made.
import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { useState, type ReactNode } from "react"
import { apiGet } from "../api"
import { Badge, Switch } from "../ui"
import { NumberField, STATE_KEY, WriteNote, useWorkState, useWrite } from "./fields"
import { AddPeerDialog, MakeTokenDialog, NewToken } from "./mesh-dialogs"
import {
  AddButton, Ago, Disclosure, Dots, EmptyLine, ErrorLine, Lead, PaneHeader, RowMenu, SettingsGroup, SettingsItem, SettingsRow, SkeletonRows, useConfirm,
  type ConfirmSpec,
} from "./parts"
import { paneDef } from "./panes"
import { tokenState, type MeshPeer, type SystemState, type Token } from "./system-data"

const PANE = "mesh"
/** The key General reads its token count from too. */
export const TOKENS_KEY = ["settings", "tokens"] as const

const range = (lo: number, hi: number) => (v: number) => (Number.isInteger(v) && v >= lo && v <= hi ? null : `Use ${lo} to ${hi} seconds.`)

export default function MeshPane() {
  const state = useWorkState()
  const tokens = useQuery({ queryKey: TOKENS_KEY, queryFn: () => apiGet<Token[]>("/api/admin/tokens") })
  const st = useWrite(STATE_KEY)
  const tk = useWrite(TOKENS_KEY)
  const confirm = useConfirm()
  const [dialog, setDialog] = useState<"peer" | "token" | null>(null)
  const [fresh, setFresh] = useState("")
  const s = state.data as SystemState | undefined
  const mesh = s?.mesh ?? {}
  const peers = mesh.peers ?? []
  const n = peers.length

  const removePeer = (p: MeshPeer): ConfirmSpec => ({
    title: `Remove ${p.name}?`, text: <>Work stops going between this machine and <span className="font-mono">{p.url}</span>.</>, yes: "Remove peer",
    run: () => st.run("DELETE", "mesh/peers", { url: p.url }, `Removed the peer ${p.name}.`),
  })
  const revoke = (t: Token): ConfirmSpec => ({
    title: `Revoke ${t.name}?`, text: "Anything that uses it fails at once.", yes: "Revoke",
    run: () => tk.run("DELETE", "tokens", { id: t.id }, `Revoked ${t.name}.`),
  })

  const copy = (text: string) => {
    const done = navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject(new Error("no clipboard"))
    done.then(() => st.setNote({ tone: "ok", text: "Address copied." }), () => st.setNote({ tone: "err", text: "Could not copy: " + text }))
  }

  const lead = !mesh.enabled ? "Off. Turn it on to share work between your AgentX machines."
    : !n ? "On, with no peers yet. Add one to link another machine."
    : <>This machine (<span className="font-mono text-xs">{s?.nodeName || "this machine"}</span>) is linked to {n} peer{n === 1 ? "" : "s"}. Work from any of them can land here.</>
  const health = (row: "mh-interval" | "mh-timeout", key: "interval" | "timeout", label: string, lo: number, hi: number, dflt: number) => (
    <SettingsRow
      pane={PANE} row={row}
      control={<NumberField label={label} unit="s" check={range(lo, hi)} value={mesh.healthCheck?.[key] ?? dflt} disabled={!s || st.busy} onCommit={(v) => st.write("POST", "mesh/health", { [key]: v }, "Health check saved.")} />}
    />
  )

  return (
    <>
      <PaneHeader pane={paneDef(PANE)} />
      <div className="flex flex-col gap-8">
        <SettingsGroup pane={PANE} title="Mesh" help="Only if you run AgentX in more than one place.">
          {state.isPending ? <SkeletonRows /> : state.isError ? (
            <ErrorLine text={`Could not read agentx.json: ${(state.error as Error).message}`} onRetry={() => state.refetch()} />
          ) : (
            <SettingsRow
              pane={PANE} row="mesh-on" help={lead}
              control={<Switch checked={!!mesh.enabled} disabled={st.busy} onCheckedChange={(v) => st.write("POST", "mesh/toggle", { enabled: v }, v ? "Mesh is on." : "Mesh is off.")} aria-label="Mesh on" />}
            />
          )}
          <WriteNote note={st.note} />
        </SettingsGroup>

        <SettingsGroup
          pane={PANE} row="peers" help={s ? `${n} machine${n === 1 ? "" : "s"} this one talks to.` : undefined}
          action={<AddButton label="Add peer" onClick={() => setDialog("peer")} />}
        >
          {/* A failed read is not "no peers" (Hakim, review of #2450, F2). */}
          {state.isPending ? <SkeletonRows /> : state.isError ? (
            <ErrorLine text={`Could not read the peers: ${(state.error as Error).message}`} onRetry={() => state.refetch()} />
          ) : n === 0 ? (
            <EmptyLine>No peers yet. Add peer links another AgentX machine.</EmptyLine>
          ) : peers.map((p) => (
            <SettingsItem
              key={p.url} id={"peer-" + p.name}
              lead={<Lead icon="server" />}
              name={<span className="font-mono text-[13px]">{p.name}</span>}
              meta={<span className="truncate font-mono text-xs">{p.url}</span>}
              badge={p.hasToken ? <Badge variant="ok">Token set</Badge> : <Badge variant="warn">No token</Badge>}
              menu={<RowMenu label={p.name} items={[
                { label: "Copy address", icon: "copy", onSelect: () => copy(p.url) },
                { label: "Remove peer", icon: "unlink", destructive: true, onSelect: () => confirm.ask(removePeer(p)) },
              ]} />}
            />
          ))}
          <Disclosure id="mesh-advanced" label="Advanced">
            {health("mh-interval", "interval", "Health check every", 5, 3600, 60)}
            {health("mh-timeout", "timeout", "Gives up after", 1, 60, 10)}
          </Disclosure>
        </SettingsGroup>

        {fresh && <NewToken token={fresh} onDone={() => setFresh("")} />}

        <TokensGroup tokens={tokens} onMake={() => setDialog("token")} onRevoke={(t) => confirm.ask(revoke(t))}>
          <WriteNote note={tk.note} />
        </TokensGroup>
      </div>
      <AddPeerDialog open={dialog === "peer"} onOpenChange={(v) => setDialog(v ? "peer" : null)} send={st.run} />
      <MakeTokenDialog open={dialog === "token"} onOpenChange={(v) => setDialog(v ? "token" : null)} agents={s?.agents ?? []} send={tk.run} onMade={setFresh} />
      {confirm.dialog}
    </>
  )
}

const TOKEN_BADGE = {
  active: <Badge variant="ok">Active</Badge>,
  stale: <Badge variant="warn">Not used for 30 days</Badge>,
  expired: <Badge variant="warn">Expired</Badge>,
  revoked: <Badge variant="secondary">Revoked</Badge>,
}

const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })

function TokensGroup({ tokens, onMake, onRevoke, children }: {
  tokens: UseQueryResult<Token[]>; onMake: () => void; onRevoke: (t: Token) => void; children?: ReactNode
}) {
  const list = Array.isArray(tokens.data) ? tokens.data : []
  const live = list.filter((t) => !t.revokedAt)
  const gone = list.filter((t) => t.revokedAt)
  const item = (t: Token) => {
    const s = tokenState(t)
    const scopes = t.scopes ?? []
    return (
      <SettingsItem
        key={t.id} id={"token-" + t.id} muted={s === "revoked"}
        lead={<Lead icon="key-round" />}
        name={t.name}
        meta={<>
          <Dots items={[
            t.prefix && <span>starts with <span className="font-mono text-xs">{t.prefix}</span></span>,
            scopes.length ? <span className="inline-flex flex-wrap gap-1">{scopes.map((sc) => <span key={sc} className="rounded-sm bg-muted px-1.5 font-mono text-[11px]">{sc}</span>)}</span> : "no scopes",
          ]} />
          <span className="basis-full" />
          <Dots items={[
            t.lastUsedAt ? <Ago iso={t.lastUsedAt} prefix="last used " /> : "never used",
            t.expiresAt ? "expires " + day(t.expiresAt) : "no expiry",
          ]} />
        </>}
        badge={TOKEN_BADGE[s]}
        menu={s === "revoked" ? undefined : <RowMenu label={t.name} items={[{ label: "Revoke token", icon: "ban", destructive: true, onSelect: () => onRevoke(t) }]} />}
      />
    )
  }
  return (
    <SettingsGroup pane={PANE} row="tokens" action={<AddButton label="Make token" onClick={onMake} />}>
      {tokens.isPending ? <SkeletonRows /> : tokens.isError ? (
        <ErrorLine text={`Could not read the tokens: ${(tokens.error as Error).message}`} onRetry={() => tokens.refetch()} />
      ) : list.length === 0 ? (
        <EmptyLine>No tokens yet. Make token gives an app or a script its own key.</EmptyLine>
      ) : <>
        {live.map(item)}
        {gone.length > 0 && <Disclosure id="tokens-revoked" label={`Revoked (${gone.length})`}>{gone.map(item)}</Disclosure>}
      </>}
      {children}
    </SettingsGroup>
  )
}
