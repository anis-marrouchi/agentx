// The live connection's state, shown while it is not open (#2101 R21, C3).
import { useLiveStatus } from "./live-react"

export function ConnectionLine() {
  const { state } = useLiveStatus()
  if (state !== "reconnecting") return null
  return (
    <p role="status" data-testid="connection-line" className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-warn/15 px-4 py-1.5 text-xs text-warn-ink">
      <span className="inline-block size-2 animate-pulse rounded-full bg-warn motion-reduce:animate-none" aria-hidden="true" />
      Connection lost. Reconnecting…
    </p>
  )
}
