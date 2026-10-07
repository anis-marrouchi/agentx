---
title: "Nodes everywhere"
---

# Nodes everywhere (#781)

> **Status:** proposal. Nothing here gets built before Anis picks the order.
> **Owner:** Dev Session. Anis approves any change of direction (voice brief, 2026-10-07).
> **Checked against:** `main` at `7203318` (2026-10-07).
> **What counts as a change of direction:** a new surface (a new app, extension or channel), a new way in for a person or machine, a change to who can reach what, or dropping a surface that ships today. Finishing, fixing or documenting a surface that already ships is not.

## 1. Where we are

| Surface | Works today | Partial or missing |
|---|---|---|
| **MCP server** (`src/mcp/index.ts`, `agentx serve --stdio`) | Claude Code, Cursor and Windsurf on the same machine can use 29 tools: send a task to an agent, read recent chats, use the wiki and graph, approvals, schedules, camera, call the owner. | It only speaks stdio, so it only works for apps on the same machine. It has no HTTP transport and no OAuth, so ChatGPT and Claude.ai cannot add it as a connector. It sends no token, so it can't use a protected daemon on another machine. If no address is set it falls back to `localhost:19900`, but the daemon's default port is `18800`. It speaks protocol version `2024-11-05`. The docs cover it in one line. |
| **Attach mode** (`src/attach`) | A Claude Code session that is already open can answer as an agent. Hooks in `~/.claude/settings.json` deliver the messages. If the session doesn't claim a message within 90 s, the daemon runs the agent the usual way. | Claude Code only. One waiting message per session. It only works on the same machine (loopback). |
| **Raycast** (`integrations/raycast`, #146) | Ask Agent, List Agents, Open Dashboard. It can use a token to reach a daemon on another machine. | Not published to the Raycast Store. Replies don't stream. It lists this node's agents only. No tests. |
| **OpenCode** (`agentx tui`, `src/daemon/openai-compat.ts`) | OpenCode v2 can use AgentX agents as models. OpenCode can also be the engine an agent runs on. The `/v1` endpoint follows the OpenAI format, so any app that can talk to OpenAI can talk to an agent. | No OpenCode plugin. OpenCode's own tools are not passed through. |
| **Android** (`apps/android`, Kotlin app that opens the web app in Chrome) | Pairing with a one-time code, place reminders through the phone's own location watching, notifications (also through a relay node, #711), and camera and voice through the web app. | Release builds need our own signing key. The device test is still open (#681). |
| **Phone app in Flutter** (`apps/phone`, #676) | Android builds with the same features as the Kotlin app. | iOS is scaffolded but has never been built or tested. On iPhone, Safari allows at most 20 places. |
| **Mac** (`apps/mac-voice`, `apps/mac-helper`) | Push-to-talk voice (⌥Space) with spoken answers, calls and meetings. The helper uses the screen, the keyboard and the pointer for computer use. | Needs Apple Silicon and macOS 14. Voice only talks to the daemon on the same Mac. |
| **Mesh** (`src/a2a`) | Tasks go between machines (`/mesh/task`). Messages wait while a peer is down. Background delegation sends the answer back later. Joining uses an invite link (`agentx connect mesh invite`), and peers use bearer tokens. | Peers are listed by hand; nodes don't find each other. A node without a token still lets requests through with a warning (a grace period). An agent can't yet use another node's engine (#445): that is decided but not built. |
| **Guest meshes** (`src/guests`) | One agent is opened to another organisation, limited to chosen folders and skills, with a level and an end date. Joining needs a code and the host's approval. The grant can be paused, changed or ended. | Works as designed. |
| **Chat channels** (`src/channels`) | Telegram, WhatsApp, GitHub, GitLab, Web Push, ntfy, and WebRTC calls. | Discord has a setup helper (`src/connect/discord.ts`), but `agentx connect` doesn't offer it, and there is no message adapter. Slack and Discord exist only as inbound webhook sources and channel names. No email. |
| **Browser or VS Code extension** | None. | Nothing in the repo. |

**In short:** where AgentX runs on your own machine, or you can reach it over Tailscale, it already shows up in most places: chat, phone, Mac, terminal and IDE. What's missing is reach outside that: other people's AI assistants, the browser, and team chat (Slack).

## 2. The vision

Every place you work is a door into the same AgentX. A **node** is one machine that runs the daemon. Your nodes and your guests' nodes form one mesh. Any door (a chat, the phone, the Mac, the browser, the editor, ChatGPT or Claude) reaches the right agent on the right node, with the same people, limits and approvals. You never have to open the dashboard to get something done. Build each door once, on a shared standard where one exists.

## 3. Rules every surface follows

1. **A surface is thin.** It talks to one node through that node's existing HTTP API (`/task`, `/agents`, `/app/*`, `/v1/chat/completions`) or the MCP tools. It holds no agent logic, no schedule and no copy of the fleet. Work that belongs on another machine travels over the mesh, not through the surface.
2. **One way in per kind of visitor.** Every surface maps to a row of [Who gets which way in](../../docs/jobs/keep-it-safe.md#who-gets-which-way-in). A surface that needs a new row is a change of direction.
3. **Short answers in lists.** List views return short summaries. Full prompts, responses and errors open on demand, on the node that owns them.
4. **Reuse, don't fork.** Surfaces reuse the fleet snapshot, task pages, agent pages and peer discovery. No surface gets its own model of tasks or agents.
5. **Shows up in the record.** Work that starts on a surface is a normal task that records the surface it came from (channel, app, desktop, Raycast, MCP, OpenAI-compatible, A2A, mesh peer), so Live and Activity can show it.
6. **One ID across hops.** Work gets one root activity ID where it enters, and every mesh forward carries it, so a task started on a phone and finished on another node is one thread in Activity. Today this ID doesn't exist (a known risk in [CLAUDE.md](../../CLAUDE.md)); rules 5 and 6 are prerequisites for any surface that reaches another node.

Letting other people run their own nodes, or reach agents beyond guest grants, also needs role-based access control (RBAC) at mesh and agent level. The README lists RBAC as missing. Any such step is a change of direction.

## 4. Next surfaces, ranked

Effort: S = a few days, M = 1 to 2 weeks, L = 3 weeks or more, one developer seat.

| # | Surface | Value | Effort | Why this rank |
|---|---|---|---|---|
| 1 | **MCP connector**: the current server over remote HTTP, with OAuth | Very high | M–L | One build works in Claude (Desktop and claude.ai), ChatGPT, Cursor, VS Code and Windsurf. The 29 tools already exist. What's missing is the transport, the sign-in and a public address. Check each app's current requirements before building. |
| 2 | **A public address for a node** (one command, for example `agentx node expose`) | High (needed by #1, #3 and #4) | S–M | Today only Tailscale reaches a node from outside. The connector needs a public HTTPS address. Phones and extensions get simpler with one too. |
| 3 | **Slack channel** | High for teams | M | Teams work in Slack. The inbound path is shared, so a new channel is mostly an adapter (as Telegram was). |
| 4 | **Chrome extension** | High | M | The browser is where most non-developers work. A side panel would let you ask an agent about the page you're on, send it the selected text or the page, and approve requests. It would pair the same way the phone does (`app` token), so it needs no new sign-in. |
| 5 | **Finish what is built**: Raycast Store, iOS build, Discord adapter | Medium | S each (iOS M) | Cheap reach. iOS needs an Apple developer account. |
| 6 | **VS Code extension** | Medium–low | M | Once #1 ships, VS Code gets AgentX through its own MCP support. Claude Code users are already covered by attach mode. A thin extension (status, approvals, send selection) is only worth it if people ask for it. |
| 7 | **Email channel** | Medium | M | Reaches clients who use neither chat nor apps. |

## 5. First three steps

1. **Fix the local MCP server** (S, normal PR, no change of direction). Send the daemon token so a protected node works. Fix the `19900` default. Move to the current protocol version. Add tool sets: a read-only set and a full set. Write a proper setup page for Claude Code, Cursor, VS Code and Windsurf.
2. **Remote MCP inside the private network first** (M). Serve MCP over streamable HTTP from the daemon, with the node's scoped tokens (`agentx token create`). Prove it from Claude Desktop, Cursor and VS Code on a second machine over Tailscale. Nothing is exposed to the internet yet.
3. **The public connector** (M). Add OAuth sign-in and a public address (decision D2). Every action that writes something goes through Approvals. Then add it as a custom connector in Claude and in ChatGPT.

Step 1 can start under the normal rules. Steps 2 and 3 wait for the picks below.

## 6. Decisions needed from Anis

- **D1. Order.** Do you agree with the ranking above: connector first, Slack and Chrome next, VS Code later?
- **D2. Public address.** How does a node get one?
  - (a) Tailscale Funnel on each node. Free, and it's the user's own setup.
  - (b) A relay we host on our own domain. Easiest for users, but we run a service and its traffic goes through us.
  - (c) The user's own reverse proxy. Already documented.
  - My suggestion: (a) by default and (c) as an option. Decide on (b) later.
- **D3. What a connector may do.** Read only (wiki, recent chats, agents), or also send tasks to agents? I suggest both, with every write going through Approvals.
- **D4. Who pays.** When someone using ChatGPT or Claude starts a task, which engine runs it, and on whose bill? This ties into the `billing` choice from #445.
- **D5. Accounts.** Do we get an Apple developer account for the iOS build? Do we publish to the Raycast Store and the Chrome Web Store under your name?

## 7. Weekly review

Every Monday I post a short comment on #781 (at most 10 lines), and secretary-agent reads it to you:

- **What moved:** issues and PRs merged or deployed, with links.
- **What is blocked:** and on whom.
- **What I need from you:** each decision with my default, and the date I'll go ahead with that default unless you say otherwise. This never applies to a change of direction: those always wait for your yes.
