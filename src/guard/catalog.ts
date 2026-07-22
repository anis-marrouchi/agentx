import type { GuardPolicy, GuardRule } from "./types"

// --- Default destructive-command catalog (PRD §7) ---
//
// Shipped as the base policy layer. Every entry is DATA: operators override,
// disable, or retune any of it via YAML under `.agentx/guardrails/`. Rules
// that reference `target_in: "production"` only bite when the operator has
// actually declared `protected_resources.production` in their policy — the
// catalog alone knows the destructive *verbs*, not which hosts are prod.
//
// The class that caused the 2026-07-21 incident is `prisma-shadow-against-prod`:
// `prisma migrate diff --from-migrations` RESETS whatever --shadow-database-url
// points at, so pointing it at production wipes production.

export const CATALOG_RULES: GuardRule[] = [
  // ---- Prisma (the incident class) --------------------------------------
  {
    id: "prisma-shadow-against-prod",
    match: {
      tool: "Bash",
      command_regex: "prisma\\s+migrate\\s+diff[\\s\\S]*--shadow-database-url",
      target_in: "production",
    },
    action: "deny",
    severity: "critical",
    message:
      "`prisma migrate diff` RESETS the --shadow-database-url target (drops + recreates its schema). Never point it at production. Use a throwaway/local shadow DB.",
    preconditions: [],
  },
  {
    id: "prisma-reset-or-force-push-prod",
    match: {
      tool: "Bash",
      command_regex:
        "prisma\\s+(migrate\\s+reset|db\\s+push(\\s|$)[\\s\\S]*|db\\s+push\\s+--force-reset)",
      target_in: "production",
    },
    action: "deny",
    severity: "critical",
    message: "`prisma migrate reset` / `db push` rebuilds the schema and drops data. Refused against production.",
    preconditions: [],
  },
  {
    id: "prisma-migrate-deploy-prod",
    match: { tool: "Bash", command_regex: "prisma\\s+migrate\\s+deploy", target_in: "production" },
    action: "escalate",
    severity: "high",
    message: "Applying migrations to production needs human approval and a fresh backup.",
    preconditions: ["fresh_backup(production)"],
  },

  // ---- Raw destructive SQL ----------------------------------------------
  {
    id: "raw-sql-destructive-prod",
    match: {
      tool: "Bash",
      command_regex: "(?i)(drop\\s+(table|database|schema)|truncate\\s+table|delete\\s+from|alter\\s+[\\s\\S]*drop)",
      target_in: "production",
    },
    action: "escalate",
    severity: "high",
    message: "Destructive SQL against production requires human approval.",
    preconditions: [],
  },

  // ---- DB drop / restore -------------------------------------------------
  {
    id: "db-drop-or-clean-restore-prod",
    match: {
      tool: "Bash",
      command_regex: "(?i)(dropdb\\b|pg_restore[\\s\\S]*--clean|mongo(sh)?[\\s\\S]*\\.drop\\()",
      target_in: "production",
    },
    action: "deny",
    severity: "critical",
    message: "Dropping or clean-restoring a production database is refused.",
    preconditions: [],
  },

  // ---- Filesystem --------------------------------------------------------
  {
    id: "fs-recursive-delete",
    match: {
      tool: "Bash",
      // rm -rf (any flag order) or `find ... -delete`. Scratch/temp paths are
      // exempted by the negative lookahead so routine cleanup stays friction-free.
      command_regex:
        "(?i)(\\brm\\s+-[a-z]*r[a-z]*f|\\brm\\s+-[a-z]*f[a-z]*r|\\bfind\\b[\\s\\S]*-delete)(?![\\s\\S]*(/tmp|/private/tmp|scratchpad|node_modules|\\.cache|dist/))",
    },
    action: "escalate",
    severity: "high",
    message: "Recursive delete on a non-scratch path. Confirm the target before proceeding.",
    preconditions: [],
  },

  // ---- Containers / volumes ---------------------------------------------
  {
    id: "container-volume-destroy",
    match: {
      tool: "Bash",
      command_regex: "(?i)(docker\\s+compose\\s+down[\\s\\S]*(-v|--volumes)|docker\\s+volume\\s+rm|docker\\s+system\\s+prune[\\s\\S]*--volumes)",
    },
    action: "escalate",
    severity: "high",
    message: "This destroys container volumes (persistent data). Confirm intent.",
    preconditions: [],
  },

  // ---- Infra -------------------------------------------------------------
  {
    id: "infra-destroy",
    match: {
      tool: "Bash",
      command_regex: "(?i)(terraform\\s+destroy|doctl\\s+[\\s\\S]*\\bdelete\\b|kubectl\\s+delete\\s+(ns|namespace)|kubectl\\s+delete\\s+[\\s\\S]*--all)",
    },
    action: "escalate",
    severity: "high",
    message: "Infrastructure teardown. Human approval required.",
    preconditions: [],
  },

  // ---- VCS ---------------------------------------------------------------
  {
    id: "git-force-push",
    match: {
      tool: "Bash",
      command_regex: "(?i)git\\s+push[\\s\\S]*(--force(?!-with-lease)|\\s-f(\\s|$))",
    },
    action: "escalate",
    severity: "medium",
    message: "Force-push can overwrite shared history. Confirm the branch is not protected.",
    preconditions: [],
  },
]

/** The catalog as a base policy layer. Ships `warn` mode so nothing blocks
 *  until an operator promotes it; `unmatched: allow` keeps routine work free. */
export const CATALOG_POLICY: GuardPolicy = {
  version: 1,
  mode: "warn",
  defaults: { fail_mode: "closed", unmatched: "allow" },
  protected_resources: {},
  rules: CATALOG_RULES,
  agents: {},
}
