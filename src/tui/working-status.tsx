import React, { useEffect, useState } from "react"
import { Text } from "ink"

// Claude-Code-style animated working indicator: a pulsing glyph, a rotating
// gerund while the model is thinking, a live elapsed counter, and (in the
// standalone REPL) a real "esc to interrupt" hint. Self-contained: its own
// interval drives the frame, so mounting it is all a caller needs.

const PULSE = ["✶", "✸", "✹", "✺", "✹", "✷"]
const GERUNDS = [
  "Thinking", "Pondering", "Cerebrating", "Noodling", "Percolating",
  "Ruminating", "Conjuring", "Synthesizing", "Deliberating", "Marinating",
]

export function WorkingStatus({
  startedAt,
  phase,
  hint,
  indent = "  ",
}: {
  startedAt: number
  phase: "thinking" | "responding"
  /** Trailing hint, e.g. "esc to interrupt". Omit in constrained panes. */
  hint?: string
  indent?: string
}) {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setFrame((f) => f + 1), 120)
    return () => clearInterval(t)
  }, [])
  const glyph = PULSE[frame % PULSE.length]
  const secs = Math.floor((Date.now() - startedAt) / 1000)
  const word = phase === "responding" ? "Responding" : GERUNDS[Math.floor(frame / 16) % GERUNDS.length]
  return (
    <Text>
      {indent}<Text color="magenta">{glyph}</Text> <Text color="magenta" bold>{word}…</Text>{" "}
      <Text dimColor>({secs}s{hint ? ` · ${hint}` : ""})</Text>
    </Text>
  )
}
