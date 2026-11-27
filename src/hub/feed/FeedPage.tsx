// --- The feed, the React page (#2101) ---
//
// The Hub's main feed as Anis approved it (#2387, orca-design recipes §8 and
// §9), on the review id `feed-preview` (pages.ts, owner only) until it
// replaces the old one. The old feed stays as it is.
//
//   Head     title, Feed | List, search ("/"), Filters, Chat.
//   Compose  one bordered box: the task, who it is for, Enter sends.
//   Tabs     Open, Working, Waiting, Failed, Done, All, each counting the
//            posts the other filters leave; "Synced 10:04" turns into
//            "Not synced since 10:04" when a read fails or is old.
//   Groups   in the one state order, Needs you first, each folding from its
//            header with a count, 3 rows then Show all (N). What a reader
//            folds or opens is kept with the old feed's (hub-folds.ts).
//
// Reads what the old feed reads (/api/admin/wall?peer=fleet, the live
// snapshot); writes go to the same guarded routes. React keys the rows, so a
// refresh changes only what changed: focus, scroll and an open menu stay (C28).
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react"
import { apiGet, apiPost } from "../api"
import { useLiveSnapshot } from "../live-react"
import type { HubPageProps } from "../registry"
import { HUB_CAP, HUB_FOLDS_KEY, hubCapLabel, hubFoldIsOpen, hubFoldsRead } from "../../daemon/ui/pages/hub-folds"
import { fdClock } from "../../daemon/ui/pages/wall-feed-model"
import type { WallOwnerCard } from "../../daemon/wall-api"
import {
  Button, EmptyState, Icon, Kbd, Popover, PopoverContent, PopoverTrigger, Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  Tooltip, TooltipContent, TooltipTrigger, cn,
} from "../ui"
import {
  FEED_STALE_MS, FEED_TABS, FEED_URL, agentNames, feedFilters, feedHash, feedView, liveRunOf, postHash, stamp,
  type FeedFilters, type FeedLive, type FeedPost, type FeedReply,
} from "./model"
import { FEED_BAR, FEED_COMPOSER, FEED_HEAD, FEED_SWITCH, FEED_TITLE, FeedColumn, FeedSkeleton } from "./frame"
import { FeedActionsContext, FeedEmpty, FeedRow, FeedSection, IconButton, type DecideAction, type FeedActions } from "./parts"

const FEED_KEY = ["feed-posts"] as const
/** Groups that start folded: noisy and done with (C22). */
const START_CLOSED = new Set(["done", "cancelled"])

/** The reader's folds and caps, shared with the old feed's keys (`feed.<group>`). */
function useFolds() {
  const [f, setF] = useState(() => {
    try { return hubFoldsRead(localStorage.getItem(HUB_FOLDS_KEY)) } catch { return hubFoldsRead(null) }
  })
  const save = useCallback((part: "open" | "all", key: string, v: boolean) => {
    setF((cur) => {
      const next = { ...cur, [part]: { ...cur[part], [key]: v } }
      try { localStorage.setItem(HUB_FOLDS_KEY, JSON.stringify(next)) } catch { /* private mode: this page only */ }
      return next
    })
  }, [])
  return {
    isOpen: (g: string) => hubFoldIsOpen(f, "feed." + g, START_CLOSED.has(g) ? "closed" : null),
    setOpen: (g: string, v: boolean) => save("open", "feed." + g, v),
    isAll: (g: string) => !!f.all["feed." + g],
    setAll: (g: string, v: boolean) => save("all", "feed." + g, v),
  }
}

/** The old Hub's own controls this page shows in its head: they keep
 *  working through the old script (Back and Forward, the chat panel). */
const oldButton = (id: string) => (typeof document !== "undefined" ? document.getElementById(id) : null)

