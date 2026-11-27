// --- An agent's questions on top of its chat (#2505) ---
//
// A Needs you row opens the chat with what the agent asks the owner on top:
// every question of that agent, oldest first (the row's title is the first),
// one open at a time with what is asked, known and what each answer does
// (ShellWaiting.tsx WaitingDetail). The agent's chat thread is about
// something else, so it stays folded behind "Whole chat" until asked for.
//
// Yes and No answer in place, with a confirm line, through the same call
// as the feed's cards (/api/admin/wall/decide): the question leaves the
// list, the next opens, and the row's count goes down at once. Later folds
// it and opens the next; it stays listed.
//
// The questions are the owner's one list (waiting.ts, the same read as
// Waiting on you), picked by the keys the row carries (hub-agents.ts
// HaRow.asks), so the row, its count and this block name the same items.
import { useMutation, useQuery } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { apiGet, apiPost } from "../api"
import { shortAgo } from "../tasks"
import { WAITING_URL, waitingList, waitingTaskId, type WaitingItem, type WaitingReply } from "../waiting"
import { WaitingDetail } from "../pages/ShellWaiting"
import { taskHref } from "../pages/ShellTasks"
import type { HaAsk, HaModel } from "./menu"
import { Button, Icon, Skeleton, buttonVariants, cn } from "../ui"

/** The agent's questions still waiting, in the row's order (oldest first).
 *  A key the list no longer has (answered, put off, expired) is left out. */
export function agentQuestions(asks: HaAsk[] | undefined, items: WaitingItem[]): WaitingItem[] {
  const byKey = new Map(items.map((i) => [i.key, i]))
  return (asks ?? []).map((a) => byKey.get(a.key)).filter((i): i is WaitingItem => !!i)
}

/** The question to open: the one asked for while it still waits, else the
 *  first still waiting, else none (#2505 C4: never an empty block). `false`:
 *  the owner folded them all with Later. */
export function openQuestion(list: WaitingItem[], want: string | null | false): string | null {
  if (want === false) return null
  if (want && list.some((i) => i.key === want)) return want
  return list[0]?.key ?? null
}

/** Later: fold this one, keep it listed, and open the next (#2505 C1). */
export function laterQuestion(list: WaitingItem[], key: string): string | false {
  const n = list.findIndex((i) => i.key === key)
  return n >= 0 && n + 1 < list.length ? list[n + 1].key : false
}

/** The answer sent for a question (approvals-panel.ts: yes | no, with the
 *  1-based choice when the card offers choices). */
export function answerBody(key: string, action: "yes" | "no", choice: number | null): { key: string; action: "yes" | "no"; choice?: number } {
  return { key, action, ...(action === "yes" && choice !== null ? { choice: choice + 1 } : {}) }
}

/** The agent's questions still waiting: undefined while the list is read
 *  (or when it cannot be), else the items, maybe none. Same read and key as
 *  Waiting on you, so both follow one answer. `gone`: answered here, left
 *  out before the next read confirms it. */
export function useAgentQuestions(asks: HaAsk[] | undefined, gone: ReadonlySet<string>): WaitingItem[] | undefined {
  const q = useQuery({ queryKey: ["shell-waiting"], queryFn: () => apiGet<WaitingReply>(WAITING_URL), refetchInterval: 15_000, enabled: !!asks?.length })
  if (!asks?.length) return []
  return q.data ? agentQuestions(asks, waitingList(q.data).items).filter((i) => !gone.has(i.key)) : q.isError ? [] : undefined
}

/** The row in the side menu, at once: one question less, and out of Needs
 *  you at 0 (the next read of the rows confirms it). */
export function rowsWithout(m: HaModel | undefined, agentId: string, key: string): HaModel | undefined {
  if (!m) return m
  let left = -1
  const rows = m.rows.map((r) => {
    if (r.id !== agentId || !r.asks?.some((a) => a.key === key)) return r
    const asks = r.asks.filter((a) => a.key !== key)
    left = asks.length
    return { ...r, asks, unread: asks.length, line: asks[0]?.title ?? r.line, state: asks.length ? r.state : ("idle" as const) }
  })
  if (left < 0) return m
  return { ...m, rows, counts: { ...m.counts, needs: m.counts.needs - (left ? 0 : 1), idle: m.counts.idle + (left ? 0 : 1) } }
}

export interface AgentQuestionsProps {
  agentId: string
  /** useAgentQuestions: undefined while it is read. */
  list: WaitingItem[] | undefined
  /** The thread is shown under the questions. */
  whole: boolean
  onWhole: (v: boolean) => void
  /** The owner answered one: it leaves the list (#2505 C1). */
  onAnswered?: (key: string) => void
  now?: number
}

/** Yes, No and Later under the open question, with the line that says what
 *  is sent before it is. A request waits on a reply, not a yes or no: it
 *  opens its task, where the reply is written. */
