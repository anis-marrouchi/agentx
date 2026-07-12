# Agency — one agent per client

**Run client work as isolated agents with per-client cost accounting.** Each client gets its own agent, workspace, and project-scoped GitLab token; a `@pm` agent assigns work and compiles the Friday per-client summary with token costs from the usage dashboard.

## Why this shape

- **Blast-radius isolation.** `@acme-dev` physically cannot touch Globex: separate workspace, separate scoped token, prompt-level refusal as the last line — three independent layers.
- **Cost per client.** Token spend is tracked per agent, so per-client billing/budgeting falls out of the [usage dashboard](../playbooks/tier2-billing.md) for free.
- **GitLab-native routing.** A mention of `@acme-bot` on an ACME MR wakes the ACME agent with ACME's token — including across mesh nodes if that client's agent lives on a dedicated machine.

## Start

Ready-to-run config: [`examples/agency/`](https://github.com/anis-marrouchi/agentx/tree/master/examples/agency)

```bash
cp examples/agency/agentx.json agentx.json
# .env: TG_BOT_TOKEN, GITLAB_WEBHOOK_SECRET, GITLAB_TOKEN_ACME, GITLAB_TOKEN_GLOBEX
mkdir -p workspaces/{acme,globex,pm}
agentx daemon start
```

## Grow

- One node per big client, meshed → [mesh federation](../journey/08-mesh-federation.md)
- Kanban per client, two-way GitLab sync → [boards](../reference/boards.md)
- Time-bound scoped tokens for client integrations → [tokens](../reference/tokens.md)
