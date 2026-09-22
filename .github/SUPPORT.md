# Getting help with AgentX

AgentX is usable but experimental. Settings and configuration flows still need polish. Community support is best effort; there is no response-time or production-availability guarantee.

## Choose the right place

- **Questions and setup advice:** [Discussions](https://github.com/anis-marrouchi/agentx/discussions). Search existing answers first.
- **Installation failures:** use the [installation report](https://github.com/anis-marrouchi/agentx/issues/new?template=installation.yml).
- **Reproducible bugs:** use the [bug report](https://github.com/anis-marrouchi/agentx/issues/new?template=bug_report.yml).
- **Ideas:** describe the use case in a [feature request](https://github.com/anis-marrouchi/agentx/issues/new?template=feature_request.yml). A request is not a delivery commitment.
- **Vulnerabilities or leaked credentials:** follow [SECURITY.md](../SECURITY.md); do not report details publicly.

Include your version, OS, installation method, exact reproduction steps, expected result, and actual result. Attach only relevant, redacted logs. `agentx doctor --json` helps diagnose setup, but its output is **not guaranteed anonymized**: inspect paths, hostnames, account names, and messages before sharing. Never upload `.env`, tokens, whole config files, or private conversations.

## Supported setup and verification

| Component | Current requirement / scope |
| --- | --- |
| Runtime | Node.js 22.x; other major versions are outside the supported range |
| Source development | pnpm 10; see CONTRIBUTING.md |
| npm | Package `agentix-cli`, executable `agentx`; use 0.28.0 or later (0.27.0 has broken packaging) |
| Linux and macOS | Primary CLI environments; package smoke workflow records what has actually passed |
| Windows | Native operation is not currently a tested support target; try a Linux environment and report limitations |
| Desktop voice/computer use | macOS-specific; requires native build tools and OS permissions |
| OpenCode TUI | Requires a compatible OpenCode installation; see the TUI guide for installation and fallback behavior |
| Model access | Your chosen provider or authenticated CLI; subscriptions and API billing depend on that provider |
| Shared deployments | Trusted operators/private networks; complete mesh-level and agent-level RBAC is still missing |

See [component prerequisites](../docs/requirements.md) and [troubleshooting](../docs/help/its-not-answering.md). Passing CLI smoke tests does not certify every provider, desktop permission flow, or production load level.

## Upgrades and recovery

Read the changelog before upgrading. Back up configuration and runtime storage before migrations. Record your working version; `npm install -g agentix-cli@<version>` pins it. Rolling back a binary does not necessarily reverse storage migrations: restore a compatible backup when needed. Do not downgrade to the broken 0.27.0 npm package.

Testing and clear reports are our first contribution priority. Maintainers batch non-urgent triage; repeated comments and private messages do not increase priority.
