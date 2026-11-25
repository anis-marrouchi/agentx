// Small parts of the set (#2218 part 4). Skeleton is from shadcn/ui (MIT,
// see NOTICE.md); Kbd, StatusDot and EmptyState are AgentX's own.
import * as React from "react"
import { cn } from "./cn"

export function Skeleton({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("animate-pulse rounded-md bg-muted motion-reduce:animate-none", className)} {...p} />
}

export function Kbd({ className, ...p }: React.HTMLAttributes<HTMLElement>) {
  return <kbd className={cn("inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-border bg-muted px-1 font-mono text-[11px] text-muted-foreground", className)} {...p} />
}

export type DotState = "ok" | "work" | "warn" | "err" | "idle"
const DOT: Record<DotState, string> = {
  ok: "bg-ok", work: "bg-primary animate-pulse motion-reduce:animate-none", warn: "bg-warn", err: "bg-destructive", idle: "bg-muted-foreground/50",
}

/** A state dot with its word for screen readers. */
export function StatusDot({ state, label, className }: { state: DotState; label: string; className?: string }) {
  return <span className={cn("inline-block size-2 shrink-0 rounded-full", DOT[state], className)} role="img" aria-label={label} title={label} />
}

export function EmptyState({ title, children, action, className }: { title: string; children?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-10 text-center", className)}>
      <p className="text-sm font-medium">{title}</p>
      {children ? <p className="max-w-sm text-sm text-muted-foreground">{children}</p> : null}
      {action}
    </div>
  )
}
