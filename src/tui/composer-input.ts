// Classify a composer keystroke/paste chunk into an action. Ink calls the
// input handler once per stdin data event with the whole chunk, so a
// multi-line paste arrives intact (internal newlines, not a discrete Enter)
// while a real Enter arrives as an empty chunk with key.return set. Kept pure
// so both composers (standalone ChatApp + tui pane) share it and it's
// unit-testable without a pty.

export type ComposerAction =
  | { kind: "paste"; text: string }       // append (multi-line paste; newlines preserved)
  | { kind: "type"; text: string }        // append typed characters
  | { kind: "continue"; buffer: string }  // trailing "\" → newline, don't submit
  | { kind: "submit"; text: string }      // Enter (or single-line text+newline)
  | { kind: "none" }

export function classifyComposerInput(chunk: string, isReturn: boolean, buffer: string): ComposerAction {
  const body = (chunk ?? "").replace(/[\r\n]+$/, "")
  // Internal newline in a single chunk ⇒ multi-line paste: keep it whole.
  if (/[\r\n]/.test(body)) {
    return { kind: "paste", text: body.replace(/\r\n?/g, "\n") }
  }
  // A real Enter (empty chunk + key.return) or a single-line "text\n" chunk.
  if (isReturn || /[\r\n]$/.test(chunk ?? "")) {
    const combined = buffer + body
    if (combined.endsWith("\\")) return { kind: "continue", buffer: combined.slice(0, -1) + "\n" }
    return { kind: "submit", text: combined }
  }
  if (chunk) return { kind: "type", text: chunk }
  return { kind: "none" }
}
