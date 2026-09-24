import { createRoot } from "react-dom/client"
import { App } from "./App"
import css from "./styles.css"
import flowCss from "@xyflow/react/dist/style.css"

// Inject the bundled stylesheet into the page on mount. tsup is configured
// (loader: { ".css": "text" }) to import CSS as a string so it ships inside
// this single IIFE and we don't need a second /assets/ request.
function injectStyles() {
  const id = "ax-activity-graph-styles"
  if (document.getElementById(id)) return
  const style = document.createElement("style")
  style.id = id
  style.textContent = flowCss + "\n" + css
  document.head.appendChild(style)
}

// /activity loads this bundle on demand the first time its Map view opens,
// so the page may already be past DOMContentLoaded when it runs.
function mount() {
  injectStyles()
  const root = document.getElementById("ax-fleet-root")
  if (!root) {
    console.error("[fleet-map] mount point #ax-fleet-root missing")
    return
  }
  createRoot(root).render(<App initialHours={Number(root.dataset.hours) || 24} />)
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount)
} else {
  mount()
}
