// Seed policy templates for `agentx guard init`. Kept as strings (not files)
// so the CLI can scaffold `.agentx/guardrails/` on any node without shipping
// example files in the npm tarball. The repo's own `.agentx/guardrails/` is a
// committed instance of these for the local (MacBook) node.

export const SEED_POLICY_YAML = `# AgentX destructive-action guardrails — global policy
#
# This file + environments/*.yaml + agents/<id>.yaml are deep-merged
# (most specific wins). The built-in catalog (prisma / rm -rf / docker /
# terraform / git push --force ... patterns) is ALWAYS applied underneath.
# The guard reads policy live on every tool call — edits take effect on the
# next command, no daemon restart needed.
version: 1

# warn  = compute + audit but never block (Phase 1 rollout stance).
# enforce = honor the verdict (deny blocks; escalate asks).
# off   = kill-switch, allow everything.
# Flip to enforce once \`agentx guard log\` shows an acceptable false-positive rate.
mode: warn

defaults:
  fail_mode: closed   # guard error on a protected-target command => deny
  unmatched: allow    # commands no rule matches run freely (keep routine work fast)

# Extra global rules beyond the catalog go here. Example:
# rules:
#   - id: no-prod-ssh
#     match: { tool: Bash, command_regex: "ssh ", target_in: production }
#     action: escalate
#     severity: high
rules: []
`

export const SEED_PRODUCTION_YAML = `# Production protected resources.
#
# The catalog rules reference \`target_in: production\`, so DECLARING this set is
# what arms them. \`resolve_env: true\` expands $VAR / \${VAR} and reads .env* in
# the workspace before matching — so \`--shadow-database-url $DATABASE_URL\` is
# caught even though the literal string "production" never appears in the command
# (this is exactly the 2026-07-21 incident class).
protected_resources:
  production:
    resolve_env: true
    db_urls:
      - "\${PROD_DATABASE_URL}"
    hosts:
      - "api.hackathonat.com"
      - "185.164.25.107"
    # buckets:
    #   - "my-prod-uploads"
    # contexts:            # k8s contexts, droplet ids, cluster names
    #   - "do-fra1-prod"

# Production-only rules beyond the catalog:
rules: []
`

export const SEED_CODER_AGENT_YAML = `# Per-agent override for coder-agent. Top-level rules here are auto-scoped to
# this agent (the filename names it). coder agents never touch production.
rules:
  - id: coder-no-prod
    match:
      target_in: production
    action: deny
    severity: critical
    message: "coder-agent is not permitted to run commands against production."
`

export interface SeedFile {
  relPath: string
  content: string
}

export const SEED_FILES: SeedFile[] = [
  { relPath: "policy.yaml", content: SEED_POLICY_YAML },
  { relPath: "environments/production.yaml", content: SEED_PRODUCTION_YAML },
  { relPath: "agents/coder-agent.yaml", content: SEED_CODER_AGENT_YAML },
]
