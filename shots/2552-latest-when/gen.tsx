// The latest-conversation view rendered from a source tree, with the live Hub
// stylesheet: evidence for #2552 C1 (no daemon; turns drawn as plain bubbles).
import { writeFileSync, readFileSync } from "node:fs"
import { createElement as h } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
const [src, out] = process.argv.slice(2)
;(async () => {
const { LatestConversation } = await import(src + "/src/hub/shell/LatestConversation.tsx")
const { TooltipProvider } = await import(src + "/src/hub/ui/index.ts")
const NODE = "http://127.0.0.1:18800"
const c = new QueryClient()
const now = Date.now()
const iso = (minAgo: number) => new Date(now - minAgo * 60000).toISOString()
c.setQueryData(["agent-latest", NODE, "pm-agent"], { found: true, channel: "a2a", chatId: "a2a:dev-session:pm-agent:dlg-mx06lhn8", runs: [{ taskId: "t2" }] })
c.setQueryData(["agent-latest-turns", NODE, "pm-agent", "t2"], { turns: [
  { id: "t1", message: "Ready time for the first-paint fix?", responseText: "Ready by 18:19Z today, set by the queue.", ok: true, startedAt: iso(26 * 60), sender: "dev-session" },
  { id: "t2", message: "PR #2565 is Ready, all checks green.", responseText: "Thank you, I review it within 30 minutes.", ok: true, startedAt: iso(12), sender: "dev-session" },
] })
const bubble = (m: any) => h("div", { className: m.role === "user" ? "ml-auto w-fit max-w-[80%] rounded-xl bg-muted px-3 py-2 text-sm" : "text-sm" }, m.content)
const body = renderToStaticMarkup(h(QueryClientProvider, { client: c }, h(TooltipProvider, null,
  h(LatestConversation, { agent: { id: "pm-agent", name: "Hakim" }, nodeUrl: NODE, node: "Mac", hub: null, onNewChat: () => {}, turn: bubble }))))
writeFileSync(out, `<!doctype html><html><head><meta charset="utf-8"><style>${readFileSync("/tmp/ds-latest-when/hub.css", "utf8")}</style></head><body class="bg-background text-foreground"><div style="height:100vh">${body}</div></body></html>`)
})()