export default function FeedPage({ params }: HubPageProps) {
  const f = feedFilters(params)
  const client = useQueryClient()
  const posts = useQuery({
    queryKey: FEED_KEY,
    queryFn: () => apiGet<FeedReply>(FEED_URL),
    // A quick read says when more is on its way: ask again soon, else every 30 s.
    refetchInterval: (q) => (q.state.data?.pending ? 3_000 : 30_000),
  })
  const live = useLiveSnapshot<FeedLive>()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(t) }, [])
  useEffect(() => { setNow(Date.now()) }, [posts.dataUpdatedAt])

  const all = useMemo(() => posts.data?.posts ?? [], [posts.data])
  const view = useMemo(() => feedView(all, f, live.data), [all, f.status, f.q, f.owner, f.project, live.data]) // eslint-disable-line react-hooks/exhaustive-deps
  const names = useMemo(() => agentNames(live.data), [live.data])
  const folds = useFolds()
  const set = (patch: Partial<FeedFilters>) => location.replace(feedHash({ ...f, ...patch }))

  // --- What a row can do ---
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [said, setSaid] = useState<Record<string, string>>({})
  const [copied, setCopied] = useState("")
  const say = (id: string, text: string) => setSaid((s) => ({ ...s, [id]: text }))
  const hold = (id: string, v: boolean) => setBusy((b) => { const n = { ...b }; if (v) n[id] = true; else delete n[id]; return n })
  const refresh = () => client.invalidateQueries({ queryKey: FEED_KEY })
  const nameOf = (id: string) => names[id] || id
  const run = async (key: string, id: string, start: string, call: () => Promise<unknown>, done: string, failed: string) => {
    hold(key, true); say(id, start)
    try { await call(); say(id, done); void refresh() } catch (e) { say(id, failed + ((e as Error).message || "")) }
    hold(key, false)
  }
  const actions: FeedActions = {
    nameOf,
    owner: posts.data?.owner !== false,
    busy, copied, said,
    open: (p) => { location.hash = postHash(p.id) },
    copy: (p) => {
      const url = location.origin + location.pathname + postHash(p.id)
      void navigator.clipboard?.writeText(url).then(() => {
        setCopied(p.id)
        window.setTimeout(() => setCopied((c) => (c === p.id ? "" : c)), 2000)
      }, () => {})
    },
    retry: (p) => {
      const why = p.lastFailure ? ` The last run (${p.lastFailure.taskId}) failed: ${p.lastFailure.error}` : ""
      void run(p.id, p.id, `Asking ${nameOf(p.owner)} to try again…`,
        () => apiPost("/api/admin/wall/comment", { id: p.id, text: "Please try this again." + why }, p.node?.peer),
        `Asked ${nameOf(p.owner)} to try again.`, "Not sent: ")
    },
    stop: (p) => {
      const r = liveRunOf(p, live.data)
      if (!r) return
      void run(p.id, p.id, "Stopping…",
        () => apiPost(`/api/task/action?node=${encodeURIComponent(r.node)}&task=${encodeURIComponent(r.task)}&kind=cancel`, { reason: "Stopped from the Hub" }),
        "Stopped.", "Could not stop it: ")
    },
    call: (p) => {
      void run(p.id, p.id, "Calling…", () => apiPost("/api/admin/wall/call", { id: p.id }, p.node?.peer),
        `${nameOf(p.owner)} is calling you on AgentX Voice.`, "No call: ")
    },
    decide: (p: FeedPost, c: WallOwnerCard, action: DecideAction) => {
      void run("card:" + c.id, p.id, "Sending your answer…",
        () => apiPost("/api/admin/wall/decide", { key: "card:" + c.id, action }, p.node?.peer),
        "Answer sent.", "Not answered: ")
    },
  }

  const owners = useMemo(() => [...new Set(all.map((p) => p.owner))].sort(), [all])
  const projects = useMemo(() => [...new Set(all.map((p) => p.project).filter((x): x is string => !!x))].sort(), [all])
  const stale = posts.isError || (posts.dataUpdatedAt > 0 && now - posts.dataUpdatedAt > FEED_STALE_MS)
  const status = f.status === "all" ? "" : f.status

  return (
    <FeedActionsContext.Provider value={actions}>
      <FeedColumn>
        <FeedHead f={f} set={set} owners={owners} projects={projects} nameOf={nameOf} />
        <Composer live={live.data} onPosted={refresh} />

        <div className={FEED_BAR}>
          <div role="tablist" aria-label="Status" className="flex min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:none] max-sm:[mask-image:linear-gradient(to_right,#000_85%,transparent)]">
            {FEED_TABS.map(([v, label]) => {
              const on = status === v
              const n = view.counts[v] ?? 0
              return (
                <button
                  key={v || "all"} type="button" role="tab" aria-selected={on} onClick={() => set({ status: v })}
                  className={cn(
                    "-mb-px inline-flex h-10 shrink-0 cursor-pointer items-center border-b-2 px-2.5 text-[13px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-sm:px-2",
                    on ? "border-foreground text-foreground" : "border-transparent text-muted-foreground can-hover:hover:text-foreground",
                  )}
                >
                  <span className="inline-flex items-baseline gap-1.5">
                    {label}<span className={cn("text-xs font-normal tabular-nums", v === "failed" && n > 0 ? "text-err-ink" : "text-muted-foreground")}>{n}</span>
                  </span>
                </button>
              )
            })}
          </div>
          {posts.dataUpdatedAt > 0 && (
            <span role="status" className={cn("inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs max-sm:hidden", stale ? "text-warn-ink" : "text-muted-foreground")}>
              {!stale && <Icon name="check" className="size-3.5" />}
              <span>{stale ? "Not synced since" : "Synced"}</span>
              <Tooltip>
                <TooltipTrigger asChild><time dateTime={new Date(posts.dataUpdatedAt).toISOString()}>{fdClock(posts.dataUpdatedAt)}</time></TooltipTrigger>
                <TooltipContent>{stamp(posts.dataUpdatedAt)}</TooltipContent>
              </Tooltip>
              <IconButton label={stale ? "Retry" : "Refresh"} icon="refresh-cw" onClick={() => void posts.refetch()} className="size-6 [&_[aria-hidden]]:size-3.5" />
            </span>
          )}
        </div>

        <section aria-label="Posts" className="flex flex-col">
          {posts.isPending ? <FeedSkeleton />
            : !posts.data ? (
              <EmptyState title="Could not load the feed" className="mt-6" action={<Button variant="outline" size="sm" onClick={() => void posts.refetch()}>Retry</Button>}>
                {(posts.error as Error | null)?.message || "No answer from the daemon."}
              </EmptyState>
            ) : !view.total ? <FeedEmpty onClear={() => location.replace(feedHash({}))} />
            : view.groups.map((g) => {
              const open = folds.isOpen(g.key)
              const showAll = folds.isAll(g.key) && !!hubCapLabel(g.posts.length, true, HUB_CAP)
              return (
                <FeedSection key={g.key} id={g.key} title={g.title} count={g.posts.length} cap={HUB_CAP}
                  open={open} onOpen={(v) => folds.setOpen(g.key, v)} all={showAll} onAll={(v) => folds.setAll(g.key, v)}>
                  {(showAll ? g.posts : g.posts.slice(0, HUB_CAP)).map((p) => {
                    const s = view.stateOf(p)
                    return <FeedRow key={p.id} post={p} state={s} running={s === "working" && !!liveRunOf(p, live.data)} now={now} />
                  })}
                </FeedSection>
              )
            })}
        </section>
      </FeedColumn>
    </FeedActionsContext.Provider>
  )
}

