// --- The feed's parts: a post's state, author, actions, card and row (#2101) ---
//
// The approved orca mock (#2387), drawn with the kit and the Tailwind
// tokens. The List view (a later PR) builds its rows from the same parts:
// StateLabel, Avatar, RowActions, RelTime and the actions context.
//
// orca-design: one state set with icon + word (recipes §9, C27); colour only
// for state, red only for a failure (C6); link and ... on hover or focus and
// always on touch, Stop always visible (C12); one relative time in a <time>
// with the full stamp in its tooltip (C17); icon buttons have a tooltip and
// an sr-only name (C14).
//
// No data-agent, data-open, data-tab or data-post attributes here: the old
// Hub's script listens for those on the whole document.
import { useQuery } from "@tanstack/react-query"
import { Fragment, createContext, useContext, useState, type ReactNode } from "react"
import { apiFetch } from "../api"
import { taskThreadUrl, type TaskThreadReply } from "../tasks"
import {
  Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, EmptyState, Icon, type ButtonProps, Skeleton,
  Tooltip, TooltipContent, TooltipTrigger, cn,
} from "../ui"
import { fdAgo, fdExcerpt } from "../../daemon/ui/pages/wall-feed-model"
import type { WallOwnerCard } from "../../daemon/wall-api"
import { initials, mins, postHash, stamp, stateInfo, until, waitLine, type FeedPost } from "./model"

// --- What a row can do, given by the page ---

export type DecideAction = "yes" | "no"
export interface FeedActions {
  /** Display name of an agent. */
  nameOf: (id: string) => string
  /** The owner can answer cards (false only when the server says not). */
  owner: boolean
  open: (p: FeedPost) => void
  copy: (p: FeedPost) => void
  stop: (p: FeedPost) => void
  retry: (p: FeedPost) => void
  call: (p: FeedPost) => void
  decide: (p: FeedPost, card: WallOwnerCard, action: DecideAction) => void
  /** Post ids with a call in flight, the one whose link was just copied,
   *  and one line per post saying what an action did. */
  busy: Record<string, boolean>
  copied: string
  said: Record<string, string>
}

export const FeedActionsContext = createContext<FeedActions | null>(null)
function useFeedActions(): FeedActions {
  const a = useContext(FeedActionsContext)
  if (!a) throw new Error("FeedActionsContext is missing")
  return a
}

// --- Small parts ---

const TONE: Record<string, string> = {
  warn: "text-warn-ink", err: "text-err-ink", text: "text-foreground", muted: "text-muted-foreground", ok: "text-muted-foreground [&_svg]:text-ok",
}

/** A state as icon + word in its tone; the Working icon turns. */
export function StateLabel({ state, className }: { state: string; className?: string }) {
  const s = stateInfo(state)
  return (
    <span data-slot="feed-state" data-state={state} className={cn("inline-flex shrink-0 items-center gap-1.5 text-[13px]", TONE[s.tone], className)}>
      <Icon name={s.icon} className={cn("size-3.5", state === "working" && "animate-spin [animation-duration:1s] motion-reduce:animate-none")} />
      <span>{s.word}</span>
    </span>
  )
}

/** An author's square: initials on the quiet surface. */
export function Avatar({ name, className }: { name: string; className?: string }) {
  return (
    <span data-slot="feed-avatar" aria-hidden="true" className={cn("grid size-7 shrink-0 place-items-center rounded-md border border-border bg-surface-2 text-[11px] font-semibold text-foreground-2", className)}>
      {initials(name)}
    </span>
  )
}

/** One relative time (now, 2m, 1h, 2d) with the full stamp in its tooltip. */
export function RelTime({ ms, now = Date.now(), className }: { ms: number; now?: number; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time dateTime={new Date(ms).toISOString()} className={className}>{fdAgo(ms, now)}</time>
      </TooltipTrigger>
      <TooltipContent>{stamp(ms)}</TooltipContent>
    </Tooltip>
  )
}

/** A quiet icon button with its tooltip and screen-reader name. */
export function IconButton({ label, icon, className, ...rest }: { label: string; icon: string } & Omit<ButtonProps, "children">) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={label} className={cn("size-7 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground", className)} {...rest}>
          <Icon name={icon} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** Shown on hover or focus with a pointer, always on touch (C12). */
const HOVER = "can-hover:opacity-0 can-hover:transition-opacity can-hover:duration-[120ms] can-hover:ease-out can-hover:group-hover/row:opacity-100 can-hover:group-focus-within/row:opacity-100 can-hover:data-[state=open]:opacity-100"

