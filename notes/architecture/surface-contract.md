# Surface contract

AgentX has three consumer surfaces — **CLI**, **Dashboard UI**, and **MCP server** — and one rule that keeps them honest:

> The CLI is the canonical API. The Dashboard mirrors it. The MCP server speaks the same vocabulary. No surface contradicts another.

This document is the working contract that captures what each surface owes the others, and which carve-outs are intentional.

## The three rules

1. **CLI must expose every capability the daemon supports.** If the daemon can do X, there is a CLI command for X. Power users and automation never need to "fall back" to the dashboard or the MCP server to do something the platform supports.
2. **Dashboard mirrors the CLI** — every CLI capability has a UI counterpart, *except* where exposing it visually has no value or creates a footgun. Carve-outs are listed below and must be justified.
3. **MCP server names match CLI names.** A tool called `agentx_workflow_run` is doing the same thing `agentx workflow run` does, with the same args. AI editors and humans see one product.

## CLI-only carve-outs (and why)

These commands intentionally have no dashboard equivalent:

| CLI command | Why it stays CLI-only |
|---|---|
| `daemon start` / `daemon stop` / `daemon restart` | A "stop daemon" button kills the dashboard process serving it. Use systemd / launchd / shell. |
| `daemon deploy` | CI / automation territory. Click-and-deploy is the wrong UX (no dry-run, no log streaming, no rollback workflow). |
| `serve` (MCP mode) | Daemon mode, not a UX. Run from systemd or `npx agentx serve`. |
| `completion` | Generates shell config files. Not a UI affordance. |
| `init` | Bootstraps `agentx.json` *before* a daemon exists. Use `setup` for the post-init wizard. |
| `migrate` | Schema migrations are rare and irreversible. Keep them gated behind a deliberate terminal action. |
| `db query` | Raw SQL. Exposing arbitrary SQL in the dashboard is a footgun and an audit hazard. |

If you find yourself wanting to build dashboard UI for one of these, push back hard — there's almost always a better fix in the carve-out itself (e.g. `daemon deploy` should grow a `--dry-run` flag rather than become a button).

## Dashboard-only — should not exist

By rule #1, every dashboard capability has a CLI mirror. Drag-drop kanban → `backlog` commands. Visual workflow editor → `workflow show / validate` plus a JSON file. WhatsApp QR → `connect whatsapp` (renders the QR to terminal). Form-fill inbox → `task list / show / submit`.

If you ship a dashboard feature that has no CLI counterpart, you're breaking the contract. Either (a) build the CLI command first, then the UI, or (b) add an entry to the CLI-only carve-out table above with a justification.

## When the CLI lacks something the daemon does

That's a CLI bug. File it. The dashboard is not a license for the CLI to be incomplete.

## When the dashboard lacks something the CLI does

That's a dashboard backlog item, not a carve-out. Either ship the UI or move the CLI command into the carve-out table with a real reason. "Nobody asked for it yet" is not a reason — agentx is small and experimental; if a capability is worth shipping at all, it's worth being discoverable.

## Wave 1 closures

The first parity sweep (May 2026) closed:

- `agentx task list / show / submit` — terminal access to the human-in-the-loop inbox.
- Workflow lifecycle controls in `/workflows` (pause / resume / cancel) — were CLI-only via `agentx workflow pause/resume/cancel`.
- This document.

Subsequent waves track the dashboard-side gaps for actors/roles, hooks, procedures, plugins, references, ledger explorer, wiki write surface, and daemon logs.
