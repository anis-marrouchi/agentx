// --- Settings › Guests (#2101 ST3a) ---
//
// The approved mock (settings-mock/full/guests.html): every grant this node
// opened to another organisation, with what it may touch, its usage and its
// trail, Pause or Resume on the row and End under `…`; ended grants below,
// and how to open or change a grant from a terminal. The same calls as the
// old Settings (wall-settings-guests.client.ts): GET /api/guests, and
// POST /api/admin/wall/settings/guests/<id>/<pause|resume|end>, which keeps
// the owner guard (wall-actions.ts wallGuestsTarget). No new endpoint.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState, type ReactNode } from "react"
import { apiFetch, apiGet } from "../api"
import { Badge, Button, Icon, cn } from "../ui"
import { initials, type AdminState } from "./data"
import { CopyButton, STATE_KEY, WriteNote, type Note } from "./fields"
import {
  Ago, AgentChip, ConfirmDialog, Disclosure, Dots, ErrorLine, IconButton, Lead, PaneHeader, RowMenu, SettingsGroup, SettingsItem, SettingsRow, SkeletonRows,
} from "./parts"
import { paneDef } from "./panes"
import { waitingHref } from "../waiting"

const PANE = "guests"

interface ConfirmSpec { title: string; text: ReactNode; yes: string; run: () => Promise<unknown> }

export interface Grant {
  id: string
  name: string
  guest: string
  guestNode?: { name?: string }
  agentId: string
  folders?: string[]
  skills?: string[]
  commands?: string[]
  level?: string
  state: "pending" | "active" | "paused" | "ended" | string
  expiresAt?: string
  endedAt?: string
  usage?: { turns?: number; tokens?: number; lastAt?: string }
  trail?: { at: string; event: string; detail?: string }[]
}

const LEVEL: Record<string, [string, string]> = {
  report: ["Report", "Report: read only"],
  propose: ["Propose", "Propose: no merge, deploy or delete"],
  act: ["Act", "Act: free inside the grant"],
}

/** The grant's state in words, with its badge tone (colour for state only). */
export function grantState(g: Grant): { word: string; tone: "ok" | "warn" | "secondary" } {
  if (g.state === "active") return { word: "Active", tone: "ok" }
  if (g.state === "paused") return { word: "Paused", tone: "secondary" }
  if (g.state === "ended") return { word: "Ended", tone: "secondary" }
  if (g.state === "pending") return g.guestNode ? { word: "Waits for your approval", tone: "warn" } : { word: "Not joined yet", tone: "secondary" }
  return { word: g.state, tone: "secondary" }
}

/** 1.9M, 410k, 950. */
export function tokensShort(n = 0): string {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M"
  if (n >= 1e3) return Math.round(n / 1e3) + "k"
  return String(n)
}

const stamp = (iso?: string) => (iso ? iso.slice(0, 16).replace("T", " ") : "")
const day = (iso?: string) => (iso ? iso.slice(0, 10) : "")

