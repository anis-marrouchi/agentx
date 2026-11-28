// Evidence for ST3b F2/F3: panes rendered with the settings read pending or failed.
import { writeFileSync, readFileSync } from "node:fs"
import { createElement as h } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import MeshPane from "./src/hub/settings/MeshPane"
import MachinePane from "./src/hub/settings/MachinePane"
import { DisclosureContext } from "./src/hub/settings/parts"
import { TooltipProvider } from "./src/hub/ui"
const css = readFileSync("/tmp/ds-latest-when/hub.css", "utf8")
function page(Pane: any, how: "pending" | "error") {
  const c = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } })
  if (how === "error") c.getQueryCache().build(c, { queryKey: ["settings", "state"] }).setState({ status: "error", error: new Error("502 Bad Gateway"), fetchStatus: "idle" } as any)
  const body = renderToStaticMarkup(h(QueryClientProvider, { client: c }, h(TooltipProvider, null, h(DisclosureContext.Provider, { value: { isOpen: () => false, setOpen: () => {} } }, h(Pane)))))
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div class="ax-hub" style="font-family:Inter,system-ui,sans-serif;max-width:760px;margin:0 auto;padding:24px">${body}</div></body></html>`
}
writeFileSync("/tmp/ds-st3b-fix/mesh-error.html", page(MeshPane, "error"))
writeFileSync("/tmp/ds-st3b-fix/machine-pending.html", page(MachinePane, "pending"))
writeFileSync("/tmp/ds-st3b-fix/machine-error.html", page(MachinePane, "error"))
