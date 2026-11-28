// --- Go through them: Waiting on you, one at a time (#2499 part 2) ---
//
// Anis 11-28: "provide the answers one by one, like a wizard, and it
// slides, takes me to the next. Once I'm done, everything gets sent to
// whomever agent shall be taking care of."
//
// One step at a time, most urgent first (waiting.ts wizardSteps), with
// "N left". Each answer goes to the agent that raised it the moment it is
// given, through the same call as the feed's cards (DECIDE_URL); the end
// says what went to whom. The "Not finished" requests are one step:
// restart all, close all, or one by one. The opened item in Waiting on you
// answers with the same bar (AnswerBar).
import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import { apiPost } from "../api"
import {
  DECIDE_URL, answerWords, decideBody, oneByOne, sendsOutside, sentSummary, stepGone, waitingTaskId, wizardSteps,
  type SentAnswer, type WaitingItem, type WizardAction, type WizardStep,
} from "../waiting"
import { WaitingDetail } from "./ShellWaiting"
import { taskHref } from "./ShellTasks"
import { Button, Icon, buttonVariants, cn } from "../ui"

const errText = (e: unknown) => (e instanceof Error ? e.message : "the computer did not answer")

/** Send one answer; the answer in words, with the error when it was not sent. */
async function send(item: WaitingItem, action: WizardAction, choice: number | null): Promise<SentAnswer> {
  const words = answerWords(item, action, choice)
  const base = { key: item.key, title: item.title, agent: item.agent, words }
  try {
    await apiPost(DECIDE_URL, decideBody(item.key, action, choice, item.textHash))
    return base
  } catch (e) {
    return { ...base, error: errText(e) }
  }
}

export interface AnswerBarProps {
  item: WaitingItem
  /** Sent (or failed): the answer, in words. */
  onSent: (a: SentAnswer) => void
  /** Wizard only: move on without answering; with the last answer that
   *  could not be sent, so the summary lists it under "Not sent". */
  onSkip?: (failed: SentAnswer | null) => void
}

/** Yes, No (or the choices), Later, under one item. A yes that sends or
 *  publishes outside asks once more; everything else is sent on the tap. */