export default function GuestsPane() {
  const pane = paneDef(PANE)
  const client = useQueryClient()
  const state = useQuery({ queryKey: STATE_KEY, queryFn: () => apiGet<AdminState>("/api/admin/state") })
  const guests = useQuery({ queryKey: ["settings", "guests"], queryFn: () => apiGet<{ grants?: Grant[] }>("/api/guests") })
  const [note, setNote] = useState<Note>(null)
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null)
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const tiers = new Map((state.data?.agents ?? []).map((a) => [a.id, a.tier]))
  const grants = guests.data?.grants ?? []
  const live = grants.filter((g) => g.state !== "ended")
  const ended = grants.filter((g) => g.state === "ended")

  const act = useMutation({
    mutationFn: (v: { id: string; op: "pause" | "resume" | "end" }) =>
      apiFetch<{ grant?: Grant; stopped?: number }>(`/api/admin/wall/settings/guests/${encodeURIComponent(v.id)}/${v.op}`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } }),
    onSuccess: (r, v) => {
      const name = r.grant?.name || grants.find((g) => g.id === v.id)?.name || v.id
      const stopped = r.stopped ? ` ${r.stopped} running ${r.stopped === 1 ? "turn" : "turns"} stopped.` : ""
      setNote({ tone: "ok", text: v.op === "pause" ? `Paused ${name}.${stopped}` : v.op === "resume" ? `Resumed ${name}.` : `Ended ${name}.${stopped}` })
      return client.invalidateQueries({ queryKey: ["settings", "guests"] })
    },
    onError: (e, v) => setNote({ tone: "err", text: `Not done for ${v.id}: ${(e as Error).message}` }),
  })
  const toggle = (id: string, v?: boolean) => setOpen((s) => { const n = new Set(s); if (v ?? !n.has(id)) n.add(id); else n.delete(id); return n })
  const end = (g: Grant) => setConfirm({
    title: `End ${g.name}`, yes: "End grant",
    text: <>End <b>{g.name}</b> for good? {g.guest} loses access at once.</>,
    run: () => act.mutateAsync({ id: g.id, op: "end" }),
  })

  const count = guests.data ? `${live.length} open · each names one of your agents, what it may touch and until when` : undefined
  return (
    <>
      <PaneHeader pane={pane} />
      <div className="flex flex-col gap-8">
        <SettingsGroup
          pane={PANE} row="grants" help={count}
          action={<IconButton icon="refresh-cw" label="Refresh" disabled={guests.isFetching} onClick={() => { setNote(null); void guests.refetch() }} />}
        >
          {guests.isPending ? <SkeletonRows /> : guests.isError ? (
            <ErrorLine text={`Could not read the grants: ${(guests.error as Error).message}`} onRetry={() => guests.refetch()} />
          ) : live.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">No open grant. Open one from a terminal, below.</p>
          ) : live.map((g) => (
            <GrantItem
              key={g.id} grant={g} tier={tiers.get(g.agentId)} open={open.has(g.id)} onToggle={() => toggle(g.id)}
              busy={act.isPending && act.variables?.id === g.id}
              onAct={(op) => act.mutate({ id: g.id, op })}
              menu={<RowMenu label={g.name} items={[
                { label: "What happened", icon: "history", onSelect: () => toggle(g.id, true) },
                { label: "End grant…", icon: "circle-x", destructive: true, onSelect: () => end(g) },
              ]} />}
            />
          ))}
          <WriteNote note={note} />
        </SettingsGroup>

        {ended.length > 0 && (
          <SettingsGroup pane={PANE} row="ended" title="Ended">
            {ended.map((g) => <GrantItem key={g.id} grant={g} tier={tiers.get(g.agentId)} open={false} />)}
          </SettingsGroup>
        )}

        <SettingsGroup pane={PANE} row="guests-terminal">
          <SettingsRow pane={PANE} row="gu-open" />
          <Disclosure id="guests-adv" label="Terminal commands">
            <SettingsRow
              pane={PANE} row="gu-cli-invite"
              label={<code className="break-all font-mono text-xs">agentx mesh guests invite --name "…" --guest "…" --agent &lt;id&gt;</code>}
              control={<CopyButton text={'agentx mesh guests invite --name "" --guest "" --agent '} label="Copy command" />}
            />
            <SettingsRow
              pane={PANE} row="gu-cli-set"
              label={<code className="font-mono text-xs">agentx mesh guests set &lt;id&gt;</code>}
              control={<CopyButton text="agentx mesh guests set " label="Copy command" />}
            />
          </Disclosure>
        </SettingsGroup>
      </div>
      {confirm && <ConfirmDialog open onOpenChange={(v) => { if (!v) setConfirm(null) }} title={confirm.title} text={confirm.text} yes={confirm.yes} run={confirm.run} />}
    </>
  )
}

