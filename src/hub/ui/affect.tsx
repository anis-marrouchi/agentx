// The affectUI treatments for React pages (#2152). No styles here: the
// classes come from the one style source, src/daemon/ui/affect.css.ts, which
// the Hub document already loads. Adapted from affectUI's clean items
// (MIT, src/daemon/ui/LICENSE.affectui).
import * as React from "react"
import { cn } from "./cn"

export type AfState = "running" | "done" | "waiting" | "error" | "idle"

/** A card with a count-led heading (Decision Inbox). */
export function AfCard({ title, count, action, className, children }: { title: React.ReactNode; count?: number; action?: React.ReactNode; className?: string; children?: React.ReactNode }) {
  return (
    <section data-slot="af-card" className={cn("ax-af-card", className)}>
      <header className="ax-af-card__head">
        <span className="ax-af-card__title">{title}</span>
        {count != null ? <AfCount n={count} /> : null}
        {action}
      </header>
      {children}
    </section>
  )
}

/** A number next to a label; hidden at 0. */
export function AfCount({ n, tone, label }: { n: number; tone?: "warn"; label?: string }) {
  return <span data-slot="af-count" className="ax-af-count" data-n={n} data-tone={tone} aria-label={label}>{n}</span>
}

/** One folded row: name, mono detail, state at the end (Tool Call Card). */
export function AfRow({ name, meta, state, stateLabel, className, children }: { name: React.ReactNode; meta?: React.ReactNode; state?: AfState; stateLabel?: string; className?: string; children?: React.ReactNode }) {
  return (
    <div data-slot="af-row" className={cn("ax-af-row", className)}>
      <span className="ax-af-row__name">{name}</span>
      {meta ? <span className="ax-af-row__meta">{meta}</span> : null}
      {children}
      {state ? <AfStateLabel state={state} label={stateLabel} /> : null}
    </div>
  )
}

const WORD: Record<AfState, string> = { running: "Running", done: "Done", waiting: "Waiting", error: "Failed", idle: "Idle" }

/** A state dot and its word: colour only for state. */
export function AfStateLabel({ state, label }: { state: AfState; label?: string }) {
  return <span data-slot="af-state" className="ax-af-state" data-state={state}>{label ?? WORD[state]}</span>
}

const RAYS = Array.from({ length: 8 }, (_, i) => i)

/** The eight-ray loader (Thinking Loader). */
export function AfLoader({ children }: { children: React.ReactNode }) {
  return (
    <span data-slot="af-loader" className="ax-af-loader" role="status">
      <span className="ax-af-loader__rays" aria-hidden="true">
        {RAYS.map((i) => <span key={i} style={{ rotate: `${i * 45}deg`, animationDelay: `${(i - 8) * 0.1}s` }} />)}
      </span>
      {children}
    </span>
  )
}

/** Skeleton lines shaped like the rows they stand for. */
export function AfSkeletonRows({ rows = 3 }: { rows?: number }) {
  return <div data-slot="af-skeleton" aria-busy="true">{Array.from({ length: rows }, (_, i) => <span key={i} className="ax-af-skeleton" />)}</div>
}
