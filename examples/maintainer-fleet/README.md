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
agentx daemon start
```

Point your repos' webhooks (issues, issue_comment, pull_request) at the daemon — see [journey ch. 5](../../docs/journey/05-hooks-webhooks.md) for the receiver + signing setup.

## Grow it

- Run @repro on a beefier machine and mesh it in ([mesh federation](../../docs/journey/08-mesh-federation.md))
- Let triage knowledge compound into a wiki (known flaky tests, common misconfigs) ([shared wiki](../../docs/journey/06-shared-wiki.md))