// --- The head: title, Feed | List, search, Filters, Chat ---

function FeedHead({ f, set, owners, projects, nameOf }: {
  f: FeedFilters; set: (p: Partial<FeedFilters>) => void; owners: string[]; projects: string[]; nameOf: (id: string) => string
}) {
  const search = useRef<HTMLInputElement>(null)
  const [phoneSearch, setPhoneSearch] = useState(false)
  const chat = oldButton("hc-btn")
  // "/" goes to the search box, unless a field is in use.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (e.key !== "/" || e.metaKey || e.ctrlKey || /^(INPUT|SELECT|TEXTAREA)$/.test(t?.tagName || "") || t?.isContentEditable) return
      if (!search.current || search.current.offsetParent === null) return
      e.preventDefault(); search.current.focus()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
  const used = (f.owner ? 1 : 0) + (f.project ? 1 : 0)
  const hist = "size-7 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"

  return (
    <header className={FEED_HEAD}>
      {/* Back and Forward: the old Hub's history script drives them (data-hist). */}
      <span className="inline-flex max-sm:hidden">
        <Button variant="ghost" size="icon" data-hist="back" aria-label="Back to the previous page" className={hist}><Icon name="chevron-left" /></Button>
        <Button variant="ghost" size="icon" data-hist="fwd" aria-label="Forward" className={hist}><Icon name="chevron-right" /></Button>
      </span>
      <h1 className={FEED_TITLE}>Hub</h1>
      <span role="group" aria-label="Show as" className={FEED_SWITCH}>
        {([["feed", "rows-3", "Feed"], ["list", "table", "List"]] as const).map(([v, icon, label]) => (
          <button
            key={v} type="button" aria-pressed={v === "feed"}
            // The List view is still the old Hub's (a later PR draws it here).
            onClick={v === "list" ? () => { location.hash = "#status=open&view=list" } : undefined}
            className={cn(
              "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-[calc(var(--ax-radius-md)-2px)] px-2.5 text-[13px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-sm:h-8 max-sm:flex-1 max-sm:justify-center [&_[aria-hidden]]:size-3.5",
              v === "feed" ? "bg-background text-foreground shadow-xs" : "text-muted-foreground can-hover:hover:text-foreground",
            )}
          >
            <Icon name={icon} />{label}
          </button>
        ))}
      </span>

      <div className={cn("relative ml-auto inline-flex items-center gap-1.5", phoneSearch && "max-sm:flex-wrap")}>
        <label className={cn(
          "inline-flex h-8 w-[200px] items-center gap-2 rounded-md border border-input bg-background pl-2.5 pr-1.5 text-muted-foreground focus-within:border-ring focus-within:shadow-[var(--ax-focus-ring)] max-[1180px]:w-40",
          phoneSearch ? "max-sm:order-11 max-sm:h-10 max-sm:w-auto max-sm:flex-[1_0_100%]" : "max-sm:hidden",
        )}>
          <Icon name="search" />
          <input
            ref={search} type="search" placeholder="Search tasks" aria-label="Search tasks" value={f.q}
            onChange={(e) => set({ q: e.target.value })}
            onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => { if (e.key === "Escape" && f.q) { e.preventDefault(); set({ q: "" }) } }}
            className="min-w-0 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground md:text-[13px] [&::-webkit-search-cancel-button]:hidden"
          />
          <Kbd className="h-4 border-border bg-surface-2 px-[5px] font-sans text-[11px] leading-4 max-sm:hidden">/</Kbd>
        </label>
        <IconButton label="Search tasks" icon="search" aria-expanded={phoneSearch} className="hidden size-8 max-sm:inline-flex"
          onClick={() => { setPhoneSearch((v) => !v); window.setTimeout(() => search.current?.focus(), 0) }} />
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="h-8 gap-1.5 px-2.5 text-[13px] max-sm:border-transparent max-sm:bg-transparent max-sm:px-2">
              <Icon name="list-filter" /><span className="max-sm:sr-only">Filters</span>
              {used > 0 && <b className="font-medium tabular-nums">{used}</b>}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="flex w-[min(560px,calc(100vw-32px))] flex-col gap-2.5 p-3">
            <div className="grid grid-cols-2 gap-x-3 gap-y-2 max-sm:grid-cols-1">
              <FilterPick label="Owner" value={f.owner} options={owners} name={nameOf} onPick={(v) => set({ owner: v })} />
              <FilterPick label="Project" value={f.project} options={projects} onPick={(v) => set({ project: v })} />
            </div>
            {used > 0 && (
              <div className="flex justify-end border-t border-border pt-2.5">
                <Button variant="ghost" size="sm" onClick={() => set({ owner: "", project: "" })}>Clear filters</Button>
              </div>
            )}
          </PopoverContent>
        </Popover>
      </div>
      {chat && <IconButton label="Chat" icon="message-square" className="size-8" onClick={() => oldButton("hc-btn")?.click()} />}
    </header>
  )
}

