import React, { useEffect, useReducer, useRef } from "react"
import { Box, Text, useApp, useInput } from "ink"
import {
  fetchAgents,
  fetchCrons,
  fetchProcesses,
  killProcess,
  sendTask,
  type AgentRow,
  type CronRow,
  type DaemonConn,
  type ProcessRow,
} from "./client.js"
import { streamEvents, type SseFrame } from "./sse.js"

type FocusPane = "agents" | "processes" | "events"
type BottomRight = "crons" | "channels"

interface ComposerState {
  open: boolean
  text: string
  targetAgentId: string | null
  status: "idle" | "sending" | "error"
  error: string | null
}

interface ChannelTally {
  channel: string
  inbound: number
  outbound: number
  lastAt: number
  lastPreview: string
}

interface State {
  agents: AgentRow[]
  processes: ProcessRow[]
  crons: CronRow[]
  events: EventRow[]
  channels: Map<string, ChannelTally>
  connError: string | null
  lastTick: number
  focus: FocusPane
  cursor: { agents: number; processes: number; events: number }
  bottomRight: BottomRight
  composer: ComposerState
  toast: { text: string; color: "green" | "red" | "yellow"; at: number } | null
}

interface EventRow {
  at: number
  kind: string
  line: string
}

type Action =
  | { type: "agents"; data: AgentRow[] }
  | { type: "processes"; data: ProcessRow[] }
  | { type: "crons"; data: CronRow[] }
  | { type: "event"; row: EventRow; channelTally?: ChannelTally }
  | { type: "connError"; error: string | null }
  | { type: "tick" }
  | { type: "focus"; pane: FocusPane }
  | { type: "cursor"; pane: FocusPane; delta: number }
  | { type: "bottomRight"; pane: BottomRight }
  | { type: "composer"; patch: Partial<ComposerState> }
  | { type: "toast"; text: string; color: "green" | "red" | "yellow" }
  | { type: "clearToast" }

function clampCursor(idx: number, len: number): number {
  if (len <= 0) return 0
  if (idx < 0) return 0
  if (idx >= len) return len - 1
  return idx
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "agents": {
      return {
        ...state,
        agents: action.data,
        cursor: { ...state.cursor, agents: clampCursor(state.cursor.agents, action.data.length) },
      }
    }
    case "processes": {
      return {
        ...state,
        processes: action.data,
        cursor: { ...state.cursor, processes: clampCursor(state.cursor.processes, action.data.length) },
      }
    }
    case "crons": return { ...state, crons: action.data }
    case "event": {
      const next = [action.row, ...state.events]
      if (next.length > 200) next.length = 200
      let channels = state.channels
      if (action.channelTally) {
        channels = new Map(state.channels)
        channels.set(action.channelTally.channel, action.channelTally)
      }
      return { ...state, events: next, channels }
    }
    case "connError": return { ...state, connError: action.error }
    case "tick": return { ...state, lastTick: Date.now() }
    case "focus": return { ...state, focus: action.pane }
    case "cursor": {
      const len = action.pane === "agents" ? state.agents.length
        : action.pane === "processes" ? state.processes.length
          : state.events.length
      return {
        ...state,
        cursor: { ...state.cursor, [action.pane]: clampCursor(state.cursor[action.pane] + action.delta, len) },
      }
    }
    case "bottomRight": return { ...state, bottomRight: action.pane }
    case "composer": return { ...state, composer: { ...state.composer, ...action.patch } }
    case "toast": return { ...state, toast: { text: action.text, color: action.color, at: Date.now() } }
    case "clearToast": return { ...state, toast: null }
  }
}

const initialState: State = {
  agents: [],
  processes: [],
  crons: [],
  events: [],
  channels: new Map(),
  connError: null,
  lastTick: 0,
  focus: "agents",
  cursor: { agents: 0, processes: 0, events: 0 },
  bottomRight: "crons",
  composer: { open: false, text: "", targetAgentId: null, status: "idle", error: null },
  toast: null,
}

