# OSS maintainer fleet

**Maintainer burnout is triage, not code.** Run a `@triage` agent on your GitHub webhooks — labels, duplicate detection, missing-repro asks, security flagging — and a `@repro` agent that attempts minimal reproductions in a scratch checkout. You keep the merge button; Monday brings a stale-sweep digest to your Telegram.

## Why this shape

- **Triage without takeover.** `@triage` never closes issues; the stale sweep is a digest to you, not an action. First-time reporters get a warmer tone.
- **Repro as a service.** `@repro` reports exact steps and environment as comment drafts — it never pushes code or opens PRs.
- **Security-aware.** Vulnerability-sounding reports are flagged for private handling instead of public replies.
- **Scales across repos.** One `"repo": "*"` route covers your whole account; per-repo routes override where a project needs a different agent.

## Start

Ready-to-run config: [`examples/maintainer-fleet/`](https://github.com/anis-marrouchi/agentx/tree/master/examples/maintainer-fleet)

```bash
cp examples/maintainer-fleet/agentx.json agentx.json
# .env: GITHUB_TOKEN (fine-grained, issues:write), GITHUB_WEBHOOK_SECRET, TG_BOT_TOKEN
mkdir -p workspaces/{triage,repro}
agentx daemon start
```

Point your repos' webhooks (issues, issue_comment, pull_request) at the daemon — receiver + signing setup in [journey ch. 5](../journey/05-hooks-webhooks.md).

## Grow

- Heavy repro jobs on a beefier meshed machine → [mesh federation](../journey/08-mesh-federation.md)
- Triage knowledge compounds (flaky tests, common misconfigs) → [shared wiki](../journey/06-shared-wiki.md)
