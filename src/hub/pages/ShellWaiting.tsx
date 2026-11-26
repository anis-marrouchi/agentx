// --- Waiting on you in the simple shell (#2226 S5) ---
//
// The centre's Waiting on you pane: the owner's one list (waiting.ts), the
// longest waiting first. Opening an item shows what is asked, what is
// known, what yes and no do and when it must be answered, in the same pane.
// Answers are made where they are made today: "Answer" opens the old Hub's
// Needs you (yes, no, a choice, later), and a request's task opens in Tasks.
import { useQuery } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { apiGet } from "../api"
import { shortAgo } from "../tasks"
import {
  NEEDS_YOU_PAGE, WAITING_URL, waitingHref, waitingKind, waitingList, waitingSoon, waitingTaskId,
  type WaitingItem, type WaitingList, type WaitingReply,
} from "../waiting"
import { taskHref } from "./ShellTasks"
import { Badge, Button, EmptyState, Icon, Skeleton, buttonVariants, cn } from "../ui"

function When({ item, now }: { item: WaitingItem; now: number }) {
  const asked = item.askedAt ? Date.parse(item.askedAt) : NaN
  const soon = waitingSoon(item, now)
  return (
    <span className="flex shrink-0 items-center gap-2 text-xs tabular-nums text-muted-foreground">
      {soon ? <Badge variant="warn" className="text-[11px]">Answer today</Badge> : null}
      {Number.isFinite(asked) ? <span title={new Date(asked).toLocaleString()}>{shortAgo(asked, now)}</span> : null}
    </span>
  )
}

/** One row per item: its kind, its title and question, who asked, how long ago. */
export function WaitingRows({ items, now = Date.now() }: { items: WaitingItem[]; now?: number }) {
  return (
    <ul data-waiting="list" className="divide-y divide-border rounded-md border border-border">
      {items.map((i) => (
        <li key={i.key}>
          <a href={waitingHref(i.key)} data-waiting-item={i.key} className="flex items-start gap-3 px-3 py-2.5 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
            <Badge variant="outline" className="mt-px w-[72px] shrink-0 justify-center text-[11px] font-normal text-muted-foreground">{waitingKind(i.kind)}</Badge>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-[13px]">{i.title}</span>
              {i.ask || i.need ? <span className="truncate text-xs text-muted-foreground">{i.ask || "Needed from you: " + i.need}</span> : null}
            </span>
            <span className="hidden max-w-[120px] truncate pt-px text-xs text-muted-foreground sm:block">{i.agent ? "@" + i.agent : ""}</span>
            <When item={i} now={now} />
          </a>
        </li>
      ))}
    </ul>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="whitespace-pre-wrap break-words">{children}</dd>
    </>
  )
}

/** An opened item: the question, then what is known and what each answer does. */
export function WaitingDetail({ item, now = Date.now() }: { item: WaitingItem; now?: number }) {
  const task = waitingTaskId(item)
  const soon = waitingSoon(item, now)
  return (
    <article data-waiting="open" data-waiting-item={item.key} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline" className="text-[11px] font-normal">{waitingKind(item.kind)}</Badge>
          {item.agent ? <span>@{item.agent}</span> : null}
          {item.nodeName ? <span>{item.nodeName}</span> : null}
          {item.askedAt ? <span>asked {new Date(item.askedAt).toLocaleString()}</span> : null}
        </p>
        <h2 className="text-base font-medium">{item.title}</h2>
        {item.ask ? <p className="text-sm whitespace-pre-wrap">{item.ask}</p>
          : item.need ? <p className="text-sm">Needed from you: {item.need}</p> : null}
      </div>
      {item.choices?.length ? (
        <ol className="flex flex-col gap-1 text-sm" data-waiting="choices">
          {item.choices.map((c, n) => <li key={n} className="rounded-md border border-border px-3 py-1.5">{c}</li>)}
        </ol>
      ) : null}
      <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-2 border-y border-border py-3 text-[13px]">
        {item.said ? <Field label="You said">{item.said}</Field> : null}
        {item.facts ? <Field label="What is known">{item.facts}</Field> : null}
        {item.recommend ? <Field label="Suggested">{item.recommend}</Field> : null}
        {item.yes ? <Field label="Yes">{item.yes}</Field> : null}
        {item.no ? <Field label="No">{item.no}</Field> : null}
        {item.expires ? (
          <Field label="Answer by">
            <span className={soon ? "text-warn-ink" : ""}>{new Date(item.expires).toLocaleString()}</span>
            {item.ifSilent ? <span className="text-muted-foreground">. If you say nothing: {item.ifSilent}</span> : null}
          </Field>
        ) : null}
        {!item.said && !item.facts && !item.recommend && !item.yes && !item.no && !item.expires ? <Field label="Details">Nothing more on record.</Field> : null}
      </dl>
      <div className="flex flex-wrap items-center gap-2">
        <a href={NEEDS_YOU_PAGE} className={buttonVariants({ size: "sm" })} data-waiting="answer">
          Answer <Icon name="external-link" className="size-3.5" />
        </a>
        {task ? <a href={taskHref(task)} className={buttonVariants({ size: "sm", variant: "outline" })} data-waiting="task">Open the task</a> : null}
        <span className="text-xs text-muted-foreground">Answers open the old Hub's Waiting on you, where yes, no and later are given.</span>
      </div>
    </article>
  )
}