export function App({ conn, pollMs = 3000 }: { conn: DaemonConn; pollMs?: number }) {
  const [state, dispatch] = useReducer(reducer, initialState)
  const { exit } = useApp()
  const abortRef = useRef<AbortController | null>(null)

  // Auto-clear toasts after a few seconds.
  useEffect(() => {
    if (!state.toast) return
    const id = setTimeout(() => dispatch({ type: "clearToast" }), 3500)
    return () => clearTimeout(id)
  }, [state.toast])

  useInput((input, key) => {
    // Composer captures input while open — everything routes there except Esc / Enter.
    if (state.composer.open) {
      if (key.escape) {
        dispatch({ type: "composer", patch: { open: false, text: "", status: "idle", error: null } })
        return
      }
      if (key.return) {
        const text = state.composer.text.trim()
        const agentId = state.composer.targetAgentId
        if (!text || !agentId) return
        dispatch({ type: "composer", patch: { status: "sending", error: null } })
        void (async () => {
          dispatch({
            type: "event",
            row: { at: Date.now(), kind: "you", line: `→ @${agentId}: ${text}` },
          })
          try {
            const r = await sendTask(conn, agentId, text)
            const reply = r?.content?.toString?.() || r?.error || "(empty reply)"
            dispatch({
              type: "event",
              row: { at: Date.now(), kind: "reply", line: `@${agentId}: ${reply.slice(0, 240)}` },
            })
            dispatch({ type: "composer", patch: { open: false, text: "", status: "idle", error: null } })
            dispatch({ type: "toast", text: "task done", color: "green" })
          } catch (e: any) {
            dispatch({ type: "composer", patch: { status: "error", error: e?.message || String(e) } })
          }
        })()
        return
      }
      if (key.backspace || key.delete) {
        dispatch({ type: "composer", patch: { text: state.composer.text.slice(0, -1) } })
        return
      }
      if (input && !key.ctrl && !key.meta) {
        dispatch({ type: "composer", patch: { text: state.composer.text + input } })
        return
      }
      return
    }

    if (input === "q" || (key.ctrl && input === "c")) {
      abortRef.current?.abort()
      exit()
      return
    }
    if (key.tab) {
      const order: FocusPane[] = ["agents", "processes", "events"]
      const idx = order.indexOf(state.focus)
      dispatch({ type: "focus", pane: order[(idx + 1) % order.length] })
      return
    }
    if (input === "a") { dispatch({ type: "focus", pane: "agents" }); return }
    if (input === "p") { dispatch({ type: "focus", pane: "processes" }); return }
    if (input === "e") { dispatch({ type: "focus", pane: "events" }); return }
    if (input === "c") {
      dispatch({ type: "bottomRight", pane: state.bottomRight === "crons" ? "channels" : "crons" })
      return
    }
    if (key.upArrow) { dispatch({ type: "cursor", pane: state.focus, delta: -1 }); return }
    if (key.downArrow) { dispatch({ type: "cursor", pane: state.focus, delta: 1 }); return }
    if (input === "/" && state.focus === "agents") {
      const target = state.agents[state.cursor.agents]
      if (!target) { dispatch({ type: "toast", text: "no agent selected", color: "yellow" }); return }
      dispatch({ type: "composer", patch: { open: true, text: "", targetAgentId: target.id, status: "idle", error: null } })
      return
    }
    if (input === "k" && state.focus === "processes") {
      const target = state.processes[state.cursor.processes]
      if (!target) { dispatch({ type: "toast", text: "no process selected", color: "yellow" }); return }
      void (async () => {
        try {
          await killProcess(conn, target.key, "tui")
          dispatch({ type: "toast", text: `killed ${target.key.agentId}/${target.key.channel}/${target.key.chatId}`, color: "green" })
        } catch (e: any) {
          dispatch({ type: "toast", text: `kill failed: ${e?.message || e}`, color: "red" })
        }
      })()
      return
    }
  })

  useEffect(() => {
    const ac = new AbortController()
    abortRef.current = ac
    let stopped = false
    const tick = async () => {
      try {
        const [agents, processes, crons] = await Promise.all([
          fetchAgents(conn, ac.signal).catch(() => [] as AgentRow[]),
          fetchProcesses(conn, ac.signal).catch(() => [] as ProcessRow[]),
          fetchCrons(conn, ac.signal).catch(() => [] as CronRow[]),
        ])
        if (stopped) return
        dispatch({ type: "agents", data: agents })
        dispatch({ type: "processes", data: processes })
        dispatch({ type: "crons", data: crons })
        dispatch({ type: "tick" })
        dispatch({ type: "connError", error: null })
      } catch (e: any) {
        if (!stopped) dispatch({ type: "connError", error: e?.message || String(e) })
      }
    }
    tick()
    const id = setInterval(tick, pollMs)
    return () => { stopped = true; clearInterval(id); ac.abort() }
  }, [conn.baseUrl, conn.token, pollMs])

  // SSE event stream — reconnects on disconnect with a small backoff.
  // Channel events also feed the per-channel tally for the Channels pane.
  useEffect(() => {
    let stopped = false
    const ac = new AbortController()
    const tallyByChannel: Map<string, ChannelTally> = new Map()
    ;(async () => {
      let backoffMs = 500
      while (!stopped) {
        try {
          for await (const frame of streamEvents({ baseUrl: conn.baseUrl, token: conn.token, signal: ac.signal })) {
            const row = frameToRow(frame)
            let channelTally: ChannelTally | undefined
            if (frame.event === "channel" && typeof frame.data?.channel === "string") {
              const prev = tallyByChannel.get(frame.data.channel) ?? {
                channel: frame.data.channel, inbound: 0, outbound: 0, lastAt: 0, lastPreview: "",
              }
              const inbound = prev.inbound + (frame.data.direction === "in" ? 1 : 0)
              const outbound = prev.outbound + (frame.data.direction === "out" ? 1 : 0)
              channelTally = {
                channel: frame.data.channel,
                inbound,
                outbound,
                lastAt: row.at,
                lastPreview: (frame.data.textPreview || "").slice(0, 60),
              }
              tallyByChannel.set(frame.data.channel, channelTally)
            }
            dispatch({ type: "event", row, channelTally })
            backoffMs = 500
          }
        } catch (e: any) {
          if (stopped) return
          dispatch({ type: "connError", error: `events: ${e?.message || e}` })
        }
        await new Promise((r) => setTimeout(r, backoffMs))
        backoffMs = Math.min(backoffMs * 2, 10_000)
      }
    })()
    return () => { stopped = true; ac.abort() }
  }, [conn.baseUrl, conn.token])

  return (
    <Box flexDirection="column" width="100%">
      <Header conn={conn} lastTick={state.lastTick} connError={state.connError} />
      <Box flexDirection="row" flexGrow={1}>
        <Pane title="AGENTS" width="50%" focused={state.focus === "agents"}>
          <AgentList rows={state.agents} cursor={state.cursor.agents} focused={state.focus === "agents"} />
        </Pane>
        <Pane title="LIVE EVENTS" width="50%" focused={state.focus === "events"}>
          <EventList rows={state.events} cursor={state.cursor.events} focused={state.focus === "events"} />
        </Pane>
      </Box>
      <Box flexDirection="row" flexGrow={1}>
        <Pane title="PROCESSES" width="50%" focused={state.focus === "processes"}>
          <ProcessList rows={state.processes} cursor={state.cursor.processes} focused={state.focus === "processes"} />
        </Pane>
        <Pane
          title={state.bottomRight === "crons" ? "CRONS / SCHEDULES" : "CHANNELS"}
          width="50%"
          focused={false}
        >
          {state.bottomRight === "crons"
            ? <CronList rows={state.crons} />
            : <ChannelList rows={Array.from(state.channels.values())} />}
        </Pane>
      </Box>
      {state.composer.open
        ? <Composer composer={state.composer} />
        : <Footer focus={state.focus} bottomRight={state.bottomRight} toast={state.toast} />}
    </Box>
  )
}

