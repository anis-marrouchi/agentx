// --- An idle agent's latest conversation, read only (#2101 R26) ---
//
// What a click on an agent that is not working opens: the chat it spoke in
// last, on any channel (Telegram, agent to agent, …), its last turns, read
// only, with one action: New Hub chat. latest.ts says what to read and what
// to show; the Hub chat (ShellChat) draws the turns, so both look the same.
import { useQuery } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { apiGet } from "../api"
import { AfSkeletonRows, Button, EmptyState, Icon } from "../ui"
import { latestUrl, latestView, nodeName, sessionUrl, turnMessages, type LatestReply, type LatestTurn } from "./latest"

export type TurnMessage = ReturnType<typeof turnMessages>[number]

export interface LatestConversationProps {
  agent: { id: string; name: string }
  nodeUrl: string
  /** The machine's name, for "not checked". */
  node?: string
  phoneBar?: ReactNode
  /** Draws one turn, as the Hub chat does. */
  turn: (m: TurnMessage, last: boolean) => ReactNode
  /** No conversation, or the latest is a Hub chat: the Hub chat instead. */
  hub: ReactNode
  /** New Hub chat. */
  onNewChat: () => void
}

export function LatestConversation({ agent, nodeUrl, node, phoneBar, turn, hub, onNewChat }: LatestConversationProps) {
  const latest = useQuery({
    queryKey: ["agent-latest", nodeUrl, agent.id],
    queryFn: () => apiGet<LatestReply>(latestUrl(nodeUrl, agent.id)),
    retry: false,
  })
  const view = latestView({ data: latest.data, failed: latest.isError }, nodeName(nodeUrl, node))
  const taskId = view.kind === "read" ? view.taskId : ""
  const session = useQuery({
    queryKey: ["agent-latest-turns", nodeUrl, agent.id, taskId],
    queryFn: () => apiGet<{ turns?: LatestTurn[] }>(sessionUrl(nodeUrl, agent.id, taskId)),
    enabled: !!taskId,
    retry: false,
  })
  if (view.kind === "hub") return <>{hub}</>
  const messages = turnMessages(session.data?.turns ?? [])
  const lastSeq = messages[messages.length - 1]?.seq
  return (
    <section aria-label="Latest conversation" data-shell="latest" className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        {phoneBar}
        <h1 className="truncate text-sm font-medium">{agent.name}</h1>
        {view.kind === "read" ? <span className="truncate text-xs text-muted-foreground" data-shell="latest-channel">{view.channel} · read only</span> : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[760px] flex-col gap-4 px-4 py-6" aria-live="polite" data-shell="messages">
          {view.kind === "loading" || (view.kind === "read" && session.isLoading) ? (
            <AfSkeletonRows />
          ) : view.kind === "unchecked" ? (
            <EmptyState title="Latest conversation not checked">{view.node} did not answer. Start a Hub chat, or try again later.</EmptyState>
          ) : session.isError ? (
            <EmptyState title="Latest conversation not checked">{nodeName(nodeUrl, node)} did not send its turns. Start a Hub chat, or try again later.</EmptyState>
          ) : (
            messages.map((m) => <div key={m.seq}>{turn(m, m.seq === lastSeq && m.role === "assistant")}</div>)
          )}
        </div>
      </div>
      <footer className="mx-auto flex w-full max-w-[760px] shrink-0 items-center gap-3 px-4 pb-4">
        <p className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground">
          <Icon name="eye" className="size-3.5 shrink-0" />
          <span className="truncate">{view.kind === "read" ? "Read only. It happened in " + view.channel + "." : "Read only."}</span>
        </p>
        <Button size="sm" onClick={onNewChat} data-shell="new-hub-chat">
          <Icon name="message-square" /> New Hub chat
        </Button>
      </footer>
    </section>
  )
}
