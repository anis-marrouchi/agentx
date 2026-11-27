// --- The Task page's parts (#2101 T1) ---
//
// What TaskPage draws, each from task-data.ts: the stage strip, a folding
// section, the plan, the facts, the links, the thread and the skeleton.
// orca-design: grey chrome, colour only for state (recipes §9), hairlines
// between rows, lucide icons, one relative time format in a <time> with
// its full stamp in a tooltip.
import { useState, type ReactNode } from "react"
import { markdownToHtml } from "../../utils/markdown-html"
import { Icon, Skeleton, Tooltip, TooltipContent, TooltipTrigger, cn } from "../ui"
import {
  EVENT_WORD, eventFailed, foldEvents, planCount, proofOf, shortAgo, stepState,
  type Fact, type Stage, type StepTone, type TaskEvent, type TaskLink, type TaskPlanStep,
} from "./task-data"

/** The full stamp a time's tooltip shows. */
export const stamp = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })

/** "5m" in a <time>, the full stamp in its tooltip (C17). */
export function Ago({ at, now, className }: { at: number; now: number; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time dateTime={new Date(at).toISOString()} className={cn("tabular-nums", className)}>{shortAgo(at, now)}</time>
      </TooltipTrigger>
      <TooltipContent>{stamp(at)}</TooltipContent>
    </Tooltip>
  )
}

/** Markdown from an agent, escaped first (src/utils/markdown-html.ts). */
export function Prose({ text, className }: { text: string; className?: string }) {
  return (
    <div
      data-slot="task-prose"
      className={cn(
        "min-w-0 break-words text-sm leading-6 [&_a]:text-link [&_a]:underline-offset-4 [&_a]:can-hover:hover:underline [&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-[12.5px]",
        "[&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:ml-5 [&_ol]:list-decimal [&_ul]:list-disc [&_p+*]:mt-2 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-border [&_pre]:bg-muted/50 [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0",
        className,
      )}
      dangerouslySetInnerHTML={{ __html: markdownToHtml(text) }}
    />
  )
}

// --- Where it stands ---

const BAR: Record<Stage["mark"], string> = {
  now: "bg-primary", wait: "bg-warn", done: "bg-muted-foreground/40", end: "bg-muted-foreground/40", todo: "bg-border",
}

/** Asked, Working, Waits (only while it waits), Done: a bar over each, blue
 *  on the current one, amber while it waits. */
