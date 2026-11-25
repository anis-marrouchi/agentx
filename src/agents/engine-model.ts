import type { AgentDef } from "@/daemon/config"

/** Claude model ids and Claude Code's aliases (opus, sonnet, haiku, fable). */
const CLAUDE_MODEL = /^(claude|opus|sonnet|haiku|fable)/i

/** Whether an engine can run a saved model id (#2101 B1). Claude Code and the
 *  SDK take Claude ids; Codex CLI rejects them ("not supported when using
 *  Codex with a ChatGPT account"); OpenCode wants "provider/model". The
 *  orchestrator picks its own engine, so any model is kept for it. */
export function modelFitsEngine(model: string | undefined, tier: AgentDef["tier"]): boolean {
  if (!model) return true
  switch (tier) {
    case "claude-code":
    case "sdk":
      return CLAUDE_MODEL.test(model)
    case "codex-cli":
      return !CLAUDE_MODEL.test(model) && !model.includes("/")
    case "opencode":
      return model.includes("/")
    default:
      return true
  }
}

/** The model an agent keeps after a switch to `tier`: its own when the engine
 *  can run it, else none, so the run uses that engine's default. */
export function modelAfterSwitch(model: string | undefined, tier: AgentDef["tier"]): string | undefined {
  return modelFitsEngine(model, tier) ? model : undefined
}
