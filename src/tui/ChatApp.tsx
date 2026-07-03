import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Box, Text, useApp, useInput, useStdout } from "ink"
import { randomUUID } from "crypto"
import { fetchAgents, streamTask, type AgentRow, type DaemonConn } from "./client.js"
import { renderMarkdown } from "./markdown.js"
import { advanceMention, mentionSuggestions, type MentionCycle } from "./mention-complete.js"
import { classifyComposerInput } from "./composer-input.js"
import { WorkingStatus } from "./working-status.js"
import { theme, BRAND, GUTTER } from "./theme.js"

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
  agentId: string
  segs: Seg[]
  live: boolean
  /** Accumulated reasoning text (forwarded `thinking` frames). Empty for
   *  claude-code agents — the headless CLI redacts thinking text. */
  thinking?: string
  startedAt: number
  elapsedMs?: number
  outTokens?: number
  error?: string
  interrupted?: boolean
}

export interface ChatAppProps {
  conn: DaemonConn
  agentId: string
  channel: string
  chatId: string
  agents: AgentRow[]
}

const HELP = "/help /agent <id> /agents /clear /who /exit"

const COMMANDS: Array<{ cmd: string; desc: string }> = [
  { cmd: "/agent", desc: "switch the target agent (/agent <id>)" },
  { cmd: "/agents", desc: "list registered agents" },
  { cmd: "/clear", desc: "start a fresh session" },
  { cmd: "/who", desc: "show agent + chat id" },
  { cmd: "/help", desc: "list commands" },
  { cmd: "/exit", desc: "quit the chat" },
]

