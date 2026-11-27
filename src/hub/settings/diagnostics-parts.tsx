// --- Settings › Diagnostics: the table, the bars and the live log tail (#2101 ST3b) ---
//
// Read-only parts. The table turns into stacked rows on a phone; the bars
// are one series (tasks) with the errors' share in red at the foot of each
// bar, a tooltip per bar; the log tail adds lines in place (keyed), so a new
// line never redraws the box or moves the filter's focus.
import { useEffect, useRef, useState, type ReactNode } from "react"
import { apiPost } from "../api"
import { Tooltip, TooltipContent, TooltipTrigger, cn } from "../ui"
import { EmptyLine } from "./parts"
import { lineTone, type Bucket } from "./system-data"

export interface Col<T> { head: string; cell: (r: T) => ReactNode; num?: boolean; mono?: boolean }

export function DataTable<T>({ cols, rows, empty, rowKey }: { cols: Col<T>[]; rows: T[]; empty: string; rowKey: (r: T, i: number) => string }) {
  if (!rows.length) return <EmptyLine>{empty}</EmptyLine>
  return (
    <div data-slot="settings-table" className="-mx-5 overflow-x-auto">
      <table className="w-full border-collapse text-[13px] max-sm:block">
        <thead className="max-sm:hidden">
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            {cols.map((c) => <th key={c.head} scope="col" className={cn("px-5 py-2.5 font-medium", c.num && "text-right")}>{c.head}</th>)}
          </tr>
        </thead>
        <tbody className="max-sm:block">
          {rows.map((r, i) => (
            <tr key={rowKey(r, i)} className="border-b border-border last:border-0 max-sm:flex max-sm:flex-col max-sm:gap-0.5 max-sm:px-5 max-sm:py-2.5">
              {cols.map((c, j) => (
                <td key={c.head} className={cn("px-5 py-2.5 align-top max-sm:flex max-sm:justify-between max-sm:gap-4 max-sm:p-0", c.num && "text-right tabular-nums", c.mono && "font-mono text-xs", j === 0 && "max-sm:font-medium")}>
                  {j > 0 && <span className="font-sans text-xs text-muted-foreground sm:hidden">{c.head}</span>}
                  <span>{c.cell(r)}</span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Tasks per slot, errors in red at the foot. `label` names each slot. */
export function Bars({ title, slots, label, axis }: { title: string; slots: (Bucket & { at: number })[]; label: (at: number) => string; axis: string[] }) {
  const max = Math.max(1, ...slots.map((s) => s.tasks ?? 0))
  if (!slots.some((s) => s.tasks)) return <EmptyLine>No tasks in this time.</EmptyLine>
  return (
    <div className="flex flex-col gap-1.5 py-4">
      <div role="img" aria-label={title} className="flex h-28 items-end gap-0.5">
        {slots.map((s) => {
          const t = s.tasks ?? 0, e = s.errors ?? 0
          const words = `${label(s.at)}: ${t} task${t === 1 ? "" : "s"}${e ? `, ${e} error${e === 1 ? "" : "s"}` : ""}`
          return (
            <Tooltip key={s.at}>
              <TooltipTrigger asChild>
                <span tabIndex={0} aria-label={words} className="group flex h-full flex-1 flex-col justify-end focus-visible:outline-none">
                  <span
                    style={{ height: `${Math.max(t ? 2 : 0, (t / max) * 100)}%` }}
                    className="flex flex-col justify-end gap-[2px] overflow-hidden rounded-t-[4px] bg-foreground/25 group-hover:bg-foreground/40 group-focus-visible:ring-2 group-focus-visible:ring-ring"
                  >
                    {e > 0 && <span style={{ height: `${(e / t) * 100}%` }} className="min-h-[2px] bg-destructive" />}
                  </span>
                </span>
              </TooltipTrigger>
              <TooltipContent>{words}</TooltipContent>
            </Tooltip>
          )
        })}
      </div>
      <div aria-hidden="true" className="flex justify-between text-[11px] text-muted-foreground">{axis.map((a) => <span key={a}>{a}</span>)}</div>
    </div>
  )
}

const MAX_LINES = 2000

/** EventSource sends no header: trade the page token for a one-minute
 *  ticket the stream URL carries. A signed-in browser uses its cookie. */
async function streamTicket(): Promise<string> {
  if (!window.AX_LOCAL_TOKEN) return ""
  const b = await apiPost<{ ticket?: string }>("/api/admin/stream-ticket", {})
  return b.ticket ? "?st=" + encodeURIComponent(b.ticket) : ""
}

export type TailState = "connecting" | "live" | "retrying" | "paused"

/** The daemon's output, live, while `on`. Lines are kept here (the last
 *  2000); the stream closes when the tab is left or paused. */
export function useLogTail(on: boolean): { lines: { n: number; text: string }[]; state: TailState; clear: () => void } {
  const [lines, setLines] = useState<{ n: number; text: string }[]>([])
  const [state, setState] = useState<TailState>(on ? "connecting" : "paused")
  const seq = useRef(0)
  useEffect(() => {
    if (!on) { setState("paused"); return }
    let es: EventSource | null = null
    let timer = 0
    let dead = false
    const open = () => {
      setState((s) => (s === "retrying" ? s : "connecting"))
      streamTicket().then((st) => {
        if (dead) return
        es = new EventSource("/api/admin/logs/stream" + st, { withCredentials: true })
        es.addEventListener("open", () => setState("live"))
        es.addEventListener("line", (ev) => {
          const text = (ev as MessageEvent<string>).data
          if (!text) return
          setLines((l) => { const next = [...l, { n: ++seq.current, text }]; return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next })
        })
        es.addEventListener("error", () => {
          setState("retrying")
          // A network drop reconnects by itself; an HTTP error (an expired
          // ticket) closes the stream, so open it again with a new one.
          if (es && es.readyState === EventSource.CLOSED) { es = null; timer = window.setTimeout(open, 3000) }
        })
      }, () => { if (!dead) { setState("retrying"); timer = window.setTimeout(open, 5000) } })
    }
    open()
    return () => { dead = true; window.clearTimeout(timer); es?.close() }
  }, [on])
  return { lines, state, clear: () => setLines([]) }
}

const TONE = { err: "text-destructive", warn: "text-warn-ink", dim: "text-muted-foreground", "": "" } as const

export function LogBox({ lines, filter, follow }: { lines: { n: number; text: string }[]; filter: string; follow: boolean }) {
  const box = useRef<HTMLPreElement>(null)
  const f = filter.toLowerCase()
  const shown = f ? lines.filter((l) => l.text.toLowerCase().includes(f)) : lines
  useEffect(() => { if (follow && box.current) box.current.scrollTop = box.current.scrollHeight }, [shown.length, follow])
  return (
    <pre ref={box} aria-live="off" className="max-h-[60vh] min-h-40 overflow-auto whitespace-pre-wrap break-words py-4 font-mono text-[12px] leading-[1.55]">
      {shown.length ? shown.map((l) => <span key={l.n} className={cn("block", TONE[lineTone(l.text)])}>{l.text}</span>)
        : <span className="text-muted-foreground">{lines.length ? "No line matches the filter." : "No lines yet. New lines appear here."}</span>}
    </pre>
  )
}