export function AnswerBar({ item, onSent, onSkip }: AnswerBarProps) {
  const [choice, setChoice] = useState<number | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [failed, setFailed] = useState<SentAnswer | null>(null)
  const qc = useQueryClient()
  const choices = item.choices ?? []
  const request = item.kind === "request"
  const task = waitingTaskId(item)
  const go = async (action: WizardAction) => {
    setError("")
    if (action === "yes" && choices.length && choice === null) { setError("Pick one of the choices first."); return }
    if (action === "yes" && sendsOutside(item.kind) && !confirm) { setConfirm(true); return }
    setBusy(true)
    const a = await send(item, action, choice)
    setBusy(false)
    if (a.error) { setFailed(a); setError("Not sent: " + a.error); return }
    setFailed(null)
    void qc.invalidateQueries({ queryKey: ["shell-waiting"] })
    onSent(a)
  }
  return (
    <div className="flex flex-col gap-2" data-slot="answer-bar" data-answer={item.key}>
      {choices.length ? (
        <fieldset className="flex flex-col gap-1 text-sm" disabled={busy}>
          <legend className="sr-only">Choices</legend>
          {choices.map((c, n) => (
            <label key={n} className={cn("flex min-h-10 cursor-pointer items-start gap-2 rounded-md border px-3 py-2", choice === n ? "border-ring bg-muted" : "border-border")}>
              <input type="radio" name={"a-" + item.key} className="mt-1" checked={choice === n} onChange={() => { setChoice(n); setError("") }} />
              <span>{c}</span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={busy} onClick={() => void go("yes")} data-answer-act="yes">
          {request ? "Pick it up again" : choices.length ? "Send this choice" : "Yes"}
        </Button>
        {choices.length ? null : (
          <Button variant="outline" disabled={busy} onClick={() => void go("no")} data-answer-act="no">{request ? "Close it" : "No"}</Button>
        )}
        <Button variant="ghost" disabled={busy} onClick={() => void go("later")} data-answer-act="later">Later</Button>
        {onSkip ? <Button variant="ghost" disabled={busy} onClick={() => onSkip(failed)} data-answer-act="skip">Skip</Button> : null}
        {task ? <a href={taskHref(task)} className={cn(buttonVariants({ variant: "link" }), "px-1")} data-answer-act="task">Open the task</a> : null}
        {busy ? <span role="status" className="text-xs text-muted-foreground">Sending…</span> : null}
      </div>
      {confirm ? (
        <div role="group" aria-label="Confirm your answer" className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border pt-2 text-[13px]">
          <p className="min-w-0 flex-1"><b className="font-medium">This sends outside{item.yes ? ": " + item.yes : ""}.</b></p>
          <span className="inline-flex gap-2">
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirm(false)}>Back</Button>
            <Button size="sm" disabled={busy} onClick={() => void go("yes")} data-answer-act="confirm">Send</Button>
          </span>
        </div>
      ) : null}
      {error ? <p role="alert" className="text-xs text-err-ink">{error}</p> : null}
    </div>
  )
}

/** The requests step: what they are, then all at once or one by one. */
function RequestsStep({ items, live, onDone, onOneByOne, onSkip }: {
  items: WaitingItem[]; live: ReadonlySet<string> | null
  onDone: (a: SentAnswer[]) => void; onOneByOne: () => void; onSkip: () => void
}) {
  const [all, setAll] = useState(false)
  const [closing, setClosing] = useState(false)
  const [done, setDone] = useState<number | null>(null)
  const qc = useQueryClient()
  const left = live ? items.filter((i) => live.has(i.key)) : items
  const shown = all ? left : left.slice(0, 3)
  const run = async (action: "yes" | "no") => {
    const out: SentAnswer[] = []
    setDone(0)
    for (const i of left) { out.push(await send(i, action, null)); setDone(out.length) }
    void qc.invalidateQueries({ queryKey: ["shell-waiting"] })
    onDone(out)
  }
  const busy = done !== null
  return (
    <article data-wizard="requests" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <p className="text-xs text-muted-foreground">Requests</p>
        <h2 className="text-base font-medium">{left.length} requests are not finished</h2>
        <p className="text-sm">Ask each agent to pick its request up again, close them all, or go through them one by one.</p>
      </div>
      <ul className="divide-y divide-border rounded-md border border-border text-[13px]">
        {shown.map((i) => (
          <li key={i.key} className="flex items-center gap-3 px-3 py-2">
            <span className="min-w-0 flex-1 truncate">{i.title}</span>
            {i.agent ? <span className="max-w-[120px] shrink-0 truncate text-xs text-muted-foreground">@{i.agent}</span> : null}
          </li>
        ))}
        {left.length > 3 ? (
          <li>
            <button type="button" onClick={() => setAll(!all)} className="w-full px-3 py-2 text-left text-xs text-muted-foreground can-hover:hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
              {all ? "Show fewer" : `Show all (${left.length})`}
            </button>
          </li>
        ) : null}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={busy} onClick={() => void run("yes")} data-wizard-act="restart-all">Restart all</Button>
        <Button variant="outline" disabled={busy} onClick={() => setClosing(true)} data-wizard-act="close-all">Close all</Button>
        <Button variant="ghost" disabled={busy} onClick={onOneByOne} data-wizard-act="one-by-one">One by one</Button>
        <Button variant="ghost" disabled={busy} onClick={onSkip} data-wizard-act="skip">Skip</Button>
        {busy ? <span role="status" className="text-xs tabular-nums text-muted-foreground">Sending {done} of {left.length}…</span> : null}
      </div>
      {closing && !busy ? (
        <div role="group" aria-label="Confirm closing them all" className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border pt-2 text-[13px]">
          <p className="min-w-0 flex-1"><b className="font-medium">Close all {left.length}.</b> <span className="text-muted-foreground">Each agent is told its request was dropped.</span></p>
          <span className="inline-flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setClosing(false)}>Back</Button>
            <Button size="sm" onClick={() => void run("no")} data-wizard-act="confirm-close">Close all</Button>
          </span>
        </div>
      ) : null}
    </article>
  )
}

/** One agent's answers: the first 3, then Show all (orca-design C22). */
function SummaryGroup({ agent, answers }: { agent: string; answers: SentAnswer[] }) {
  const [all, setAll] = useState(false)
  const shown = all ? answers : answers.slice(0, 3)
  return (
    <section className="flex flex-col gap-1.5" data-summary-agent={agent}>
      <h3 className="text-xs text-muted-foreground">{agent ? "@" + agent : "No agent named"} · {answers.length}</h3>
      <ul className="divide-y divide-border rounded-md border border-border text-[13px]">
        {shown.map((a) => (
          <li key={a.key} className="flex items-center gap-3 px-3 py-2">
            <span className="shrink-0 font-medium">{a.words}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{a.title}</span>
          </li>
        ))}
        {answers.length > 3 ? (
          <li>
            <button type="button" onClick={() => setAll(!all)} className="w-full px-3 py-2 text-left text-xs text-muted-foreground can-hover:hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
              {all ? "Show fewer" : `Show all (${answers.length})`}
            </button>
          </li>
        ) : null}
      </ul>
    </section>
  )
}

/** The end: what went to whom, and what could not be sent. */
export function WizardSummary({ sent, onClose }: { sent: SentAnswer[]; onClose: () => void }) {
  const { byAgent, failed } = sentSummary(sent)
  const count = sent.length - failed.length
  return (
    <article data-wizard="summary" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <h2 className="flex items-center gap-2 text-base font-medium"><Icon name="circle-check" className="size-4 text-muted-foreground" />{count ? `${count} ${count === 1 ? "answer" : "answers"} sent` : "Nothing sent"}</h2>
        <p className="text-sm text-muted-foreground">{count ? "Each agent was told as you answered." : "You skipped them all. They still wait on you."}</p>
      </div>
      {byAgent.map((g) => <SummaryGroup key={g.agent} agent={g.agent} answers={g.answers} />)}
      {failed.length ? (
        <section className="flex flex-col gap-1.5" data-summary="failed">
          <h3 className="text-xs text-err-ink">Not sent · {failed.length}</h3>
          <ul className="divide-y divide-border rounded-md border border-border text-[13px]">
            {failed.map((a) => (
              <li key={a.key} className="flex flex-col gap-0.5 px-3 py-2">
                <span className="truncate">{a.words}: {a.title}</span>
                <span className="text-xs text-err-ink">{a.error}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">They are still on your list.</p>
        </section>
      ) : null}
      <div><Button onClick={onClose} data-wizard-act="close">Back to the list</Button></div>
    </article>
  )
}

export interface NeedsWizardProps {
  /** The list when the wizard opened: its order holds while you answer. */
  items: WaitingItem[]
  /** The keys still waiting now (the 15 s read), null while unknown: a step
   *  answered somewhere else is passed over. */
  live: ReadonlySet<string> | null
  onClose: () => void
  now?: number
}

/** The wizard: one step at a time, "N left", then the summary. Esc closes. */
export function NeedsWizard({ items, live, onClose, now = Date.now() }: NeedsWizardProps) {
  const [steps, setSteps] = useState<WizardStep[]>(() => wizardSteps(items))
  const [at, setAt] = useState(0)
  const [sent, setSent] = useState<SentAnswer[]>([])
  const top = useRef<HTMLDivElement>(null)
  const step = steps[at]
  const next = (a: SentAnswer[] = []) => { setSent((s) => [...s, ...a]); setAt((n) => n + 1) }
  // Answered somewhere else since the wizard opened: pass it over.
  const gone = stepGone(step, live)
  useEffect(() => { if (gone) setAt((n) => n + 1) }, [gone])
  useEffect(() => { top.current?.focus() }, [at])
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    window.addEventListener("keydown", on)
    return () => window.removeEventListener("keydown", on)
  }, [onClose])
  const left = steps.length - at
  return (
    <div data-shell="wizard" className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden>
          <div className="h-full bg-foreground/70 transition-[width] duration-200 ease-out reduce-effects:transition-none" style={{ width: `${Math.min(100, (at / Math.max(1, steps.length)) * 100)}%` }} />
        </div>
        <span data-wizard="left" className="shrink-0 text-xs tabular-nums text-muted-foreground">{step ? `${left} left` : "Done"}</span>
      </div>
      <div ref={top} tabIndex={-1} key={at} className="animate-ax-slide-in outline-none reduce-effects:animate-none">
        {!step ? <WizardSummary sent={sent} onClose={onClose} />
          : gone ? null
          : step.kind === "requests" ? (
            <RequestsStep
              items={step.items} live={live} onDone={next} onSkip={() => next()}
              onOneByOne={() => setSteps((s) => oneByOne(s, at))}
            />
          ) : (
            <WaitingDetail item={step.item} now={now} actions={<AnswerBar key={step.item.key} item={step.item} onSent={(a) => next([a])} onSkip={(f) => next(f ? [f] : [])} />} />
          )}
      </div>
    </div>
  )
}

