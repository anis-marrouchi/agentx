import { z } from "zod"

// --- Skill types aligned with skills.sh / Agent Skills spec ---

export const skillFrontmatterSchema = z.object({
  name: z.string(),
  description: z.string(),
  version: z.string().optional(),
  author: z.string().optional(),
  tags: z.array(z.string()).optional(),
  globs: z.array(z.string()).optional(),
  // When to automatically apply this skill
  triggers: z
    .array(
      z.object({
        pattern: z.string(), // regex or keyword pattern
        description: z.string().optional(),
      })
    )
    .optional(),
  /** If true, skill is auto-injected into context when triggers match (per-turn) */
  autoInject: z.boolean().optional(),
  /** Reference card ids cited by this skill (e.g. "ksi.gitlab.project.ksi-v2").
   *  Audit lint flags FAILING when any id does not resolve. */
  references: z.array(z.string()).optional(),
  /** Skills this one delegates to (e.g. ksi-cx-email → [hotmail]). Audit lint
   *  flags FAILING when a delegate has no SKILL.md. */
  delegatesTo: z.array(z.string()).optional(),
  /** Free-form category — used by recipes and audit rules. Common values:
   *  deploy, ssh, email, gitlab, ops, content, marketing. */
  category: z.string().optional(),
})

export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>

export interface Skill {
  frontmatter: SkillFrontmatter
  instructions: string // Markdown body
  source: "local" | "remote" | "generated"
  path?: string // Local file path
  packageId?: string // e.g., "intellectronica/agent-skills"
}

export interface SkillMatch {
  skill: Skill
  relevance: number // 0-1 how relevant to current task
  matchReason: string
}

export interface SkillPackage {
  owner: string
  repo: string
  skills: Skill[]
}