function GrantItem({ grant: g, tier, open, onToggle, busy, onAct, menu }: {
  grant: Grant; tier?: string; open: boolean; onToggle?: () => void; busy?: boolean; onAct?: (op: "pause" | "resume") => void; menu?: ReactNode
}) {
  const st = grantState(g)
  const u = g.usage ?? {}
  const ended = g.state === "ended"
  const usage = u.turns ? <Dots items={[`${u.turns} ${u.turns === 1 ? "turn" : "turns"}`, `${tokensShort(u.tokens)} tokens`, u.lastAt && <Ago iso={u.lastAt} prefix="last " />]} /> : "No turns yet"
  const level = LEVEL[g.level || ""] ?? [g.level || "", g.level || ""]
  const detailId = "gu-detail-" + g.id
  return (
    <div>
      <SettingsItem
        id={"grant-" + g.id}
        muted={g.state === "paused" || ended}
        lead={<Lead text={initials(g.guest)} />}
        name={g.name}
        badge={<Badge variant={st.tone}>{st.word}</Badge>}
        meta={<>
          <Dots items={[
            g.guest,
            g.guestNode?.name && <span className="font-mono text-xs">{g.guestNode.name}</span>,
            <AgentChip id={g.agentId} tier={tier} />,
            ended ? `ended ${day(g.endedAt)}` : g.expiresAt && `until ${day(g.expiresAt)}`,
          ]} />
          {onToggle && (
            <button
              type="button" aria-expanded={open} aria-controls={detailId} onClick={onToggle}
              className="flex basis-full cursor-pointer items-center gap-1 pt-0.5 text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Icon name="chevron-right" className={cn("size-3.5 transition-transform duration-150 ease-out motion-reduce:transition-none", open && "rotate-90")} />
              <span className="flex flex-wrap items-center gap-x-1.5">{level[0]}<span aria-hidden="true">·</span>{usage}</span>
            </button>
          )}
        </>}
        control={!ended && onAct && (g.state === "active" || g.state === "paused") ? (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => onAct(g.state === "active" ? "pause" : "resume")}>
            {g.state === "active" ? "Pause" : "Resume"}
          </Button>
        ) : g.state === "pending" && g.guestNode ? (
          <Button asChild variant="outline" size="sm"><a href={waitingHref()}>Review</a></Button>
        ) : undefined}
        menu={menu}
      />
      {onToggle && (
        <div id={detailId} hidden={!open} className="mb-3 ml-10 rounded-lg bg-muted/60 px-4 py-3">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-[13px] sm:grid-cols-[9rem_1fr]">
            <Kv k="Freedom">{level[1]}</Kv>
            <Kv k="Folders"><Codes list={g.folders} /></Kv>
            <Kv k="Skills">{g.skills?.length ? g.skills.join(", ") : "none"}</Kv>
            <Kv k="Commands"><Codes list={g.commands} /></Kv>
            <Kv k="Usage">{usage}</Kv>
            <Kv k="What happened">
              {g.trail?.length ? (
                <ul className="flex flex-col gap-1">
                  {g.trail.map((e, i) => <li key={i}><span className="font-mono text-xs">{stamp(e.at)}</span> · {e.event}{e.detail ? " · " + e.detail : ""}</li>)}
                </ul>
              ) : "Nothing yet"}
            </Kv>
          </dl>
        </div>
      )}
    </div>
  )
}

function Kv({ k, children }: { k: string; children: ReactNode }) {
  return <><dt className="text-muted-foreground max-sm:pt-1.5">{k}</dt><dd className="min-w-0 break-words">{children}</dd></>
}

function Codes({ list }: { list?: string[] }) {
  if (!list?.length) return <>none</>
  return <span className="flex flex-wrap gap-1.5">{list.map((c) => <code key={c} className="rounded-sm bg-background px-1.5 font-mono text-xs">{c}</code>)}</span>
}