function Header({ conn, lastTick, connError }: { conn: DaemonConn; lastTick: number; connError: string | null }) {
  const status = connError ? <Text color="red">● {connError}</Text>
    : lastTick === 0 ? <Text color="yellow">● connecting…</Text>
      : <Text color="green">● live</Text>
  return (
    <Box paddingX={1} justifyContent="space-between">
      <Text bold>agentx tui</Text>
      <Text dimColor>{conn.baseUrl}</Text>
      <Box>{status}</Box>
    </Box>
  )
}

function Footer({
  focus, bottomRight, toast,
}: { focus: FocusPane; bottomRight: BottomRight; toast: State["toast"] }) {
  const hints = [
    `[Tab/a/p/e] focus (now: ${focus})`,
    focus === "agents" ? "[/] talk" : null,
    focus === "processes" ? "[k] kill" : null,
    `[c] ${bottomRight === "crons" ? "→channels" : "→crons"}`,
    "[↑/↓] move",
    "[q] quit",
  ].filter(Boolean).join("  ·  ")
  return (
    <Box paddingX={1} borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false} justifyContent="space-between">
      <Text dimColor>{hints}</Text>
      {toast ? <Text color={toast.color}>{toast.text}</Text> : <Text> </Text>}
    </Box>
  )
}

