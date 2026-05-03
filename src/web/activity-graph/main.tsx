import { createRoot } from "react-dom/client"
import { App } from "./App"
import css from "./styles.css"

// Inject the bundled stylesheet into the page on mount. tsup is configured
// (loader: { ".css": "text" }) to import CSS as a string so it ships inside
// this single IIFE and we don't need a second /assets/ request.
function injectStyles() {
  const id = "ax-activity-graph-styles"
  if (document.getElementById(id)) return
  const style = document.createElement("style")
  style.id = id
  style.textContent = css
  document.head.appendChild(style)
}

function mount() {
  injectStyles()
  const root = document.getElementById("ax-fleet-root")
  if (!root) {
    console.error("[activity-graph] mount point #ax-fleet-root missing")
    return
  }
  createRoot(root).render(<App />)
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount)
} else {
  mount()
}