const ALL = "__all"
function FilterPick({ label, value, options, name, onPick }: { label: string; value: string; options: string[]; name?: (v: string) => string; onPick: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <Select value={value || ALL} onValueChange={(v) => onPick(v === ALL ? "" : v)}>
        <SelectTrigger aria-label={label} className="h-8 w-full"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All</SelectItem>
          {options.map((o) => <SelectItem key={o} value={o}>{name ? name(o) : o}</SelectItem>)}
        </SelectContent>
      </Select>
    </label>
  )
}

// --- The composer: one bordered box, tools left, send right (A1) ---

/** Who a task goes to: an @name in the words, else the picked agent. The
 *  first node is this one; an agent only on a peer is sent there. */
export function composeTarget(text: string, live: FeedLive | null | undefined): { id: string; name: string; peer: string | null } | null {
  const nodes = live?.nodes ?? []
  const names = (text.match(/@[A-Za-z0-9_.:-]+/g) || []).map((m) => m.slice(1).replace(/[.:]+$/, ""))
  for (const n of names) {
    for (let j = 0; j < nodes.length; j++) {
      const a = (nodes[j].agents ?? []).find((x) => x.id === n || (x.name || "").toLowerCase() === n.toLowerCase())
      if (a) return { id: a.id, name: a.name || a.id, peer: j === 0 ? null : nodes[j].url || null }
    }
  }
  return null
}