/** The rare actions: each opens the task where it is done today, Call runs here. */
const MENU: ReadonlyArray<readonly [string, string, string]> = [
  ["hand", "arrow-right", "Hand off to another agent"],
  ["runon", "server", "Run on another machine"],
  ["call", "phone", "Call me about it"],
  ["space", "radio", "Start a Space"],
  ["done", "circle-check", "Close as done"],
]

/** The ... menu of a task (the kit's DropdownMenu: arrow keys, Esc, focus back). */
export function RowMenu({ post }: { post: FeedPost }) {
  const a = useFeedActions()
  const pick = (kind: string) => (kind === "call" ? a.call(post) : a.open(post))
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="More actions" data-fk="menu" className={cn("size-7 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground data-[state=open]:bg-muted", HOVER)}>
              <Icon name="ellipsis" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>More actions</TooltipContent>
      </Tooltip>
      <DropdownMenuContent aria-label="Task actions" onClick={(e) => e.stopPropagation()}>
        {MENU.map(([kind, icon, label], i) => (
          <Fragment key={kind}>
            {i === MENU.length - 1 && <DropdownMenuSeparator />}
            <DropdownMenuItem onSelect={() => pick(kind)} className="whitespace-nowrap"><Icon name={icon} className="text-muted-foreground" />{label}</DropdownMenuItem>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The end of a row: link and ... on hover or focus, Stop always while it
 *  runs. `list`: the List view's compact form (icon buttons, Retry here). */
export function RowActions({ post, state, running, list }: { post: FeedPost; state: string; running: boolean; list?: boolean }) {
  const a = useFeedActions()
  const copied = a.copied === post.id
  const busy = !!a.busy[post.id]
  return (
    <span data-slot="feed-actions" className="ml-auto inline-flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
      <IconButton label={copied ? "Link copied" : "Copy link"} icon={copied ? "check" : "link"} onClick={() => a.copy(post)} className={cn(HOVER, !list && "max-sm:hidden")} data-fk="copy" />
      <RowMenu post={post} />
      {state === "working" && running && (list
        ? <IconButton label="Stop" icon="square" onClick={() => a.stop(post)} disabled={busy} data-fk="stop" />
        : <Button variant="outline" size="xs" disabled={busy} onClick={() => a.stop(post)} data-fk="stop" className="ml-1.5 h-6 bg-background text-xs [&_svg]:size-3.5"><Icon name="square" />Stop</Button>)}
      {state === "failed" && list && <IconButton label="Retry" icon="rotate-ccw" onClick={() => a.retry(post)} disabled={busy} data-fk="retry" />}
    </span>
  )
}

// --- A card that waits on you, a failed run, the meta line ---

/** The card, compact: the question, its facts, Deny and Approve, and the
 *  line that says what is sent before it is. */
export function OwnerCard({ post, card, now }: { post: FeedPost; card: WallOwnerCard; now: number }) {
  const a = useFeedActions()
  const [confirm, setConfirm] = useState<DecideAction | null>(null)
  const expired = card.expiresAt <= now
  const facts: Array<[string, string]> = []
  if (card.ask && card.ask !== card.title) facts.push(["Asks", card.ask])
  if (card.recommend) facts.push(["Suggests", card.recommend])
  if (card.silence) facts.push(["If no answer", card.silence])
  const busy = !!a.busy["card:" + card.id]
  return (
    <section data-slot="feed-card" aria-label={"Waiting on you: " + card.title} onClick={(e) => e.stopPropagation()} className="mt-2 cursor-default rounded-md border border-border bg-background p-3 text-[13px]">
      <p className="mb-2 font-medium text-foreground [overflow-wrap:anywhere]">{card.title}</p>
      {facts.length > 0 && (
        <dl className="mb-2 grid grid-cols-[100px_1fr] gap-x-3 gap-y-1 max-sm:grid-cols-[80px_1fr]">
          {facts.map(([k, v]) => (
            <div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd className="text-foreground [overflow-wrap:anywhere]">{v}</dd></div>
          ))}
        </dl>
      )}
      <div className="flex items-center gap-2">
        <span className={cn("inline-flex items-center gap-1.5 text-xs", expired ? "text-err-ink" : "text-muted-foreground")}>
          <Icon name="hourglass" className="size-3.5" />
          <Tooltip>
            <TooltipTrigger asChild><time dateTime={new Date(card.expiresAt).toISOString()}>{expired ? "Expired" : "Expires " + until(card.expiresAt, now)}</time></TooltipTrigger>
            <TooltipContent>{stamp(card.expiresAt)}</TooltipContent>
          </Tooltip>
        </span>
        {a.owner && (
          <span className="ml-auto inline-flex gap-2">
            <Button variant="ghost" size="sm" aria-pressed={confirm === "no"} disabled={busy} onClick={() => setConfirm("no")} className="h-8 px-3 text-[13px]">Deny</Button>
            <Button size="sm" aria-pressed={confirm === "yes"} disabled={busy} onClick={() => setConfirm("yes")} className="h-8 px-3 text-[13px]">Approve</Button>
          </span>
        )}
      </div>
      {confirm && (
        <div role="group" aria-label="Confirm your answer" className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border pt-2">
          <p className="min-w-0 flex-1 text-foreground-2">
            <b className="font-medium text-foreground">Send {a.nameOf(card.raisedBy || post.owner)}: {confirm === "yes" ? "Yes" : "No"}.</b>{" "}
            It is recorded as your answer and cannot be taken back.
          </p>
          <span className="inline-flex gap-2">
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirm(null)} className="h-8 px-3 text-[13px]">Back</Button>
            <Button size="sm" disabled={busy} onClick={() => { a.decide(post, card, confirm); setConfirm(null) }} className="h-8 px-3 text-[13px]">Confirm</Button>
          </span>
        </div>
      )}
    </section>
  )
}

/** A failed run: what failed, its run id, and Retry. The one red. */
export function FailLine({ post }: { post: FeedPost }) {
  const a = useFeedActions()
  const f = post.lastFailure
  const said = a.said[post.id]
  return (
    <div data-slot="feed-fail" onClick={(e) => e.stopPropagation()} className="mt-1.5 flex cursor-default items-center gap-3 rounded-md border border-err-edge bg-err-tint py-2 pl-3 pr-2 text-err-ink">
      <p className="min-w-0 flex-1 text-[13px] [overflow-wrap:anywhere]">
        {f ? <>Run failed: {f.error}, run <code className="font-mono text-xs">{f.taskId}</code></> : "It needs attention: its last step did not finish."}
        {said && <span role="status" className="text-foreground-2"> {said}</span>}
      </p>
      <Button variant="outline" size="xs" disabled={!!a.busy[post.id]} onClick={() => a.retry(post)} data-fk="retry" className="h-6 shrink-0 bg-background text-xs text-foreground [&_svg]:size-3.5">
        <Icon name="rotate-ccw" />Retry
      </Button>
    </div>
  )
}

const META = "inline-flex items-center gap-[5px] whitespace-nowrap [&_[aria-hidden]]:size-3.5"

/** The thread under a post, from the read the old Hub's opened post makes. */
function Thread({ post }: { post: FeedPost }) {
  const peer = post.node?.peer
  const q = useQuery({
    queryKey: ["feed-thread", post.id, peer],
    queryFn: () => apiFetch<TaskThreadReply>(taskThreadUrl(post.id), peer ? { headers: { "X-Agentx-Peer": peer } } : {}),
  })
  if (q.isPending) return <div className="mt-2 flex flex-col gap-2" aria-busy="true"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-4 w-1/2" /></div>
  if (q.isError) return <p className="mt-2 text-xs text-err-ink">Could not read the thread: {(q.error as Error).message}</p>
  const events = (q.data?.events ?? []).filter((e) => e.text)
  if (!events.length) return <p className="mt-2 text-xs text-muted-foreground">Nothing in the thread yet.</p>
  return (
    <ol data-slot="feed-thread" className="mt-2 flex flex-col border-l border-border pl-3">
      {events.map((e, i) => (
        <li key={i} className="flex flex-col gap-0.5 py-1.5 text-[13px]">
          <span className="flex items-baseline gap-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{e.who || e.kind}</span>
            <RelTime ms={e.at} />
          </span>
          <span className="line-clamp-3 text-foreground-2 [overflow-wrap:anywhere]">{e.text}</span>
        </li>
      ))}
    </ol>
  )
}

// --- One post in the feed ---

export function FeedRow({ post, state, running, now }: { post: FeedPost; state: string; running: boolean; now: number }) {
  const a = useFeedActions()
  const [thread, setThread] = useState(false)
  const text = fdExcerpt(post)
  const cards = post.ownerCards ?? []
  const wait = state === "waiting" || (state === "needs" && !cards.length) ? waitLine(post, now) : ""
  const said = a.said[post.id]
  const name = a.nameOf(post.owner)
  return (
    <article
      data-slot="feed-row" data-key={"p:" + post.id} id={"post-" + post.id} tabIndex={0} aria-label={post.headline}
      onClick={(e) => { if (!(e.target as HTMLElement).closest("button,a,input,select,textarea,[role=dialog]")) a.open(post) }}
      onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) a.open(post) }}
      className="group/row flex cursor-pointer gap-4 border-b border-border py-4 focus-visible:rounded-md focus-visible:shadow-[var(--ax-focus-ring)] focus-visible:outline-none max-sm:gap-3"
    >
      <Avatar name={name} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-baseline gap-2 text-[13px] text-muted-foreground">
          <span className="font-medium text-foreground">{name}</span>
          <span className="min-w-0 truncate font-mono text-xs max-sm:hidden">{post.owner}</span>
          <a href={postHash(post)} onClick={(e) => { e.preventDefault(); a.open(post) }} className="shrink-0 font-normal text-muted-foreground can-hover:hover:underline">
            <RelTime ms={post.lastMoveAt} now={now} />
          </a>
          <StateLabel state={state} className="ml-auto self-center" />
        </div>
        <h3 className="text-sm font-medium leading-[1.4] text-foreground [overflow-wrap:anywhere]">{post.headline}</h3>
        {text && text !== post.headline && <p className="line-clamp-2 text-[13px] leading-normal text-foreground-2 [overflow-wrap:anywhere]">{text}</p>}
        {post.copies && post.copies.length > 0 && <p className="text-xs text-muted-foreground">{post.copies.length === 1 ? "1 more copy of this task" : post.copies.length + " more copies of this task"}</p>}
        {wait && <p className="text-xs text-muted-foreground">{wait}</p>}
        {cards.map((c) => <OwnerCard key={c.id} post={post} card={c} now={now} />)}
        {state === "failed" && <FailLine post={post} />}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground max-sm:flex-nowrap">
          <button type="button" aria-expanded={thread} data-fk="thread" onClick={() => setThread((v) => !v)} className={cn(META, "cursor-pointer can-hover:hover:text-foreground")}>
            <Icon name="message-circle" />{thread ? "Hide thread" : "Thread"}
          </button>
          <span className={META} title="Runs that worked on it"><Icon name="repeat-2" />{post.runs}{post.runs === 1 ? " run" : " runs"}</span>
          {post.runMs > 0 && <span className={META} title="Minutes the runs took"><Icon name="timer" />{mins(post.runMs)} min</span>}
          {post.project && <span className={cn(META, "max-sm:hidden")} title="Project"><Icon name="folder" />{post.project}</span>}
          {post.goal && <span className={META} title="Goal">Goal: {post.goal.title}</span>}
          {said && state !== "failed" && <span role="status" className="text-foreground-2">{said}</span>}
          <RowActions post={post} state={state} running={running} />
        </div>
        {thread && <Thread post={post} />}
      </div>
    </article>
  )
}

