import { tsWhen } from "../../../daemon/ui/pages/wall-task-session"

// When a part happened (#2306): HH:MM today, the day added on another day,
// the full local date and time on hover. Nothing when the stream did not
// say: no time is made up.
export function When({ at, now }: { at?: number; now: number }) {
  const w = at ? tsWhen(at, now) : null
  if (!w) return <span className="axc-when" aria-hidden="true" />
  return <time className="axc-when" dateTime={w.iso} title={w.full}>{w.short}</time>
}
