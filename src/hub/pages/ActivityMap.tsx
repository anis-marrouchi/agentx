// --- The Activity pane's Map (#2457) ---
//
// The live fleet map the old /activity page loads as its own bundle
// (src/web/activity-graph), drawn inside the Hub instead. It is a lazy chunk:
// React Flow and the map's styles load only when Map is first opened. The
// pane owns the time window and tells the map with the same
// `ax:activity-hours` event the old page sends.
import { useEffect, useRef } from "react"
import "@xyflow/react/dist/style.css"
import "../../web/activity-graph/styles.css"
import "../../web/activity-graph/cards.css"
import { App, HOURS_EVENT } from "../../web/activity-graph/App"

export default function ActivityMap({ hours }: { hours: number }) {
  const first = useRef(hours)
  const told = useRef(hours)
  useEffect(() => {
    if (hours === told.current) return
    told.current = hours
    window.dispatchEvent(new CustomEvent(HOURS_EVENT, { detail: hours }))
  }, [hours])
  return (
    <div id="ax-fleet-root" className="h-full">
      <App initialHours={first.current} />
    </div>
  )
}
