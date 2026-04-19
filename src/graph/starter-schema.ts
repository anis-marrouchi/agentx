import type { GraphSchema } from "./types"

/**
 * Ships with the install. When .agentx/graph/schema.json is missing, the
 * store seeds this so a fresh daemon has something to classify against.
 *
 * Five levels, three primaries at the leaf (who / what / where) — matches
 * the "primary colors per level" design from the plan.
 */
export const STARTER_SCHEMA: GraphSchema = {
  version: 1,
  levels: [
    {
      id: "scope",
      description: "The outermost context — everything else is nested inside.",
      axes: [
        {
          name: "kind",
          type: "enum",
          values: ["personal", "business", "other"],
          description: "Which realm this message belongs to.",
        },
      ],
    },
    {
      id: "location",
      description: "Physical or logical location. Optional — skip for remote-first orgs.",
      axes: [
        { name: "country", type: "free" },
        { name: "city", type: "free" },
      ],
    },
    {
      id: "org",
      description: "Any collective this message is about — company, family, club, team, or just yourself.",
      axes: [
        { name: "name", type: "free" },
        {
          name: "orgKind",
          type: "enum",
          values: [
            "company",
            "team",
            "client",
            "family",
            "household",
            "club",
            "community",
            "group",
            "self",
          ],
          description: "What kind of collective. `self` = just you, no org.",
        },
      ],
    },
    {
      id: "unit",
      description: "A person or sub-group within the org (department, squad, branch of a family, etc.).",
      axes: [
        {
          name: "unitKind",
          type: "enum",
          values: ["person", "department", "group", "household-member", "teammate"],
        },
        { name: "name", type: "free" },
        { name: "role", type: "free", description: "Role/title/relationship (DevOps Lead, mother, coach, captain…)." },
        {
          name: "lead",
          type: "ref",
          refLevel: "unit",
          description: "If this is a sub-group, the person who leads/represents it. Optional.",
        },
      ],
    },
    {
      id: "activity",
      description: "The actual intent. Three primaries: who / what / where.",
      axes: [
        { name: "who", type: "ref", refLevel: "unit" },
        { name: "what", type: "free", description: "The verb — review, deploy, draft, plan dinner, book training…" },
        { name: "where", type: "ref", refLevel: "org" },
      ],
    },
  ],
  leafInput: {
    name: "input",
    type: "enum",
    values: [
      "telegram",
      "whatsapp",
      "slack",
      "discord",
      "gitlab-mr",
      "gitlab-issue",
      "cron",
      "webhook",
      "http",
    ],
    description: "Where the message entered the system.",
  },
  leafOutput: {
    name: "output",
    type: "free",
    description: "Expected result. Free text — the LLM proposes, you refine.",
  },
}
