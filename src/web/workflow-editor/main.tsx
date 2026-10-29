import redesignCss from "./redesign.css"
import { createRoot, type Root } from "react-dom/client"
import { App, type EditorProps } from "./App"

// --- Bundle entry point ---
//
// The editor is a Wall page (#1524): the Wall loads this bundle the first
// time #page=editor opens and mounts it with window.AXWorkflowEditor.mount
// (wall-editor.client.ts). The CSS is imported as a string via tsup's
// `loader: { ".css": "text" }` config and injected once; every rule in it
// is scoped to #wfe-root so it cannot restyle the Wall around it.

export interface MountedEditor {
  unmount(): void
}

function injectStyles(id: string, css: string): void {
  if (document.getElementById(id)) return
  const style = document.createElement("style")
  style.id = id
  style.textContent = css
  document.head.appendChild(style)
}

function mount(el: HTMLElement, props: EditorProps): MountedEditor {
  injectStyles("wfe-redesign-css", redesignCss as unknown as string)
  // The scope every editor style is written under (redesign.css). A child
  // of the host, so the host keeps its own id.
  const scope = document.createElement("div")
  scope.id = "wfe-root"
  el.appendChild(scope)
  const root: Root = createRoot(scope)
  root.render(<App {...props} />)
  return { unmount: () => { root.unmount(); scope.remove() } }
}

declare global {
  interface Window { AXWorkflowEditor?: { mount: typeof mount } }
}

window.AXWorkflowEditor = { mount }
// The Wall may have asked before the script arrived.
document.dispatchEvent(new Event("ax:workflow-editor-ready"))