export function StageStrip({ stages }: { stages: Stage[] }) {
  return (
    <ol data-slot="task-stages" aria-label="Where it stands" className="grid gap-2" style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(0, 1fr))` }}>
      {stages.map((s) => (
        <li key={s.name} data-state={s.mark} aria-current={s.mark === "now" || s.mark === "wait" ? "step" : undefined} className="flex min-w-0 flex-col gap-1.5">
          <span aria-hidden="true" className={cn("h-1 rounded-full", BAR[s.mark])} />
          <span className={cn("text-[13px] font-medium", s.mark === "todo" && "text-muted-foreground")}>{s.name}</span>
          <span className="truncate text-xs text-muted-foreground" title={s.detail}>{s.detail || " "}</span>
        </li>
      ))}
    </ol>
  )
}

// --- A section that folds from its header (C22) ---

export function TaskSection({ id, title, count, action, defaultOpen = true, children }: {
  id: string; title: string; count?: ReactNode; action?: ReactNode; defaultOpen?: boolean; children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section data-slot="task-section" data-section={id} data-state={open ? "open" : "closed"} aria-labelledby={"task-h-" + id} className="flex flex-col gap-2">
      <div className="flex min-h-8 items-center gap-2">
        <button
          type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)}
          className="-ml-1 inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring can-hover:hover:text-foreground"
        >
          <Icon name="chevron-down" className={cn("size-3.5 transition-transform duration-150 ease-out motion-reduce:transition-none", !open && "-rotate-90")} />
          <span id={"task-h-" + id}>{title}</span>
          {count != null && <span className="font-normal normal-case tabular-nums tracking-normal">{count}</span>}
        </button>
        {action && <div className="ml-auto flex items-center gap-1.5">{action}</div>}
      </div>
      {open && children}
    </section>
  )
}

/** Rows split by hairlines inside one bordered box (C4, C7). */
export function Rows({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("overflow-hidden rounded-xl border border-border bg-card/50 shadow-xs [&>*+*]:border-t [&>*+*]:border-border", className)}>{children}</div>
}

// --- The plan ---

const TONE: Record<StepTone, string> = {
  done: "text-ok-ink", work: "text-primary", wait: "text-warn-ink", todo: "text-muted-foreground", skip: "text-muted-foreground",
}

export function PlanSteps({ plan, nameOf }: { plan: TaskPlanStep[]; nameOf: (id: string) => string }) {
  return (
    <Rows>
      {plan.map((s) => {
        const st = stepState(s.state)
        const proof = proofOf(s.evidence)
        return (
          <div key={s.idx} data-slot="task-step" data-state={s.state} className="flex items-start gap-3 px-4 py-2.5">
            <span className={cn("mt-0.5", TONE[st.tone])}>
              <Icon name={st.icon} className={cn(st.tone === "work" && "animate-spin [animation-duration:2s] motion-reduce:animate-none")} />
              <span className="sr-only">{st.word}</span>
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className={cn("text-[13px]", st.tone === "skip" && "text-muted-foreground line-through")}>{s.name}</span>
              <span className="text-xs text-muted-foreground">
                {nameOf(s.agentId)} · {st.word}{s.doneWhen ? " · done when " + s.doneWhen : ""}
              </span>
              {s.note && <span className="text-xs text-muted-foreground">{s.note}</span>}
            </div>
            {proof && (proof.href
              ? <a href={proof.href} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 text-xs text-link underline-offset-4 can-hover:hover:underline">{proof.text}<Icon name="external-link" className="size-3" /></a>
              : <span className="max-w-40 shrink-0 truncate text-xs text-muted-foreground" title={proof.text}>{proof.text}</span>)}
          </div>
        )
      })}
    </Rows>
  )
}

export const planLabel = (plan: TaskPlanStep[]) => { const c = planCount(plan); return c.done + " of " + c.total }

// --- The facts ---

export function FactList({ facts, now }: { facts: Fact[]; now: number }) {
  return (
    <Rows>
      <dl data-slot="task-facts" className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 px-4 py-1 max-sm:grid-cols-1">
        {facts.map((f) => (
          <div key={f.label} className="contents">
            <dt className="py-1.5 text-[13px] text-muted-foreground max-sm:pb-0">{f.label}</dt>
            <dd className={cn("min-w-0 break-words py-1.5 text-[13px] max-sm:pt-0", f.mono && "font-mono text-xs leading-5")}>
              {f.at ? <><Ago at={f.at} now={now} /><span className="text-muted-foreground"> · {stamp(f.at)}</span></> : f.value}
            </dd>
          </div>
        ))}
      </dl>
    </Rows>
  )
}

// --- Links out ---

const LINK_ICON: Record<TaskLink["kind"], string> = { home: "git-pull-request", proof: "circle-check", comment: "message-square", run: "history" }

export function LinkRow({ links }: { links: TaskLink[] }) {
  return (
    <ul data-slot="task-links" aria-label="Links" className="flex flex-wrap gap-1.5">
      {links.map((l, i) => {
        const body = <><Icon name={LINK_ICON[l.kind]} className="size-3.5 text-muted-foreground" /><span className="truncate">{l.label}</span></>
        const cls = "inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border border-border px-2 text-xs"
        return (
          <li key={l.kind + i} className="min-w-0 max-w-full">
            {l.href
              ? <a href={l.href} target={l.href.startsWith("#") ? undefined : "_blank"} rel="noreferrer" title={l.title} className={cn(cls, "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring can-hover:hover:bg-muted")}>{body}</a>
              : <span title={l.title} className={cn(cls, "text-muted-foreground")}>{body}</span>}
          </li>
        )
      })}
    </ul>
  )
}

// --- The thread ---

export function Thread({ events, now }: { events: TaskEvent[]; now: number }) {
  const folded = foldEvents(events)
  if (!folded.length) return <p className="px-1 text-[13px] text-muted-foreground">Nothing yet. A comment below starts the thread.</p>
  return (
    <ol data-slot="task-thread" aria-label="Thread" className="flex flex-col">
      {folded.map(({ event: e, count }, i) => {
        const failed = eventFailed(e)
        return (
          <li key={e.at + ":" + i} data-kind={e.kind} className="flex gap-3 border-b border-border/60 py-2.5 last:border-b-0">
            <span className={cn("mt-1 size-1.5 shrink-0 rounded-full", failed ? "bg-destructive" : "bg-muted-foreground/50")} aria-hidden="true" />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{e.who || "Hub"}</span>
                <span>{EVENT_WORD[e.kind] ?? e.kind}</span>
                {e.route && <span>→ @{e.route.to}</span>}
                {(e.mentions ?? []).map((m) => <span key={m}>→ @{m}</span>)}
                {failed && <span className="inline-flex items-center gap-1 text-err-ink"><Icon name="circle-alert" className="size-3" />{e.status === "timeout" ? "Timed out" : "Failed"}</span>}
                {count > 1 && <span className="tabular-nums">×{count}</span>}
                <Ago at={e.at} now={now} className="ml-auto" />
              </div>
              {e.text && <p className="whitespace-pre-wrap break-words text-[13px] leading-5">{e.text}</p>}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

// --- Loading: shaped like the page, so nothing moves when it lands ---

export function TaskSkeleton() {
  return (
    <div data-slot="task-skeleton" aria-busy="true" aria-label="Loading the task" className="flex flex-col gap-6">
      <div className="flex flex-col gap-2"><Skeleton className="h-4 w-24" /><Skeleton className="h-8 w-3/4" /><Skeleton className="h-4 w-1/2" /></div>
      <div className="grid grid-cols-4 gap-2">{[0, 1, 2, 3].map((i) => <div key={i} className="flex flex-col gap-1.5"><Skeleton className="h-1" /><Skeleton className="h-4 w-16" /><Skeleton className="h-3 w-20" /></div>)}</div>
      <Skeleton className="h-28 w-full rounded-xl" />
      <Skeleton className="h-40 w-full rounded-xl" />
    </div>
  )
}
