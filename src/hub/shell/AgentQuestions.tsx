// --- An agent's questions on top of its chat (#2505) ---
//
// A Needs you row opens the chat with what the agent asks the owner on top:
// every question of that agent, oldest first (the row's title is the first),
// one open at a time with what is asked, known and what each answer does
// (ShellWaiting.tsx WaitingDetail). The agent's chat thread is about
// something else, so it stays folded behind "Whole chat" until asked for.
//
// The questions are the owner's one list (waiting.ts, the same read as
// Waiting on you), picked by the keys the row carries (hub-agents.ts
// HaRow.asks), so the row, its count and this block name the same items.
import { useQuery } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { apiGet } from "../api"
import { shortAgo } from "../tasks"
import { WAITING_URL, waitingList, type WaitingItem, type WaitingReply } from "../waiting"
import { WaitingDetail } from "../pages/ShellWaiting"
import type { HaAsk } from "./menu"
import { Icon, Skeleton, cn } from "../ui"

/** The agent's questions still waiting, in the row's order (oldest first).
 *  A key the list no longer has (answered, put off, expired) is left out. */
export function agentQuestions(asks: HaAsk[] | undefined, items: WaitingItem[]): WaitingItem[] {
  const byKey = new Map(items.map((i) => [i.key, i]))
  return (asks ?? []).map((a) => byKey.get(a.key)).filter((i): i is WaitingItem => !!i)
}

/** The question to open: the one asked for while it still waits, else the
 *  first still waiting, else none (#2505 C4: never an empty block). */
export function openQuestion(list: WaitingItem[], want: string | null): string | null {
  if (want && list.some((i) => i.key === want)) return want
  return list[0]?.key ?? null
}

/** The agent's questions still waiting: undefined while the list is read
 *  (or when it cannot be), else the items, maybe none. Same read and key as
 *  Waiting on you, so both follow one answer. */
export function useAgentQuestions(asks: HaAsk[] | undefined): WaitingItem[] | undefined {
  const q = useQuery({ queryKey: ["shell-waiting"], queryFn: () => apiGet<WaitingReply>(WAITING_URL), refetchInterval: 15_000, enabled: !!asks?.length })
  if (!asks?.length) return []
  return q.data ? agentQuestions(asks, waitingList(q.data).items) : q.isError ? [] : undefined
}

export interface AgentQuestionsProps {
  agentId: string
  /** useAgentQuestions: undefined while it is read. */
  list: WaitingItem[] | undefined
  /** The thread is shown under the questions. */
  whole: boolean
  onWhole: (v: boolean) => void
  now?: number
}

/** The block, or nothing when the agent asks nothing (or it was all answered). */
export function AgentQuestions({ agentId, list, whole, onWhole, now = Date.now() }: AgentQuestionsProps) {
  const [want, setWant] = useState<string | null>(null)
  useEffect(() => { setWant(null) }, [agentId])
  if (!list) return <Skeleton className="h-24 w-full" />
  const open = openQuestion(list, want)
  if (!list.length) return null
  return (
    <section aria-label="Waiting on you" data-shell="questions" data-agent={agentId} className="flex flex-col gap-2">
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon name="circle-alert" className="size-3.5 text-warn-ink" />
        <span>Waiting on you · {list.length}{list.length > 1 ? ", oldest first" : ""}</span>
        <button
          type="button" aria-pressed={whole} onClick={() => onWhole(!whole)} data-shell="whole-chat"
          className="ml-auto rounded-sm px-1.5 py-0.5 text-xs text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {whole ? "Hide the chat" : "Whole chat"}
        </button>
      </p>
      <ol className="flex flex-col divide-y divide-border rounded-md border border-border">
        {list.map((i, n) => (
          <li key={i.key} data-question={i.key} data-open={i.key === open ? "true" : undefined}>
            {i.key === open ? (
              <div className="p-3"><WaitingDetail item={i} now={now} /></div>
            ) : (
              <button
                type="button" onClick={() => setWant(i.key)}
                className={cn("flex w-full min-w-0 items-center gap-3 px-3 py-2 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring")}
              >
                <span className="w-4 shrink-0 text-xs tabular-nums text-muted-foreground">{n + 1}</span>
                <span className="min-w-0 flex-1 truncate text-[13px]">{i.title}</span>
                {i.askedAt ? <span className="shrink-0 text-xs tabular-nums text-muted-foreground">asked {shortAgo(Date.parse(i.askedAt), now)}</span> : null}
              </button>
            )}
          </li>
        ))}
      </ol>
    </section>
  )
}