function Composer({ composer }: { composer: ComposerState }) {
  const label = composer.status === "sending" ? "sending…" : composer.status === "error" ? `error: ${composer.error}` : "Enter to send · Esc to cancel"
  return (
    <Box flexDirection="column" paddingX={1} borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false}>
      <Box>
        <Text color="cyan">@{composer.targetAgentId} </Text>
        <Text>› </Text>
        <Text>{composer.text}</Text>
        <Text inverse> </Text>
      </Box>
      <Text dimColor>{label}</Text>
    </Box>
  )
}

function Pane({
  title, width, focused, children,
}: { title: string; width: string; focused: boolean; children: React.ReactNode }) {
  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle={focused ? "double" : "single"}
      borderColor={focused ? "cyan" : undefined}
      paddingX={1}
    >
      <Text bold color={focused ? "cyan" : "white"}>{title}{focused ? " ●" : ""}</Text>
      <Box flexDirection="column" marginTop={1}>{children}</Box>
    </Box>
  )
}

function selectable(focused: boolean, isCursor: boolean): { inverse?: boolean } {
  return focused && isCursor ? { inverse: true } : {}
}

function AgentList({ rows, cursor, focused }: { rows: AgentRow[]; cursor: number; focused: boolean }) {
  if (rows.length === 0) return <Text dimColor>no agents</Text>
  return (
    <Box flexDirection="column">
      {rows.slice(0, 12).map((a, i) => {
        const sel = selectable(focused, i === cursor)
        const dot = a.errors > 0 ? "●" : a.active > 0 ? "●" : "●"
        const dotColor: "red" | "yellow" | "green" = a.errors > 0 ? "red" : a.active > 0 ? "yellow" : "green"
        return (
          <Box key={a.id}>
            <Text {...sel} color={dotColor}>{dot}</Text>
            <Text {...sel}> {pad(a.name, 14)}</Text>
            <Text {...sel}>{pad(a.tier, 6)} </Text>
            <Text {...sel}>{a.active}/{a.total}</Text>
            {a.errors > 0 ? <Text {...sel} color="red"> err={a.errors}</Text> : null}
          </Box>
        )
      })}
    </Box>
  )
}

function ProcessList({ rows, cursor, focused }: { rows: ProcessRow[]; cursor: number; focused: boolean }) {
  if (rows.length === 0) return <Text dimColor>no live processes</Text>
  const now = Date.now()
  return (
    <Box flexDirection="column">
      {rows.slice(0, 12).map((p, i) => {
        const sel = selectable(focused, i === cursor)
        const age = Math.max(0, Math.round((now - (p.lastTurnAt || p.spawnedAt)) / 1000))
        const color = p.state === "dead" ? "red" : p.state === "warm-hot" ? "green" : "yellow"
        return (
          <Box key={`${p.key.agentId}-${p.key.channel}-${p.key.chatId}-${i}`}>
            <Text {...sel} color={color}>{pad(p.state, 10)}</Text>
            <Text {...sel}>{pad(p.key.agentId, 12)}</Text>
            <Text {...sel}>{pad(p.key.channel, 10)}</Text>
            <Text {...sel}>{p.turnCount}t  {age}s</Text>
          </Box>
        )
      })}
    </Box>
  )
}

