import redesignCss from "./redesign.css"
import { createRoot } from "react-dom/client"
import { App } from "./App"

// --- Bundle entry point ---
//
// The CSS is imported as a string via tsup's `loader: { ".css": "text" }`
// config and injected at boot. Font-face links live in the host page
// shell (src/daemon/ui/pages/workflow-editor.ts) so they're fetched while
// this bundle is still parsing.

function injectStyles(id: string, css: string): void {
  if (document.getElementById(id)) return
  const style = document.createElement("style")
  style.id = id
  style.textContent = css
  document.head.appendChild(style)
}

function boot(): void {
  injectStyles("wfe-redesign-css", redesignCss as unknown as string)
  const container = document.getElementById("wfe-root")
  if (!container) {
    console.error("[wfe] #wfe-root missing — editor cannot mount")
    return
  }
  createRoot(container).render(<App />)
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot)
} else {
  boot()
}