export interface WaitingBodyProps {
  list?: WaitingList
  error?: string | null
  onRetry?: () => void
  now?: number
}

/** Loading, error, empty, or the items, with what could not be read said above. */
export function WaitingBody({ list, error, onRetry, now }: WaitingBodyProps) {
  if (error) {
    return (
      <EmptyState title="Could not read what waits on you" action={<Button size="sm" variant="outline" onClick={onRetry}>Try again</Button>}>
        <span role="alert">{error}</span>
      </EmptyState>
    )
  }
  if (!list) return <div className="flex flex-col gap-2"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-2/3" /></div>
  return (
    <div className="flex flex-col gap-3">
      {list.errors.map((e, n) => <p key={n} role="alert" className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn-ink">{e}</p>)}
      {list.items.length === 0 ? (
        <EmptyState title="Nothing waits for you" action={<a className="text-sm text-link hover:underline" href="#page=home&pane=tasks">See the tasks</a>}>
          When an agent asks you to decide or approve something, it shows here.
        </EmptyState>
      ) : <WaitingRows items={list.items} now={now} />}
      {list.later ? (
        <p className="px-1 text-xs text-muted-foreground">
          {list.later} put off for later. <a className="text-link hover:underline" href={NEEDS_YOU_PAGE}>See them in the old Hub's Waiting on you</a>.
        </p>
      ) : null}
    </div>
  )
}

const errText = (e: unknown) => (e instanceof Error ? e.message : "the computer did not answer")

/** The pane: reads the owner's list every 15 s, as the phone's Desk does. */
export function WaitingPane({ open, phoneBar }: { open: string | null; phoneBar?: ReactNode }) {
  const q = useQuery({ queryKey: ["shell-waiting"], queryFn: () => apiGet<WaitingReply>(WAITING_URL), refetchInterval: 15_000 })
  const list = q.data ? waitingList(q.data) : undefined
  const item = open ? list?.items.find((i) => i.key === open) : undefined
  return (
    <section aria-label="Waiting on you" data-shell="waiting" className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        {phoneBar}
        {open ? (
          <a href={waitingHref()} aria-label="Back to Waiting on you" title="Back to Waiting on you" className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
            <Icon name="arrow-left" />
          </a>
        ) : null}
        <h1 className="truncate text-sm font-medium">Waiting on you</h1>
        {!open && list ? <span className="text-xs tabular-nums text-muted-foreground">{list.items.length}</span> : null}
      </header>
      <div className={cn("mx-auto min-h-0 w-full max-w-[784px] flex-1 overflow-y-auto px-4 py-4")}>
        {open ? (
          q.isError ? <WaitingBody error={errText(q.error)} onRetry={() => void q.refetch()} />
            : !list ? <Skeleton className="h-16 w-full" />
            : !item ? <EmptyState title="No longer waiting" action={<a className="text-sm text-link hover:underline" href={waitingHref()}>Waiting on you</a>}>It was answered, put off for later, or it expired.</EmptyState>
            : <WaitingDetail item={item} />
        ) : (
          <WaitingBody list={list} error={q.isError ? errText(q.error) : null} onRetry={() => void q.refetch()} />
        )}
      </div>
    </section>
  )
}
