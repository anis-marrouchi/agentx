// System vocabulary that must never appear in user-perspective procedure
// text. One list feeds both the extraction prompt and the lint, so what the
// model is told and what the code rejects cannot drift apart. Common English
// verbs that double as tool names (read, write, edit) are deliberately NOT
// here.
export const BANNED_WORDS = [
  "bash", "zsh", "grep", "curl", "sed", "awk", "regex", "terminal", "shell",
  "script", "cli", "mcp", "api", "json", "yaml", "sql", "sqlite", "http", "localhost",
  "llm", "ai", "claude", "anthropic", "gpt", "chatgpt", "agent", "assistant", "bot",
  "model", "session", "prompt", "token", "daemon", "webhook", "endpoint",
  "database", "workflow", "stdout", "stderr", "subprocess",
] as const

/** Word-boundary matched, case-insensitive. */
export const BANNED = new RegExp(`\\b(${BANNED_WORDS.join("|")})\\b`, "i")
