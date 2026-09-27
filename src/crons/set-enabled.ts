import { applyConfigMutation } from "@/daemon/config-mutator"

// --- Switch one schedule on or off ---
//
// The HTTP twin of `agentx cron enable|disable` (commands/manage.ts), used by
// the daemon's POST /crons/:id/enabled so the phone app and the dashboard can
// retire an obsolete schedule without a terminal. Same rules as the CLI: an
// unknown id is an error, and a schedule an agent proposed stays off until it
// is approved (`agentx schedule approve`), whoever asks.
//
// Writes agentx.json through applyConfigMutation (schema-validated, ${VAR}
// tokens preserved). The caller reloads; this helper never does, so the
// daemon doesn't POST /reload to itself.

export type SetCronEnabledResult =
  | { ok: true; id: string; enabled: boolean; changed: boolean }
  | { ok: false; status: 404 | 409 | 500; error: string }

export async function setCronEnabled(
  id: string,
  enabled: boolean,
  opts: { configPath?: string } = {},
): Promise<SetCronEnabledResult> {
  // Throwing from the mutator aborts before anything is written, so a
  // refusal or a no-op never touches agentx.json (and never wakes the
  // daemon's config watcher).
  let outcome: SetCronEnabledResult | null = null
  const r = await applyConfigMutation((cfg) => {
    const job = cfg.crons?.[id]
    if (!job) outcome = { ok: false, status: 404, error: `no schedule "${id}"` }
    else if (enabled && job.approval?.action === "create") {
      outcome = { ok: false, status: 409, error: `schedule "${id}" is waiting for approval: agentx schedule approve ${id}` }
    } else if (job.enabled === enabled) outcome = { ok: true, id, enabled, changed: false }
    if (outcome) throw new Error("no write")
    job.enabled = enabled
    outcome = { ok: true, id, enabled, changed: true }
  }, { configPath: opts.configPath, reload: false })
  if (outcome && (!(outcome as SetCronEnabledResult).ok || !(outcome as { changed: boolean }).changed)) return outcome
  if (!r.success) return { ok: false, status: 500, error: r.error || "could not write agentx.json" }
  return outcome ?? { ok: false, status: 500, error: "mutation did not run" }
}