// --- A group: chevron, title, count; three rows, then Show all (N) ---

export function FeedSection({ id, title, count, open, onOpen, all, onAll, cap, children }: {
  id: string; title: string; count: number; open: boolean; onOpen: (v: boolean) => void; all: boolean; onAll: (v: boolean) => void; cap: number; children: ReactNode
}) {
  const more = count > cap
  return (
    <section data-slot="feed-section" data-key={"g:" + id} data-state={open ? "open" : "closed"} aria-labelledby={"fd-sec-" + id}>
      <h2 className="m-0">
        <button
          type="button" id={"fd-sec-" + id} aria-expanded={open} aria-controls={"fd-rows-" + id} onClick={() => onOpen(!open)}
          className="flex w-full cursor-pointer items-center gap-2 border-b border-border pb-2.5 pt-4 text-left text-[13px] font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Icon name="chevron-down" className={cn("text-muted-foreground transition-transform duration-150 ease-out motion-reduce:transition-none", !open && "-rotate-90")} />
          <span>{title}</span>
          <span className="font-normal tabular-nums text-muted-foreground">{count}</span>
        </button>
      </h2>
      <div id={"fd-rows-" + id} hidden={!open}>
        {children}
        {more && (
          <button type="button" aria-expanded={all} onClick={() => onAll(!all)} className="mb-2 ml-11 mt-1 cursor-pointer rounded-sm px-1 py-1 text-xs font-medium text-muted-foreground can-hover:hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {all ? "Show fewer" : `Show all (${count})`}
          </button>
        )}
      </div>
    </section>
  )
}

/** No post matches: say so, and offer to clear the filters. */
export function FeedEmpty({ onClear }: { onClear: () => void }) {
  return (
    <EmptyState title="No tasks match these filters" className="mt-6" action={<Button variant="outline" size="sm" onClick={onClear}>Clear filters</Button>} />
  )
}

