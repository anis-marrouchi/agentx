// --- The feed's frame: its column, the boxes' sizes and the skeleton (#2101) ---
//
// Anis's v0.289.0 note, fix 1: the feed must not jump while it loads. Each
// box above the posts (head, composer, status bar) has its height set here,
// once, and both the page and its skeleton draw them from these classes, so
// nothing above the posts moves when the page, its posts or the "Synced"
// time arrive. The skeleton is also the route's Suspense fallback
// (extensions/core.tsx), so this file stays small: only the Skeleton part,
// no query or popover code.
//
// The List view (R3) uses the same column and the same head, so switching
// Feed | List keeps the title still.
import type { ReactNode } from "react"
import { cn } from "../ui/cn"
import { Skeleton } from "../ui/misc"

/** One column, 976 px of content plus 24 px gutters: the List's width, so
 *  Feed | List never changes the width (#2592; orca-design C3). */
export const FEED_COLUMN = "mx-auto flex w-full max-w-[1024px] flex-col px-6 pb-12 max-sm:px-4"
/** The head: the title row, and on a phone the Feed | List switch on a line
 *  of its own. Nothing in it waits on data; the skeleton draws the same lines. */
export const FEED_HEAD = "flex flex-wrap items-center gap-2 pb-4 pt-6 max-sm:py-3"
export const FEED_TITLE = "text-2xl font-semibold leading-8 tracking-[-0.01em] max-sm:text-xl"
/** Feed | List: a toggle group beside the title, its own line on a phone. */
export const FEED_SWITCH = "ml-1 inline-flex h-8 gap-0.5 rounded-md bg-muted p-0.5 max-sm:order-10 max-sm:m-0 max-sm:mt-1 max-sm:h-9 max-sm:flex-[1_0_100%]"
/** The composer: one bordered box, 84 px until the words wrap. */
export const FEED_COMPOSER = "mb-5 flex flex-col gap-1.5 rounded-xl border border-border bg-background pb-2 pl-4 pr-3 pt-3 shadow-xs focus-within:border-input max-sm:mb-3"
/** The status tabs' bar: 40 px, the "Synced" time at its end. */
export const FEED_BAR = "sticky top-0 z-[3] flex h-10 items-center gap-3 border-b border-border bg-background max-sm:static"

/** The column every feed view sits in. */
export function FeedColumn({ children, className }: { children: ReactNode; className?: string }) {
  return <div data-slot="feed" className={cn(FEED_COLUMN, className)}>{children}</div>
}

/** Rows shaped like a group and its posts while the first read is on its way. */
export function FeedSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading tasks" className="flex flex-col">
      <div className="flex items-center gap-2 border-b border-border pb-2.5 pt-4"><Skeleton className="h-5 w-32" /></div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex gap-4 border-b border-border py-4 max-sm:gap-3">
          <Skeleton className="size-7" />
          <div className="flex flex-1 flex-col gap-2"><Skeleton className="h-4 w-40" /><Skeleton className="h-4 w-3/4" /><Skeleton className="h-4 w-1/2" /></div>
        </div>
      ))}
    </div>
  )
}

/** The whole page before its code arrives: the same boxes, empty. */
export function FeedPageSkeleton() {
  return (
    <FeedColumn>
      <header className={FEED_HEAD}>
        <h1 className={cn(FEED_TITLE, "sm:ml-16")}>Hub</h1>
        <Skeleton className={cn(FEED_SWITCH, "w-[136px]")} />
        <Skeleton className="ml-auto h-8 w-[280px] max-sm:w-20" />
      </header>
      <div className={FEED_COMPOSER}><div className="h-6" /><div className="h-8" /></div>
      <div className={FEED_BAR}><Skeleton className="h-4 w-80 max-sm:w-56" /></div>
      <FeedSkeleton />
    </FeedColumn>
  )
}
