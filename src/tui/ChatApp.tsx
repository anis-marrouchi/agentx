import React, { useCallback, useMemo, useRef, useState } from "react"
import { Box, Static, Text, useApp, useInput, useStdout } from "ink"
import { randomUUID } from "crypto"
import { fetchAgents, streamTask, type AgentRow, type DaemonConn } from "./client.js"
import { renderMarkdown } from "./markdown.js"

// --- Claude-Code-style chat REPL (Ink) ---
//
// <Static> holds the committed transcript (rendered once, never repainted);
// the in-flight turn renders in a live region that updates as tokens and
// tool events stream in, followed by the composer. Agent text is shown raw
// while streaming (partial markdown is jumpy) and re-rendered as markdown
// once the turn commits.

interface Seg {
  type: "text" | "tool"
  content?: string        // text segments
  name?: string           // tool segments
  arg?: string            // tool argument preview
  error?: boolean
}

interface Turn {
  id: string
  you: string
  segs: Seg[]
  live: boolean
  elapsedMs?: number
  outTokens?: number
  error?: string
}

export interface ChatAppProps {
  conn: DaemonConn
  agentId: string
  channel: string
  chatId: string
  agents: AgentRow[]
}

const HELP = "/help /agent <id> /agents /clear /who /exit"

export function ChatApp({ conn, agentId: initialAgent, channel, chatId: initialChatId, agents: initialAgents }: ChatAppProps) {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const width = Math.max(40, Math.min((stdout?.columns ?? 80) - 4, 100))

  const [turns, setTurns] = useState<Turn[]>([])
  const [active, setActive] = useState<Turn | null>(null)
  const [agentId, setAgentId] = useState(initialAgent)
  const [agents, setAgents] = useState(initialAgents)
  const [chatId, setChatId] = useState(initialChatId)
  const [input, setInput] = useState("")
  const [notice, setNotice] = useState<string>(`agent @${agentId} · ${HELP}`)

  const history = useRef<string[]>([])
  const histIdx = useRef<number>(-1)
  const busy = active?.live ?? false

  const pushNotice = (m: string) => setNotice(m)

  const runTurn = useCallback(
    (text: string) => {
      const id = randomUUID().slice(0, 8)
      const startedAt = Date.now()
      setActive({ id, you: text, segs: [], live: true })

      // Mutable ref to the current turn so streaming callbacks coalesce
      // without stale-closure races; we mirror it into state to repaint.
      const turn: Turn = { id, you: text, segs: [], live: true }
      const repaint = () => setActive({ ...turn, segs: turn.segs.map((s) => ({ ...s })) })

      void (async () => {
        try {
          const r = await streamTask(conn, agentId, text, {
            channel,
            chatId,
            onText: (t) => {
              const last = turn.segs[turn.segs.length - 1]
              if (last && last.type === "text") last.content = (last.content ?? "") + t
              else turn.segs.push({ type: "text", content: t })
              repaint()
            },
            onTool: (tool) => {
              if (tool.status === "start" && tool.name) {
                turn.segs.push({ type: "tool", name: tool.name, arg: tool.arg })
                repaint()
              } else if (tool.status === "result" && tool.error) {
                turn.segs.push({ type: "tool", name: tool.name ?? "tool", error: true })
                repaint()
              }
            },
          })
          const finished: Turn = {
            ...turn,
            live: false,
            elapsedMs: Date.now() - startedAt,
            outTokens: r.usage?.outputTokens,
            error: r.error,
          }
          setTurns((prev) => [...prev, finished])
          setActive(null)
        } catch (e: any) {
          setTurns((prev) => [...prev, { ...turn, live: false, error: e?.message || String(e), elapsedMs: Date.now() - startedAt }])
          setActive(null)
        }
      })()
    },
    [conn, agentId, channel, chatId],
  )

  const submit = useCallback(
    (raw: string) => {
      const text = raw.trim()
      if (!text) return
      history.current.push(text)
      histIdx.current = -1

      if (text === "/exit" || text === "/quit") { exit(); return }
      if (text === "/help") { pushNotice(HELP); return }
      if (text === "/who") { pushNotice(`@${agentId} · chatId=${chatId} · channel=${channel}`); return }
      if (text === "/clear") {
        const next = `chat-cli:${randomUUID().slice(0, 12)}`
        setChatId(next)
        setTurns([])
        pushNotice(`fresh chatId=${next} (warm process dropped)`)
        return
      }
      if (text === "/agents") {
        void fetchAgents(conn).then((a) => {
          setAgents(a)
          pushNotice(a.map((x) => (x.id === agentId ? `[${x.id}]` : x.id)).join("  "))
        }).catch((e) => pushNotice(`failed to list agents: ${e?.message || e}`))
        return
      }
      if (text.startsWith("/agent ")) {
        const next = text.slice(7).replace(/^@/, "").trim()
        if (!next) { pushNotice("usage: /agent <id>"); return }
        if (!agents.find((a) => a.id === next)) { pushNotice(`unknown agent: @${next}`); return }
        setAgentId(next)
        pushNotice(`now talking to @${next}`)
        return
      }
      if (text.startsWith("/")) { pushNotice(`unknown command · ${HELP}`); return }

      runTurn(text)
    },
    [conn, agentId, agents, channel, chatId, exit, runTurn],
  )

  useInput((ch, key) => {
    if (key.ctrl && ch === "c") { exit(); return }
    if (key.escape) { exit(); return }
    if (key.upArrow) {
      const h = history.current
      if (!h.length) return
      histIdx.current = histIdx.current < 0 ? h.length - 1 : Math.max(0, histIdx.current - 1)
      setInput(h[histIdx.current] ?? "")
      return
    }
    if (key.downArrow) {
      const h = history.current
      if (histIdx.current < 0) return
      histIdx.current = histIdx.current + 1
      if (histIdx.current >= h.length) { histIdx.current = -1; setInput(""); return }
      setInput(h[histIdx.current] ?? "")
      return
    }
    if (key.backspace || key.delete) { setInput((s) => s.slice(0, -1)); return }

    // Submit on Enter, or on a newline embedded in a paste (Ink delivers a
    // pasted "text\r" as one input chunk, not a discrete key.return — so
    // relying on key.return alone drops fast/pasted input). Everything
    // before the first newline is the submission; a chat has no multiline
    // compose, so the rest is discarded.
    const hasNewline = /[\r\n]/.test(ch ?? "")
    if (key.return || hasNewline) {
      const combined = input + (hasNewline ? (ch as string).replace(/[\r\n][\s\S]*$/, "") : "")
      // Trailing backslash → continue on a new line instead of submitting.
      if (combined.endsWith("\\")) { setInput(combined.slice(0, -1) + "\n"); return }
      if (busy) return
      setInput("")
      submit(combined)
      return
    }
    if (ch && !key.ctrl && !key.meta) { setInput((s) => s + ch); histIdx.current = -1 }
  })

  return (
    <Box flexDirection="column">
      <Static items={turns}>
        {(t) => <TurnView key={t.id} turn={t} width={width} />}
      </Static>
      {active && <TurnView turn={active} width={width} />}
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>{notice}</Text>
        <Box flexDirection="column">
          {(input.includes("\n") ? input.split("\n") : [input]).map((ln, i, arr) => (
            <Box key={i}>
              <Text color="cyan">{i === 0 ? (busy ? "  … " : "you › ") : "      "}</Text>
              <Text>{ln}</Text>
              {i === arr.length - 1 ? <Text color="cyan">▏</Text> : null}
            </Box>
          ))}
        </Box>
      </Box>
    </Box>
  )
}

