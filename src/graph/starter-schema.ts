import type { GraphSchema } from "./types"

/**
 * Ships with the install. When .agentx/graph/schema.json is missing,
 * the store seeds this so a fresh daemon has something to classify
 * against.
 *
 * v2 — Phase 1 of the classifier-retire plan: verb-level intent
 * taxonomy. The classifier now answers ONLY "what kind of work is
 * this" — it does not embed client/project/agent in the leaf because
 * those already live on the event metadata (project, subject,
 * agentId). One copy of "review.merge-request" instead of one per
 * client.
 *
 * Two levels:
 *   category — broad work area (code/ops/support/admin/knowledge/social/system)
 *   verb     — specific intent (review.merge-request, deploy.staging, etc.)
 *
 * The category is closed-set; the verb is open-set so the operator
 * can add new ones via `agentx graph review` over time. Most paths
 * will reuse the seeded verbs below.
 *
 * Why so few levels: every level is information the classifier
 * actually has to decide. The previous v1 schema (scope > location >
 * org > unit > activity) re-encoded data already on the event —
 * forcing a 5-LLM-question prompt to recover what we already knew.
 */
export const STARTER_SCHEMA: GraphSchema = {
  version: 2,
  levels: [
    {
      id: "category",
      description: "Top-level kind of work. Closed set — pick the closest fit.",
      axes: [
        {
          name: "kind",
          type: "enum",
          values: [
            "code",       // anything code-related: review, fix, implement, refactor
            "ops",        // infra: deploy, monitor, rollback, scale, incident
            "support",    // human-facing: answer question, triage, route
            "admin",      // governance: config change, scheduling, token, role
            "knowledge",  // wiki, docs, research, summarize
            "social",     // marketing, comms, brief, content
            "system",     // internal infrastructure (rare; mostly classifier itself)
          ],
          description: "Which category this work belongs in.",
        },
      ],
    },
    {
      id: "verb",
      description: "Specific intent — verb-level only, NOT client/project-bound.",
      axes: [
        {
          name: "name",
          type: "free",
          description:
            "Lower-kebab dot-namespaced verb. Examples: review.merge-request, fix.bug, " +
            "investigate.error, deploy.staging, deploy.production, rollback.release, " +
            "spec.feature, triage.issue, document.feature, chat.greeting, " +
            "chat.support-request, schedule.add, config.change, ingest.contact, " +
            "transcribe.audio, brief.daily, summarize.thread, plan.work.",
        },
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
      "github-issue",
      "github-pr",
      "cron",
      "webhook",
      "mesh",
      "http",
    ],
    description: "Where the message entered the system.",
  },
  leafOutput: {
    name: "output",
    type: "free",
    description:
      "One short sentence describing what the agent is expected to produce. " +
      "Generic — refers to the verb's outcome, not the specific client/project " +
      "(those are on the event metadata already).",
  },
}

/** Pre-seeded verbs shipped with v2. The classifier picks from these
 *  first; new verbs go through the review queue before they're
 *  committed (so the taxonomy doesn't drift). Adding to this list is
 *  cheap — the seed runs once when nodes.json is empty. */
export const STARTER_VERB_NODES: Array<{
  category: "code" | "ops" | "support" | "admin" | "knowledge" | "social" | "system"
  verb: string
  description?: string
}> = [
  // code
  { category: "code", verb: "review.merge-request",  description: "Review a GitLab MR or GitHub PR" },
  { category: "code", verb: "review.code-change",    description: "General code review (snippet, diff)" },
  { category: "code", verb: "fix.bug",               description: "Fix a reported bug" },
  { category: "code", verb: "implement.feature",     description: "Build a new feature" },
  { category: "code", verb: "investigate.error",     description: "Investigate a failing test, exception, pipeline" },
  { category: "code", verb: "refactor.code",         description: "Restructure existing code without behaviour change" },
  { category: "code", verb: "spec.feature",          description: "Write or update a feature spec / RFC" },
  { category: "code", verb: "triage.issue",          description: "Classify, label, or assign an issue" },
  { category: "code", verb: "answer.code-question",  description: "Answer a code-related question" },

  // ops
  { category: "ops",  verb: "deploy.staging",        description: "Deploy to a staging/preview environment" },
  { category: "ops",  verb: "deploy.production",     description: "Deploy to production" },
  { category: "ops",  verb: "rollback.release",      description: "Roll back a release" },
  { category: "ops",  verb: "investigate.incident",  description: "Investigate a production incident" },
  { category: "ops",  verb: "monitor.system",        description: "Check system status / metrics" },
  { category: "ops",  verb: "rotate.credential",     description: "Rotate a token, key, certificate" },
  { category: "ops",  verb: "audit.security",        description: "Review for security issues" },

  // support
  { category: "support", verb: "chat.greeting",            description: "A casual hello, no actionable request" },
  { category: "support", verb: "chat.support-request",     description: "End-user / customer asking for help" },
  { category: "support", verb: "chat.casual",              description: "Informal back-and-forth chat" },
  { category: "support", verb: "answer.question",          description: "Answer an open-ended question" },
  { category: "support", verb: "route.request",            description: "Forward a request to the right agent" },

  // admin
  { category: "admin", verb: "config.change",        description: "Change agentx.json / environment / config" },
  { category: "admin", verb: "schedule.add",         description: "Add a new cron / scheduled task" },
  { category: "admin", verb: "schedule.remove",      description: "Remove or disable a schedule" },
  { category: "admin", verb: "token.create",         description: "Mint a scoped API token" },
  { category: "admin", verb: "agent.add",            description: "Configure a new agent" },
  { category: "admin", verb: "channel.add",          description: "Wire up a new channel" },

  // knowledge
  { category: "knowledge", verb: "document.feature",     description: "Write or update documentation" },
  { category: "knowledge", verb: "summarize.thread",     description: "Summarize a long conversation/thread" },
  { category: "knowledge", verb: "research.topic",       description: "Investigate / gather info on a topic" },
  { category: "knowledge", verb: "wiki.absorb",          description: "Roll raw entries into typed wiki articles" },

  // social
  { category: "social", verb: "brief.daily",         description: "Compose a daily brief / digest" },
  { category: "social", verb: "draft.post",          description: "Draft a marketing post / announcement" },
  { category: "social", verb: "report.weekly",       description: "Compose a weekly status report" },

  // system (the classifier itself; rare to expose)
  { category: "system", verb: "classify.intent",     description: "Internal: graph-classifier sub-call" },
]

