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
    | "overage_disabled"
    | "auth"
    | "permission"
    | "rate_limit"
    | "overloaded"
    | "context_too_large"
    | "invalid_request"
    | "upstream_api"
    | "timeout"
    | "cancelled"
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

  // Claude Code CLI lost its OAuth session — "Not logged in · Please run /login".
  // Usually a transient refresh race when multiple agents share one credentials
  // file on the same host; occasionally the token is genuinely stale. Either way
  // it comes through as plain CLI text with no JSON envelope, so match it before
  // the parse step below.
  if (/not logged in|please run \/login/i.test(source)) {
    return {
      kind: "auth",
      retryable: true,
      message: "The agent's Claude Code session is logged out.",
      fix: "Usually a transient OAuth refresh race under concurrent load — retry in a moment. If it persists, run `/login` in the agent's workspace.",
      raw: source,
    }
  }

  // Plain-text Max-plan overage signal that may arrive without a JSON
  // envelope (the structured parse below also catches it via errMessage).
  // Order matters: this case must fire BEFORE the plain-text `out_of_credits`
  // branch — "out of extra usage" matches both regexes, but `overage_disabled`
  // is the more specific (and retryable) classification.
  if (/out of extra usage/i.test(source)) {
    return {
      kind: "overage_disabled",
      retryable: true,
      message: "Claude Max-plan overage is unavailable (disabled or depleted at the org level).",
      fix: "Enable overage / extra usage at https://claude.ai/settings/usage (this is the subscription account's toggle — not Anthropic API billing). Warm sessions can still succeed via prompt cache; cold dispatches will keep failing until overage is re-enabled.",
      raw: source,
    }
  }

  // Plain-text credit-balance signal (programmatic ANTHROPIC_API_KEY accounts)
  // that may arrive without a JSON envelope — some CLI paths surface the API
  // message verbatim. Matched here so we route to `out_of_credits` even when
  // the structured parse below would otherwise fall through to `unknown`.
  if (/credit balance (is )?too low|out of credit|credit(s)? exhausted|insufficient credit/i.test(source)) {
    return {
      kind: "out_of_credits",
      retryable: false,
      message: "The agent is out of Anthropic credits.",
      fix: "Top up at https://console.anthropic.com/settings/billing (or claude.ai/settings/usage for Max subscribers), then retry.",
      raw: source,
    }
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

  // Max-plan overage disabled — the most common root cause on subscription
  // accounts. Anthropic returns "You're out of extra usage" when a request
  // would spill past the regular Max allotment AND overage ("extra usage")
  // is disabled at the org level. Operator fix is flipping a toggle on
  // claude.ai, not topping up API credits — so route this to its own kind
  // with a retryable:true hint (re-enabling overage unblocks immediately).
  if (errMessage && /out of extra usage/i.test(errMessage)) {
    return {
      kind: "overage_disabled",
      retryable: true,
      message: "Claude Max-plan overage is unavailable (disabled or depleted at the org level).",
      fix: "Enable overage / extra usage at https://claude.ai/settings/usage (this is the subscription account's toggle — not Anthropic API billing). Warm sessions can still succeed via prompt cache; cold dispatches will keep failing until overage is re-enabled.",
      raw: source,
    }
  }

  // Real API credit exhaustion (programmatic ANTHROPIC_API_KEY accounts).
  // "Credit balance is too low" is what Anthropic's API actually returns on
  // depletion — earlier wording variants are kept for back-compat.
  if (errMessage && /out of (extra )?usage|out of credit|credit(s)? exhausted|insufficient credit|credit balance (is )?too low|low credit balance/i.test(errMessage)) {
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
