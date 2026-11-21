// `agentx demo` reads a helper's answer by its hand-off id (#2007 piece 2).
// /send/agent no longer waits for an answer, for anyone: it answers 202
// with a dlg- id at once. The demo is a CLI, not an agent, so waiting here
// holds no agent: it reads GET /a2a/delegations/<id>?as=<sender> until the
// hand-off ends, bounded by a time limit.

/** Read one JSON answer from the daemon, by path. */
export type GetJson = (path: string) => Promise<any>

/**
 * The text of hand-off `id` once it ends: its answer when it is done, or
 * "(<status>) <text>" when it ended another way. After `timeoutMs` it says
 * the work is still running and how to read it later.
 */
export async function waitForHandoffReply(
  get: GetJson,
  id: string,
  as: string,
  opts: { pollMs?: number; timeoutMs?: number } = {},
): Promise<string> {
  const pollMs = opts.pollMs ?? 2000
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000
  const path = `/a2a/delegations/${encodeURIComponent(id)}?as=${encodeURIComponent(as)}`
  const until = Date.now() + timeoutMs
  for (;;) {
    let row: any = null
    try { row = await get(path) } catch { /* not readable yet: try again */ }
    const status = typeof row?.status === "string" ? row.status : "running"
    if (status !== "running") {
      const text = typeof row?.text === "string" && row.text ? row.text : "(no answer text)"
      return status === "done" ? text : `(${status}) ${text}`
    }
    if (Date.now() >= until) return `(still running; read it later with GET ${path})`
    await new Promise((r) => setTimeout(r, pollMs))
  }
}
