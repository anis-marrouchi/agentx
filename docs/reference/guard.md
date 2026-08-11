# Destructive-action guardrails

A policy layer between an agent's *intent* to run a command and its
*execution*. It exists because an agent ran `prisma migrate diff
--shadow-database-url $DATABASE_URL` against production — a command that
silently drops and recreates whatever the shadow URL points at.

Permissions lists don't catch that. The command is unremarkable; only its
**resolved target** is catastrophic. So the guard resolves targets, not strings.

```bash
agentx guard test "prisma migrate diff --from-migrations --shadow-database-url \$DATABASE_URL"
```

## How it hooks in

Claude Code fires `PreToolUse` before every `Bash`, `Write`, and `Edit` call.
The hook posts the payload to the daemon over loopback, which evaluates policy
in-process (~1ms) and returns a decision.

It runs **in every permission mode, including `bypassPermissions`** — which is
the point. `bypassPermissions` agents are exactly the ones that need a backstop.

The hook is installed automatically into every agent workspace on daemon start
(`setupAllWorkspaces`), and at user scope by
[`agentx attach install`](/reference/attach#the-guard-comes-with-it).

## Modes

```yaml
mode: warn    # .agentx/guardrails/policy.yaml
```

| Mode | Effect |
|---|---|
| `warn` *(default)* | Compute + audit the verdict, then allow anyway. Surfaces a `would deny` line to the operator |
| `enforce` | Honour it — `deny` blocks, `escalate` asks |
| `off` | Kill switch |

Ship on `warn`, read `agentx guard log` until the false-positive rate is
acceptable, then flip to `enforce`.

## Policy

Three layers, deep-merged (most specific wins), on top of a built-in catalog
that is always applied underneath:

```
.agentx/guardrails/
├── policy.yaml              # global
├── environments/<env>.yaml  # per environment
└── agents/<id>.yaml         # per agent
```

Policy is read **live** on every tool call — edits take effect on the next
command, with no daemon restart.

### Protected resources

The catalog knows destructive *verbs*. It does not know which hosts are yours.
Rules that say `target_in: production` only bite once you declare what
production is:

```yaml
protected_resources:
  production:
    db_urls:
      - "postgres://…@db.example.com:5432/app"
    hosts: ["api.example.com"]
    resolve_env: true   # expand $VAR and .env* before matching
```

`resolve_env` is what catches the incident case: the command said
`$DATABASE_URL`, and only after expansion is it visibly production.

### Rules

```yaml
rules:
  - id: coder-never-touches-prod
    match:
      tool: Bash
      target_in: production
    action: deny
    severity: critical
    message: "The coder agent has no business touching production."
    applies_to:
      agents: [coder-agent]
```

`match` fields are ANDed. Actions in precedence order: `deny` > `escalate` >
`warn` > `allow` — an explicit `deny` can never be downgraded by a
lower-priority match.

### Built-in catalog

| Rule | Action |
|---|---|
| `prisma-shadow-against-prod` | deny |
| `prisma-reset-or-force-push-prod` | deny |
| `prisma-migrate-deploy-prod` | escalate |
| `raw-sql-destructive-prod` | deny |
| `db-drop-or-clean-restore-prod` | deny |
| `fs-recursive-delete` | deny |
| `container-volume-destroy` | deny |
| `infra-destroy` | escalate |
| `git-force-push` | escalate |

All of it is data — override, retune, or disable any entry from your own YAML.

## Failure behaviour

Two different postures, deliberately:

- **The hook layer fails open.** A crashing guard must not brick every agent
  command. Internal errors log to stderr and allow.
- **The engine fails closed** (`defaults.fail_mode: closed`). An error while
  judging a command that touches a protected resource yields a `deny`.

The guard never exits non-zero. Blocking is expressed as a JSON decision on
stdout so the reason reaches the model cleanly.

## Commands

| Command | What it does |
|---|---|
| `agentx guard test "<command>" [--agent <id>] [--env <name>]` | Dry-run through the engine and print the verdict |
| `agentx guard log [--limit <n>]` | Read the audit trail |
| `agentx guard policy` | Show the resolved, merged policy |
| `agentx guard init` | Scaffold `.agentx/guardrails/` |
| `agentx guard reload` | Ping the daemon to drop its policy cache |
| `agentx guard check` | The `PreToolUse` entrypoint (stdin → stdout). Not for humans |

Every decision — allowed, warned, denied — is written to `guardrail_decisions`
in SQLite. That table is the evidence for whether `enforce` is safe yet.

## Status

Phase 0 + Phase 1 shipped, running in `warn` mode. `escalate` and
`preconditions` (e.g. `fresh_backup(production)`) are carried through the
schema so intent-ledger approvals and backup gates slot in without a schema
change.
