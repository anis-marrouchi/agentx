---
title: "Nodes everywhere"
---

# Nodes everywhere (#781)

> **Status:** proposal. Nothing on this page is decided until the owner says yes.
> **Owner rule (voice, 2026-10-07):** Dev Session owns this direction. The owner approves any change of direction. Nothing that changes direction is merged or deployed without his yes.
> **What counts as a change of direction:** a new surface (a new app, extension or channel), a new way in for a person or machine, a change to who can reach what, or dropping a surface that ships today. Finishing, fixing or documenting a surface that already ships is not.
> **Source:** [#781](https://github.com/anis-marrouchi/agentx/issues/781). This note holds the plan; the issue holds the discussion.

## Goal

AgentX should be reachable and useful from wherever people already work: chat apps, the phone, the Mac, the browser, the editor and other AI assistants. Each place connects to a **node** (one AgentX daemon on one machine). Nodes connect to each other through the **mesh** (paired daemons that pass work between them).

The test for every item below: a person stays in the place they already are, reaches the right agent on the right node, and can later see what happened in the dashboard.

## Rules every surface follows

1. **A surface is thin.** It talks to one node over that node's existing HTTP API (`/task`, `/agents`, `/app/*`, `/v1/chat/completions`). It holds no agent logic, no schedule and no copy of the fleet. Work that belongs on another machine travels over the mesh, not through the surface.
2. **One way in per kind of visitor.** Every surface maps to a row of [Who gets which way in](../../docs/jobs/keep-it-safe.md#who-gets-which-way-in): your own phone, your own machine, a teammate, a guest organisation, a client. A surface that needs a sixth row is a change of direction.
3. **Private network by default.** A surface reaches its node over Tailscale or `localhost`, never the public internet. Chat apps are the exception because the provider relays the message; their allowlists stay closed by default.
4. **Bounded answers.** List views return short summaries. Full prompts, responses and errors open on demand, on the node that owns them.
5. **Reuse, don't fork.** Each surface reuses the fleet snapshot, task pages, agent pages and peer discovery. No surface gets its own model of tasks or agents.
6. **Shows up in the record.** Work that starts on a surface is a normal task with its channel recorded, so Live, Activity and Monitor show it like any other.

## Where AgentX is today

| Place | Ships today | Gap |
|---|---|---|
| **Chat apps** | Telegram and WhatsApp channels, with per-account agent binding and allowlists. WhatsApp triage. GitHub and GitLab as work channels. ntfy and Web Push for alerts. | Discord: a setup helper exists in `src/connect/discord.ts` but is not wired into `agentx connect` and there is no channel. Slack: named in router code, no channel. No channel reference page for either. |
| **Phone** | Phone web app at `/app` (Chat, Fleet, Activity, Alerts), paired with `agentx app pair`. Android shell (`apps/android`) and Flutter shell (`apps/phone`) for place reminders. Browser calls (WebRTC). | iPhone shell exists in source but is not built or tested. No store builds, by design for now. |
| **Mac** | Desktop assistant (`apps/mac-voice`, `apps/mac-helper`): floating widget, voice, computer use, `agentx desktop install`. Raycast extension (Ask Agent, List Agents, Open Dashboard). | Raycast talks to the local node only; no peer picker. No menu-bar status of the fleet outside the desktop widget. |
| **Browser** | Dashboard: Live, Activity, Monitor, Workflows, Settings, in-page chat, operations view. | No way to hand the current page to an agent without copy and paste. |
| **Editor** | `agentx attach as` / `attach watch` for a Claude Code session. `agentx tui` (OpenCode v2 with AgentX agents as models). `agentx serve --stdio` MCP server for Claude Code, Cursor, Windsurf. | Some wiki and skill commands are CLI only (see [What's next](./whats-next.md)). MCP client compatibility not swept across editors. |
| **Other AI assistants** | MCP server. OpenAI-compatible endpoint (`/v1/chat/completions`, `/llm/:agentId/v1/chat/completions`). Standalone A2A server (`agentx a2a`). | No single page saying which assistant connects which way. A2A is marked **Advanced** and has no end-to-end guide with a third-party agent. |
| **Between nodes** | Mesh pairing (Tailscale), cross-node tasks, guest mesh grants, members and clients pages, mesh-level operations view. | No stable root activity ID across mesh hops (also a known risk in [CLAUDE.md](../../CLAUDE.md)). No RBAC at mesh or agent level. Engines on another node decided but not built ([#445](./engines-remote-node.md)). |

## Plan

Three stages. Each stage closes before the next opens. Items marked **(direction)** need the owner's yes before work starts; the rest are finishing work on surfaces that already ship.

### Stage 1: make what ships reachable and trustworthy

The goal is that every surface in the table above works from a fresh install, is documented end to end, and shows up correctly in the dashboard.

1. **Surface map page.** One docs page, "Reach your agents from anywhere", with one row per place: what to install, which way in it uses, and a link to its page. Ends with **Check it worked** and **If something is wrong**.
2. **Provenance on every task.** Each task records the surface it came from (channel, app, desktop, Raycast, MCP, OpenAI-compatible, A2A, mesh peer) in the existing task record, and Live / Activity show it. This is the "ongoing activity provenance" piece of the mesh overview.
3. **Root activity ID across mesh hops.** One ID created where the work enters and carried by every forward, so a task started on a phone and finished on a second machine is one thread in Activity. Prerequisite for anything in stage 2 that crosses nodes.
4. **Raycast peer picker.** Raycast lists agents from the fleet snapshot, not only the local node, and sends the task to the local node, which forwards it over the mesh.
5. **MCP compatibility sweep.** Check `agentx serve --stdio` in Claude Code, Cursor, Windsurf and Zed; fix or document each gap. Expose the remaining CLI-only wiki and skill commands that are safe to expose.
6. **Assistants page.** Document which other AI assistant connects through MCP, the OpenAI-compatible endpoint or A2A, with one worked example each, using neutral names.

### Stage 2: new places, one at a time

Each item is its own child issue, its own owner yes, and its own docs page in the same PR.

1. **(direction) Discord channel.** Finish `agentx connect discord`, add a channel adapter with the same `allowFrom` and `agentBinding` rules as Telegram. Smallest new chat surface because the setup helper exists.
2. **(direction) Slack channel.** Same shape as Discord. Needs a decision on workspace apps versus a single bot token.
3. **(direction) iPhone shell.** Build and test the iPhone target of `apps/phone` so place reminders work on iPhone. No store listing unless the owner decides otherwise.
4. **(direction) Browser extension.** "Send this page to an agent": the extension posts the URL and selected text to the node over the private network, using a phone-style key tied to the browser profile. No page content leaves without a click.
5. **(direction) Editor extension.** A VS Code panel that shows the fleet and lets you send the selection or the open file to an agent. Wraps the same HTTP API as Raycast; no agent logic in the extension.

### Stage 3: nodes for other people

These widen who can reach a node, so each is a change of direction and depends on RBAC.

1. **(direction) RBAC at mesh and agent level.** Roles for who can reach which node and agent and what they may do. Today's README lists this as missing; [What's next](./whats-next.md) parks it until a second operator shares a deployment. This roadmap asks the owner whether "nodes everywhere" is that trigger.
2. **(direction) A teammate's own node.** A teammate installs AgentX, joins with a scoped grant rather than the mesh password, and reaches shared agents from their own surfaces. Builds on guest grants and on [#445](./engines-remote-node.md) for engines.
3. **(direction) Surfaces for guests and clients.** Decide which surfaces (chat app, phone, browser) a guest organisation or a client may use, and through which existing way in.

## Explicitly not in this roadmap

- **Hosted / SaaS AgentX.** Self-hosted by design ([What's next](./whats-next.md)).
- **App store listings** for phone or desktop, until the owner asks.
- **Surfaces that need the public internet** to reach a node.
- **A second model of tasks, agents or fleet** inside any surface.

## Decisions needed from the owner

1. Is the surface list right: chat apps, phone, Mac, browser, editor, other AI assistants? Anything to add or drop (for example Windows or Linux desktop)?
2. Approve stage 1 as finishing work that Dev Session can merge without a further yes per PR?
3. In stage 2, which new place comes first? The proposal is Discord, then the browser extension.
4. Is "nodes everywhere" the trigger to unpark RBAC (stage 3), or does it stay parked?

## Proposed child issues

Opened only after the owner answers the decisions above.

| Stage | Issue |
|---|---|
| 1 | Surface map docs page |
| 1 | Record and show the surface each task came from |
| 1 | Root activity ID carried across mesh hops |
| 1 | Raycast: agents from the whole fleet |
| 1 | MCP client compatibility sweep |
| 1 | Docs: connect another AI assistant |
| 2 | Discord channel |
| 2 | Slack channel |
| 2 | iPhone shell build and test |
| 2 | Browser extension: send this page to an agent |
| 2 | VS Code extension: fleet panel and send selection |
| 3 | RBAC design note |