function CronList({ rows }: { rows: CronRow[] }) {
  if (rows.length === 0) return <Text dimColor>no crons</Text>
  return (
    <Box flexDirection="column">
      {rows.slice(0, 12).map((c) => {
        const status = !c.enabled ? <Text dimColor>off</Text>
          : c.consecutiveErrors > 0 ? <Text color="red">err</Text>
            : <Text color="green">ok</Text>
        const next = c.nextRun ? new Date(c.nextRun).toLocaleTimeString() : "—"
        return (
          <Box key={c.id}>
            <Text>{pad(c.id, 16)}</Text>
            <Text dimColor>{pad(c.schedule, 12)}</Text>
            <Text>{pad(next, 10)}</Text>
            <Box>{status}</Box>
          </Box>
        )
      })}
    </Box>
  )
}

function ChannelList({ rows }: { rows: ChannelTally[] }) {
  if (rows.length === 0) return <Text dimColor>(waiting for channel events…)</Text>
  const sorted = [...rows].sort((a, b) => b.lastAt - a.lastAt)
  return (
    <Box flexDirection="column">
      {sorted.slice(0, 12).map((c) => (
        <Box key={c.channel}>
          <Text>{pad(c.channel, 12)}</Text>
          <Text color="cyan">←{pad(String(c.inbound), 4)}</Text>
          <Text color="magenta">→{pad(String(c.outbound), 4)}</Text>
          <Text dimColor>{c.lastPreview}</Text>
        </Box>
      ))}
    </Box>
  )
}

function EventList({
  rows, cursor, focused,
}: { rows: EventRow[]; cursor: number; focused: boolean }) {
  if (rows.length === 0) return <Text dimColor>(waiting for events…)</Text>
  return (
    <Box flexDirection="column">
      {rows.slice(0, 18).map((e, i) => {
        const sel = selectable(focused, i === cursor)
        return (
          <Box key={`${e.at}-${i}`}>
            <Text {...sel} dimColor>{new Date(e.at).toLocaleTimeString().padEnd(10)}</Text>
            <Text {...sel} color={kindColor(e.kind)}>{pad(e.kind, 8)}</Text>
            <Text {...sel}>{e.line}</Text>
          </Box>
        )
      })}
    </Box>
  )
}

function frameToRow(frame: SseFrame): EventRow {
  const p = frame.data ?? {}
  const at = typeof p.at === "string" || typeof p.at === "number" ? new Date(p.at).getTime() : Date.now()
  let line = ""
  switch (frame.event) {
    case "run":
      line = `${p.phase ?? ""} ${p.workflowId ?? ""} ${(p.runId ?? "").slice(0, 8)} ${p.nodeId ?? ""}`.trim()
      break
    case "task":
      line = `${p.phase ?? ""} ${p.workflowId ?? ""} ${(Array.isArray(p.assignedTo) ? p.assignedTo.join(",") : "")} ${p.title ? `"${p.title}"` : ""}`.trim()
      break
    case "signal":
      line = `${p.name ?? ""} (${p.scope ?? ""}) ${p.workflowId ?? ""}`.trim()
      break
    case "mesh":
      line = `${p.peer ?? ""} ${p.healthy ? "healthy" : "lost"} ${p.delta ?? ""}`.trim()
      break
    case "channel": {
      const dir = p.direction === "in" ? "←" : "→"
      line = `${dir} ${p.channel ?? ""}:${p.chatId ?? ""} ${p.textPreview ?? ""}`.trim()
      break
    }
    case "status":
      line = `node=${p.node ?? ""} agents=${p.agents ?? 0} active=${(p.active ?? []).length}`
      break
    default:
      line = typeof p === "string" ? p : JSON.stringify(p).slice(0, 80)
  }
  return { at: Number.isFinite(at) ? at : Date.now(), kind: frame.event, line }
}

function kindColor(kind: string): string {
  switch (kind) {
    case "run": return "cyan"
    case "task": return "magenta"
    case "signal": return "green"
    case "mesh": return "blue"
    case "channel": return "yellow"
    case "you": return "white"
    case "reply": return "green"
    default: return "white"
  }
}

function pad(s: string, n: number): string {
  const str = (s ?? "").toString()
  if (str.length >= n) return str.slice(0, n - 1) + " "
  return str + " ".repeat(n - str.length)
}