function Composer({ live, onPosted }: { live: FeedLive | undefined; onPosted: () => void }) {
  const [text, setText] = useState("")
  const [agent, setAgent] = useState("")
  const [note, setNote] = useState("")
  const [sending, setSending] = useState(false)
  const agents = useMemo(() => {
    const seen = new Set<string>()
    const out: { id: string; name: string }[] = []
    for (const n of live?.nodes ?? []) for (const a of n.agents ?? []) if (!seen.has(a.id)) { seen.add(a.id); out.push({ id: a.id, name: a.name || a.id }) }
    return out
  }, [live])
  const send = async (e?: FormEvent) => {
    e?.preventDefault()
    const body = text.trim()
    if (sending || !body) return
    const to = composeTarget(body, live) || composeTarget("@" + agent, live)
    if (!to) { setNote(live ? "Pick who it is for: an agent below, or @ and its name." : "Still loading the agents…"); return }
    setSending(true); setNote("Posting to " + to.name + "…")
    try {
      const r = await apiPost<{ message?: string }>("/api/admin/wall/post", { agent: to.id, text: body }, to.peer)
      setText(""); setNote(r?.message || "Posted."); onPosted()
    } catch (err) { setNote("Not posted: " + (err as Error).message) }
    setSending(false)
  }
  return (
    <form onSubmit={send} aria-label="Give an agent a task" className={FEED_COMPOSER}>
      <textarea
        rows={1} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } }}
        placeholder="Give an agent a task. Type @ to pick who." aria-label="Give an agent a task"
        className="max-h-[200px] min-h-6 w-full resize-none bg-transparent text-base leading-normal text-foreground outline-none [field-sizing:content] placeholder:text-muted-foreground md:text-sm"
      />
      <div className="flex min-h-8 items-center gap-2">
        <label className="relative inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-[13px] text-foreground-2 focus-within:shadow-[var(--ax-focus-ring)] can-hover:hover:bg-muted [&_[aria-hidden]]:size-3.5 [&_[aria-hidden]]:text-muted-foreground">
          <Icon name="at-sign" />
          <select value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Agent" className="max-w-40 cursor-pointer appearance-none bg-transparent px-0.5 outline-none [field-sizing:content]">
            <option value="">Any agent</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <Icon name="chevrons-up-down" />
        </label>
        <span role="status" className="min-w-0 truncate text-xs text-muted-foreground">{note}</span>
        <span className="ml-auto whitespace-nowrap text-xs text-muted-foreground max-[1180px]:hidden">
          <Kbd className="mr-0.5 h-4 border-border bg-surface-2 px-[5px] font-sans text-[11px] leading-4">Enter</Kbd> to send,{" "}
          <Kbd className="mr-0.5 h-4 border-border bg-surface-2 px-[5px] font-sans text-[11px] leading-4">Shift Enter</Kbd> for a new line
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="submit" aria-label="Send" disabled={!text.trim() || sending}
              className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-full bg-primary text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:bg-muted disabled:text-muted-foreground max-[1180px]:ml-auto">
              <Icon name="arrow-up" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Send <Kbd>Enter</Kbd></TooltipContent>
        </Tooltip>
      </div>
    </form>
  )
}
