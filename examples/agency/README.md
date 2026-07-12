# Agency — one agent per client

An agency pattern: **one agent per client account**, each with its own workspace and a **project-scoped GitLab token** (never an account-wide PAT), plus a **@pm** agent that assigns work and compiles the per-client weekly with cost figures.

Why this shape:

- **Blast-radius isolation** — @acme-dev physically cannot touch Globex repos: different workspace, different token, prompt-level refusal as the last line.
- **Per-client cost accounting** — the usage dashboard breaks token spend down by agent = by client, so you can bill or budget it.
- **GitLab mentions route to the right agent** — `@acme-bot` on an ACME MR wakes @acme-dev with ACME's token.

## Run it

```bash
cp examples/agency/agentx.json agentx.json
cat >> .env <<'EOF'
TG_BOT_TOKEN=...
GITLAB_WEBHOOK_SECRET=...
GITLAB_TOKEN_ACME=glpat-...     # project-scoped to ACME's group
GITLAB_TOKEN_GLOBEX=glpat-...   # project-scoped to Globex's group
EOF
mkdir -p workspaces/{acme,globex,pm}
agentx daemon start
```

## Grow it

- Move a client's agent to a dedicated node and mesh it in ([mesh federation](../../docs/journey/08-mesh-federation.md))
- Kanban per client with two-way GitLab sync ([boards](../../docs/reference/boards.md))
- Time-bound scoped API tokens for client-side integrations ([tokens](../../docs/reference/tokens.md))
