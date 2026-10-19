import { join } from "path"
import { claudeCode } from "./claude-code"
import type { ConventionTier, RuntimeConventions } from "./types"

// sdk and orchestrator agents run inside AgentX, which matches skills from
// .claude/skills, .skills and skills into their prompt (agent/skills/
// loader.ts). New skills go to .claude/skills, where the claude-code add
// command puts them too.
const inAgentx = (tier: ConventionTier): RuntimeConventions => ({
  ...claudeCode,
  tier,
  skillDirs: (ws) => [join(ws, ".claude", "skills"), join(ws, ".skills"), join(ws, "skills")],
})

export const sdk = inAgentx("sdk")
export const orchestrator = inAgentx("orchestrator")