function QuestionAnswer({ item, onAnswered, onLater }: { item: WaitingItem; onAnswered?: (key: string) => void; onLater: () => void }) {
  const [confirm, setConfirm] = useState<"yes" | "no" | null>(null)
  const [choice, setChoice] = useState<number | null>(null)
  const [error, setError] = useState("")
  const send = useMutation({
    mutationFn: (action: "yes" | "no") => apiPost("/api/admin/wall/decide", answerBody(item.key, action, choice)),
    onSuccess: () => { setConfirm(null); onAnswered?.(item.key) },
    onError: (e: unknown) => setError("Not answered: " + (e instanceof Error ? e.message : "the computer did not answer")),
  })
  const task = waitingTaskId(item)
  const choices = item.choices ?? []
  const pick = (a: "yes" | "no") => {
    setError("")
    if (a === "yes" && choices.length && choice === null) { setError("Pick one of the choices first."); return }
    setConfirm(a)
  }
  const later = <Button variant="ghost" size="sm" onClick={onLater} data-question-act="later">Later</Button>
  if (task) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <a href={taskHref(task)} className={buttonVariants({ size: "sm" })} data-question-act="task">Open the task to reply</a>
        {later}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2" data-question-answer={item.key}>
      {choices.length ? (
        <fieldset className="flex flex-col gap-1 text-sm">
          <legend className="sr-only">Choices</legend>
          {choices.map((c, n) => (
            <label key={n} className={cn("flex cursor-pointer items-start gap-2 rounded-md border px-3 py-1.5", choice === n ? "border-ring bg-muted" : "border-border")}>
              <input type="radio" name={"q-" + item.key} className="mt-1" checked={choice === n} onChange={() => { setChoice(n); setError("") }} />
              <span>{c}</span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" aria-pressed={confirm === "yes"} disabled={send.isPending} onClick={() => pick("yes")} data-question-act="yes">{choices.length ? "Answer" : "Yes"}</Button>
        {choices.length ? null : <Button variant="outline" size="sm" aria-pressed={confirm === "no"} disabled={send.isPending} onClick={() => pick("no")} data-question-act="no">No</Button>}
        {later}
      </div>
      {confirm ? (
        <div role="group" aria-label="Confirm your answer" className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border pt-2 text-[13px]">
          <p className="min-w-0 flex-1">
            <b className="font-medium">Send{item.agent ? " @" + item.agent : ""}: {confirm === "no" ? "No" : choices.length && choice !== null ? choices[choice] : "Yes"}.</b>{" "}
            <span className="text-muted-foreground">It is recorded as your answer and cannot be taken back.</span>
          </p>
          <span className="inline-flex gap-2">
            <Button variant="ghost" size="sm" disabled={send.isPending} onClick={() => setConfirm(null)}>Back</Button>
            <Button size="sm" disabled={send.isPending} onClick={() => send.mutate(confirm)} data-question-act="confirm">{send.isPending ? "Sending…" : "Confirm"}</Button>
          </span>
        </div>
      ) : null}
      {error ? <p role="alert" className="text-xs text-err-ink">{error}</p> : null}
    </div>
  )
}

/** The block, or nothing when the agent asks nothing (or it was all answered). */
export function AgentQuestions({ agentId, list, whole, onWhole, onAnswered, now = Date.now() }: AgentQuestionsProps) {
  const [want, setWant] = useState<string | null | false>(null)
  useEffect(() => { setWant(null) }, [agentId])
  if (!list) return <Skeleton className="h-24 w-full" />
  const open = openQuestion(list, want)
  if (!list.length) return null
  return (
    <section aria-label="Waiting on you" data-shell="questions" data-question-agent={agentId} className="flex flex-col gap-2">
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon name="circle-alert" className="size-3.5 text-warn-ink" />
        <span data-shell="questions-count">{list.length} for you{list.length > 1 ? ", oldest first" : ""}</span>
        <button
          type="button" aria-pressed={whole} onClick={() => onWhole(!whole)} data-shell="whole-chat"
          className="ml-auto rounded-sm px-1.5 py-0.5 text-xs text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {whole ? "Hide the chat" : "Whole chat"}
        </button>
      </p>
      <ol className="flex flex-col divide-y divide-border rounded-md border border-border">
        {list.map((i, n) => (
          <li key={i.key} data-question={i.key} data-question-open={i.key === open ? "true" : undefined}>
            {i.key === open ? (
              <div className="p-3">
                <WaitingDetail item={i} now={now} actions={<QuestionAnswer item={i} onAnswered={onAnswered} onLater={() => setWant(laterQuestion(list, i.key))} />} />
              </div>
            ) : (
              <button
                type="button" onClick={() => setWant(i.key)}
                className="flex w-full min-w-0 items-center gap-3 px-3 py-2 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
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
