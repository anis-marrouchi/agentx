// --- The Task page's run controls and clock (#2306) ---
//
// The Task page's ask box is the Hub chat's (wall-chat-input.client.ts).
// Beside its send arrow sit the controls of the run on the page:
//
//   running  → Pause, then Stop
//   pausing  → "Writing its plan…" (the agent writes its resume plan)
//   paused   → Resume
//
// Pause is the stop signal (#857, #1439; POST /api/admin/wall/live/pause
// { taskId }): the run stops at the next point it can, the agent writes a
// resume plan, then the run ends. It is not a freeze. Resume
// (POST /api/admin/wall/live/resume { id }) takes the id of that paused
// record, and starts a new turn in the same chat from the plan. Stop only
// cancels the turn, with no plan.
//
// The page's clock is cfClock (wall-chat-fold.ts).
//
// Shipped to the browser through injectFns: it stands alone, and its icons
// ride on it as tcCtlHtml.svg.

import { icon } from "../icons"

/** What the controls show. `paused` is the run's paused record, from the
 *  live snapshot (stoppedTasks); `busy` a control at work ("Pausing…"). */
export interface TcState {
  running: boolean
  paused?: { state: string; resumable: boolean } | null
  busy?: string
}

/** Pause, Stop and Resume as the ask box's buttons, for its slot by the
 *  send arrow; "" when none applies. Each carries
 *  data-task-ctl="pause|stop|resume". */
export function tcCtlHtml(s: TcState): string {
  const esc = (x: unknown) => String(x == null ? "" : x).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c])
  const PAUSE = tcCtlHtml.svg.pause
  const STOP = tcCtlHtml.svg.stop
  const PLAY = tcCtlHtml.svg.play
  if (s.busy) return '<span class="hc__busy" role="status">' + esc(s.busy) + "</span>"
  const p = s.paused
  if (p && p.state === "winding-down") {
    return '<span class="hc__busy" role="status" title="The run stopped; the agent writes its resume plan">Writing its plan…</span>'
  }
  if (p && p.state === "stopped" && p.resumable) {
    return '<button type="button" class="hc__resume" data-task-ctl="resume" title="Resume: a new turn goes on from its resume plan, in the same chat">' +
      PLAY + "<span>Resume</span></button>"
  }
  if (!s.running) return ""
  return '<button type="button" class="hc__tool" data-task-ctl="pause" aria-label="Pause" title="Pause: stop at the next point and write a plan to resume from">' + PAUSE + "</button>" +
    '<button type="button" class="hc__stopb" data-task-ctl="stop" aria-label="Stop" title="Stop: end this turn now, with no plan">' + STOP + "</button>"
}
// Lucide (icons.ts). The page gets them with the function: injectFns writes
// this property into the page (inject.ts).
tcCtlHtml.svg = { pause: icon("pause"), stop: icon("square"), play: icon("play") }