function TurnView({ turn, width }: { turn: Turn; width: number }) {
  const body = useMemo(() => renderSegs(turn, width), [turn, width])
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="cyan">you › <Text color="white">{turn.you}</Text></Text>
      {body}
      {turn.error ? (
        <Text color="red">  ✗ {turn.error}</Text>
      ) : !turn.live && turn.elapsedMs != null ? (
        <Text dimColor>  · {(turn.elapsedMs / 1000).toFixed(1)}s{turn.outTokens != null ? `, ${turn.outTokens} tok` : ""}</Text>
      ) : null}
    </Box>
  )
}

/** Render a turn's segments: tool badges + agent text. Text is raw while the
 *  turn streams, markdown-rendered once committed. */
function renderSegs(turn: Turn, width: number): React.ReactNode {
  const nodes: React.ReactNode[] = []
  turn.segs.forEach((s, i) => {
    if (s.type === "tool") {
      nodes.push(
        <Text key={i} color={s.error ? "red" : "green"}>
          {"  "}● <Text bold={!s.error} dimColor={s.error}>{s.name}{s.arg ? <Text dimColor>({s.arg})</Text> : null}{s.error ? " failed" : ""}</Text>
        </Text>,
      )
    } else if (s.content) {
      const rendered = turn.live ? indent(s.content) : indent(renderMarkdown(s.content, width))
      nodes.push(<Text key={i}>{rendered}</Text>)
    }
  })
  return nodes
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => (l.length ? "  " + l : l))
    .join("\n")
}
