// --- Translate Anthropic API / Claude Code errors into human-friendly text ---
//
// Raw errors from the Claude Code CLI look like:
//   API Error: 400 {"type":"error","error":{"type":"invalid_request_error",
//                 "message":"You're out of extra usage. Add more at ..."}}
// These are painful to surface in a chat reply or the dashboard. This module
// parses the structured bit and returns a short, actionable sentence.

export interface FriendlyError {
  /** One-line, operator-facing message suitable for a dashboard card or chat reply. */
  message: string
  /** Optional next step the user can take. */
  fix?: string
  /** Machine-readable error category for routing / retries. */
  kind:
    | "out_of_credits"
    | "auth"
    | "permission"
    | "rate_limit"
    | "overloaded"
    | "context_too_large"
    | "invalid_request"
    | "upstream_api"
    | "timeout"
    | "unknown"
  /** Whether this error is transient — a retry has a reasonable chance of succeeding. */
  retryable: boolean
  /** Source error text retained for logs / debugging. */
  raw?: string
}

/**
 * Best-effort translator. If we recognise the shape we return a structured
 * FriendlyError; otherwise we hand back the original text wrapped as "unknown".
 * Never throws — errors are data in here.
 */
export function friendlyModelError(raw: string | undefined | null): FriendlyError {
  const source = (raw || "").trim()
  if (!source) {
    return { message: "Unknown error from the model.", kind: "unknown", retryable: false }
  }

  // Timeouts are wrapped by us upstream; pass through.
  if (/timed out after/i.test(source)) {
    return { message: source.slice(0, 300), kind: "timeout", retryable: true, raw: source }
  }

  // Look for the standard Anthropic JSON envelope anywhere in the string —
  // the CLI prefixes it with "API Error: <status>".
  const jsonMatch = source.match(/\{.*\}\s*$/s) || source.match(/\{[\s\S]*\}/)
  let parsed: any
  if (jsonMatch) {
    try { parsed = JSON.parse(jsonMatch[0]) } catch { /* raw text only */ }
  }

  const inner = parsed?.error || parsed
  const errType: string | undefined = typeof inner?.type === "string" ? inner.type : undefined
  const errMessage: string | undefined = typeof inner?.message === "string" ? inner.message : undefined

  const statusMatch = source.match(/API Error:\s*(\d{3})/i)
  const status = statusMatch ? parseInt(statusMatch[1], 10) : undefined

  // Credits exhausted — the specific case the user flagged.
  if (errMessage && /out of (extra )?usage|out of credit|credit(s)? exhausted|insufficient credit/i.test(errMessage)) {
    return {
      kind: "out_of_credits",
      retryable: false,
      message: "The agent is out of Anthropic credits.",
      fix: "Top up at https://console.anthropic.com/settings/billing (or claude.ai/settings/usage for Max subscribers), then retry.",
      raw: source,
    }
  }

  // Context-length issues.
  if (errMessage && /context|prompt is too long|too many tokens|maximum context length/i.test(errMessage)) {
    return {
      kind: "context_too_large",
      retryable: false,
      message: "The conversation has grown past what the model can hold.",
      fix: "Clear session history or switch the agent to a bigger context model.",
      raw: source,
    }
  }

  // Authentication & API key issues.
  if (errType === "authentication_error" || (errMessage && /authentication|invalid.*api.*key|no api key|not authenticated/i.test(errMessage))) {
    return {
      kind: "auth",
      retryable: false,
      message: "Authentication failed talking to Anthropic.",
      fix: "Check ANTHROPIC_API_KEY in .env (or the Claude Code login for claude-code tier agents).",
      raw: source,
    }
  }

  // Permission / forbidden.
  if (errType === "permission_error" || status === 403) {
    return {
      kind: "permission",
      retryable: false,
      message: errMessage || "The API key doesn't have permission for this request.",
      raw: source,
    }
  }

  // Rate limit from Anthropic's side.
  if (errType === "rate_limit_error" || status === 429) {
    return {
      kind: "rate_limit",
      retryable: true,
      message: "Anthropic's API rate-limited this request.",
      fix: "AgentX will retry automatically. If it recurs, lower the agent's concurrency or spread scheduled jobs.",
      raw: source,
    }
  }

  // Server-side overload.
  if (errType === "overloaded_error" || status === 529 || status === 503) {
    return {
      kind: "overloaded",
      retryable: true,
      message: "Anthropic's API is temporarily overloaded.",
      fix: "AgentX will retry in a moment.",
      raw: source,
    }
  }

  // Generic invalid request — surface the API message verbatim (truncated).
  if (errType === "invalid_request_error" || status === 400) {
    return {
      kind: "invalid_request",
      retryable: false,
      message: errMessage || "The model rejected the request as invalid.",
      raw: source,
    }
  }

  // Other Anthropic API errors (5xx catchall).
  if (status && status >= 500) {
    return {
      kind: "upstream_api",
      retryable: true,
      message: errMessage || `Anthropic API error (HTTP ${status}).`,
      fix: "Transient — retry. Check https://status.anthropic.com if it persists.",
      raw: source,
    }
  }

  // Fallback: unknown shape, keep the text short.
  return {
    kind: "unknown",
    retryable: false,
    message: source.replace(/\s+/g, " ").slice(0, 220),
    raw: source,
  }
}

/**
 * Render a FriendlyError back to a one-line string (primary message + fix),
 * which is what most call sites want when updating `response.error`.
 */
export function renderFriendlyError(f: FriendlyError): string {
  return f.fix ? `${f.message} — ${f.fix}` : f.message
}