export function ChatApp({ conn, agentId: initialAgent, channel, chatId: initialChatId, agents: initialAgents }: ChatAppProps) {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const width = Math.max(40, Math.min((stdout?.columns || 80) - 4, 100))

  const [turns, setTurns] = useState<Turn[]>([])
  const [active, setActive] = useState<Turn | null>(null)
  const [agentId, setAgentId] = useState(initialAgent)
  const [agents, setAgents] = useState(initialAgents)
  const [chatId, setChatId] = useState(initialChatId)
  const [input, setInput] = useState("")
  const [notice, setNotice] = useState<string>("")

  const history = useRef<string[]>([])
  const histIdx = useRef<number>(-1)
  const cycle = useRef<MentionCycle | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const busy = active?.live ?? false

  // `@`-mention autocomplete for the current buffer (agents + cwd files).
  const suggest = useMemo(
    () => mentionSuggestions(input, agents.map((a) => a.id), process.cwd()),
    [input, agents],
  )

  // `/`-command menu — active while typing a command (slash + partial word).
  const slashSuggest = useMemo(() => {
    const m = /^\/(\w*)$/.exec(input)
    if (!m) return null
    const items = COMMANDS.filter((c) => c.cmd.slice(1).startsWith(m[1].toLowerCase()))
    return items.length ? items : null
  }, [input])

  const pushNotice = (m: string) => setNotice(m)

  const runTurn = useCallback(
    (text: string) => {
      const id = randomUUID().slice(0, 8)
      const startedAt = Date.now()
      const ac = new AbortController()
      abortRef.current = ac

      // Mutable ref to the current turn so streaming callbacks coalesce
      // without stale-closure races; we mirror it into state to repaint.
      const turn: Turn = { id, you: text, agentId, segs: [], live: true, startedAt }
      setActive({ ...turn })
      const repaint = () => setActive({ ...turn, segs: turn.segs.map((s) => ({ ...s })) })

      void (async () => {
        try {
          const r = await streamTask(conn, agentId, text, {
            channel,
            chatId,
            signal: ac.signal,
            onText: (t) => {
              const last = turn.segs[turn.segs.length - 1]
              if (last && last.type === "text") last.content = (last.content ?? "") + t
              else turn.segs.push({ type: "text", content: t })
              repaint()
            },
            onThinking: (t) => { turn.thinking = (turn.thinking ?? "") + t; repaint() },
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
          setTurns((prev) => [...prev, {
            ...turn, live: false, elapsedMs: Date.now() - startedAt, outTokens: r.usage?.outputTokens, error: r.error,
          }])
          setActive(null)
        } catch (e: any) {
          const interrupted = ac.signal.aborted || e?.name === "AbortError"
          setTurns((prev) => [...prev, {
            ...turn, live: false, elapsedMs: Date.now() - startedAt,
            interrupted, error: interrupted ? undefined : (e?.message || String(e)),
          }])
          setActive(null)
        } finally {
          if (abortRef.current === ac) abortRef.current = null
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
    // Esc interrupts a live turn; when idle it exits.
    if (key.escape) {
      if (busy && abortRef.current) { abortRef.current.abort(); return }
      exit()
      return
    }
    // Tab completes a slash command, or accepts/cycles an @-mention.
    if (key.tab) {
      if (slashSuggest) { setInput(slashSuggest[0].cmd + " "); return }
      const applied = advanceMention(input, cycle, agents.map((a) => a.id), process.cwd())
      if (applied !== null) { setInput(applied); histIdx.current = -1 }
      return
    }
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
    if (key.backspace || key.delete) { cycle.current = null; setInput((s) => s.slice(0, -1)); return }

    // Everything else routes through the shared composer classifier: a real
    // Enter (or single-line text+newline) submits, a multi-line paste is
    // preserved, a trailing backslash continues on a new line.
    if (key.ctrl || key.meta) return
    const action = classifyComposerInput(ch ?? "", key.return, input)
    switch (action.kind) {
      case "paste": cycle.current = null; setInput((s) => s + action.text); histIdx.current = -1; return
      case "type": cycle.current = null; setInput((s) => s + action.text); histIdx.current = -1; return
      case "continue": setInput(action.buffer); return
      case "submit":
        if (busy) return
        cycle.current = null
        setInput("")
        submit(action.text)
        return
      case "none": return
    }
  })

  const accent = busy ? theme.working : theme.accent
  const inputLines = input.length ? input.split("\n") : [""]
  const model = agents.find((a) => a.id === agentId)?.model
  const rows = stdout?.rows || 24
  // Bottom-anchored transcript window: render a bounded tail (older turns
  // clip off the top), so the composer stays flush with the terminal's
  // bottom edge like a fixed footer.
  const visibleTurns = turns.slice(-40)
  return (
    <Box flexDirection="column" height={rows}>
      {/* Transcript — fills the space above the footer, anchored to bottom. */}
      <Box flexDirection="column" flexGrow={1} justifyContent="flex-end" overflow="hidden">
        {turns.length === 0 && !active ? (
          <Box flexDirection="column">
            <Text><Text color={theme.accent} bold>{BRAND}</Text><Text dimColor> — chat with </Text><Text color={theme.accent}>@{agentId}</Text>{model ? <Text dimColor> · {model}</Text> : null}</Text>
            <Text dimColor>streaming · markdown · tools · type a message, or / for commands</Text>
          </Box>
        ) : null}
        {visibleTurns.map((t) => <TurnView key={t.id} turn={t} width={width} />)}
        {active ? <TurnView turn={active} width={width} /> : null}
      </Box>

      {/* Footer: command menu / suggestions, the input bar, and the status line. */}
      {/* command menu / @-suggestions / transient notice, above the input */}
      {slashSuggest ? (
        <Box flexDirection="column" marginTop={1}>
          {slashSuggest.map((c, i) => (
            <Box key={c.cmd}>
              <Text color={i === 0 ? theme.accent : theme.muted} bold={i === 0}>{c.cmd.padEnd(10)}</Text>
              <Text dimColor>{c.desc}</Text>
            </Box>
          ))}
        </Box>
      ) : suggest ? (
        <Box marginTop={1}>
          <Text color={theme.accent}>↹ </Text>
          {suggest.items.map((it, i) => (
            <Text key={i} color={i === 0 ? theme.accent : theme.muted}>{it}{i < suggest.items.length - 1 ? "   " : ""}</Text>
          ))}
        </Box>
      ) : notice ? (
        <Box marginTop={1}><Text dimColor>{notice}</Text></Box>
      ) : null}

      {/* Full-width input — top + bottom rules only, pinned to the bottom. */}
      <Box
        borderStyle="single"
        borderColor={accent}
        borderLeft={false}
        borderRight={false}
        borderDimColor={!busy}
        width="100%"
      >
        <Box flexDirection="column" width="100%">
          {inputLines.map((ln, i, arr) => (
            <Box key={i}>
              <Text color={accent} bold>{i === 0 ? "› " : "  "}</Text>
              <Text>{ln}</Text>
              {i === arr.length - 1 && !busy ? <Text color={accent}>▏</Text> : null}
            </Box>
          ))}
        </Box>
      </Box>

      {/* Status bar */}
      <Box justifyContent="space-between">
        <Text>
          <Text color={theme.accent} bold>{BRAND}</Text>
          <Text dimColor> · @{agentId}{model ? ` · ${model}` : ""}</Text>
        </Text>
        <Text dimColor>↵ send   / cmds   @ mention   esc {busy ? "stop" : "exit"}</Text>
      </Box>
    </Box>
  )
}

function TurnView({ turn, width }: { turn: Turn; width: number }) {
  const body = useMemo(() => renderSegs(turn, width), [turn, width])
  const hasText = turn.segs.some((s) => s.type === "text" && s.content)
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={theme.accent} bold>{GUTTER} you</Text>
      {turn.you.split("\n").map((ln, i) => <Text key={`u${i}`} color="white">  {ln}</Text>)}
      <Text color={theme.agent} bold>{GUTTER} {turn.agentId ?? "agent"}</Text>
      {turn.thinking ? (
        <Box flexDirection="column">
          {tail(turn.thinking, turn.live ? 3 : 2).map((ln, i) => (
            <Text key={`th${i}`} dimColor italic>  {ln}</Text>
          ))}
        </Box>
      ) : null}
      {body}
      {turn.live ? (
        <WorkingStatus startedAt={turn.startedAt} phase={hasText ? "responding" : "thinking"} hint="esc to interrupt" />
      ) : turn.interrupted ? (
        <Text dimColor>  ⊘ interrupted · {(turn.elapsedMs! / 1000).toFixed(1)}s</Text>
      ) : turn.error ? (
        <Text color="red">  ✗ {turn.error}</Text>
      ) : turn.elapsedMs != null ? (
        <Text dimColor>  · {(turn.elapsedMs / 1000).toFixed(1)}s{turn.outTokens != null ? `, ${turn.outTokens} tok` : ""}</Text>
      ) : null}
    </Box>
  )
}

/** Last `n` non-empty lines of a block (for a compact thinking preview). */
function tail(text: string, n: number): string[] {
  const lines = text.split("\n").filter((l) => l.trim())
  return lines.slice(-n)
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
      // Render markdown live as it streams — balancing open markers while the
      // turn is live so partial spans (**bold, `code) render styled, never raw.
      nodes.push(<Text key={i}>{indent(renderMarkdown(s.content, width, { balance: turn.live }))}</Text>)
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
