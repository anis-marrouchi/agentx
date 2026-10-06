# OSS maintainer fleet

Maintainer burnout is triage, not code. This pattern runs a **@triage** agent on your GitHub webhooks (labels, duplicates, missing-repro asks, security flags) and a **@repro** agent that attempts minimal reproductions in a scratch checkout — with the weekly stale-sweep digest landing in your Telegram, and *you* keeping the merge button.

Guardrails built into the prompts:

- @triage never closes issues; the stale sweep is a digest to you, not an action.
- @repro never pushes code or opens PRs — it reports repro steps as comment drafts.
- Security-sounding reports get flagged for private handling, not public replies.

## Run it

```bash
cp examples/maintainer-fleet/agentx.json agentx.json
cat >> .env <<'EOF'
GITHUB_TOKEN=ghp-...            # fine-grained, issues:write on your repos
GITHUB_WEBHOOK_SECRET=...
TG_BOT_TOKEN=...
EOF
mkdir -p workspaces/{triage,repro}
# edit agentx.json: replace @REPLACE-WITH-YOUR-USERNAME with your Telegram username
agentx daemon start
```

Before `agentx daemon start`, put your own Telegram username in `agentx.json`: replace `@REPLACE-WITH-YOUR-USERNAME` under `channels.telegram.policy.allowFrom` with yours (for example `@jane_doe`). The bot ignores every message from anyone not on that list ([Connect Telegram](../../docs/connect-telegram.md#4-allow-people-to-talk-to-the-bot)).

Point your repos' webhooks (issues, issue_comment, pull_request) at the daemon — see the [GitHub channel settings](../../docs/reference/config-channels.md#github) for the receiver + signing setup.

## Grow it

- Run @repro on a beefier machine and mesh it in ([add a second machine](../../docs/jobs/second-machine.md))
- Let triage knowledge compound into a wiki (known flaky tests, common misconfigs) ([approve lessons for the shared wiki](../../docs/jobs/agent-memory.md#7-approve-the-lessons-proposed-for-the-shared-wiki))
