// --- The React Hub's entry (#2218) ---
//
// Loaded by /hub only when the React switch is on (dashboard.hub.react, or
// ?react=1). It mounts into #ax-hub-root inside the old Hub's main area
// (stage 1 of the move: the old shell stays, React draws the pages listed
// in src/hub/pages.ts). The old script hides its own sections for those
// pages (`.ax-wall.is-hub`, wall.client.ts).
import "./styles.css"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import { readBoot } from "./boot"
import "./extensions/core"
import { LiveProvider } from "./live-react"
import { LiveStream } from "./live"

const el = document.getElementById("ax-hub-root")
if (el) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: false, retry: 1 } } })
  const live = new LiveStream({ client })
  createRoot(el).render(
    <QueryClientProvider client={client}>
      <LiveProvider stream={live}>
        <App boot={readBoot()} />
      </LiveProvider>
    </QueryClientProvider>,
  )
}
