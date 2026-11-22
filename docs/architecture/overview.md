# How AgentX fits together

Start with [the visual workflow tutorial](../tutorials/first-workflow.md). This page explains what happens behind the controls you used.

![One Telegram message in nine steps: the Telegram channel receives it, the router picks the agent and records why, the run waits for a free slot, the agent's engine runs and calls AgentX tools, the reply goes back to Telegram, and the open work, events and history are kept for the dashboard. Each step names its src/ folder; a message for an agent on another machine goes over the mesh.](/diagrams/message-path.svg)

## Follow one message

The picture follows one Telegram message from arrival to reply. Each step names the folder under `src/` that does it. The words are explained in the [glossary's code section](../reference/glossary.md#words-in-the-code).

1. **Arrives.** The Telegram adapter (`src/channels/telegram.ts`) receives the update and turns it into one message shape that every channel shares.
2. **Routed.** The router (`src/channels/router.ts`, `routeMessage`) is the one path for every channel.
3. **Decided.** The router reads the chat's situation (`src/situations/`) to see whether the message needs an answer, picks the agent, and writes the choice and its reason in the intent ledger (`src/intent/`). If the agent lives on another machine, the mesh (`src/a2a/`) sends the message there instead.
4. **Waits.** When the machine is busy, the run waits in the admission queue (`src/admission/`). A long wait posts a short note in the chat.
5. **Runs.** The agent's engine runs the turn (`src/agents/runtime.ts`, `executeTask`): Claude Code, Codex, OpenCode, the SDK or the orchestrator. Its conversation is kept per chat (`src/agents/sessions.ts`).
6. **Uses tools.** During the turn the agent calls AgentX tools over MCP (`src/mcp/`): `agentx_request` to track the owner's request, `agentx_send` to message another channel, and others.
7. **Replies.** The router sends the reply back through the same adapter, to the same chat.
8. **Tracked.** Requests, tracked plans and promises stay open in `src/requests/` until they are done.
9. **Kept.** Events (`src/events/`) and run history (`src/storage/`) feed the dashboard pages (`src/daemon/ui/`).

Around this path: schedules and jobs start work without a message (`src/crons/`, `src/jobs/`), workflows run saved steps (`src/workflows/`), the wiki and memory hold what agents know (`src/wiki/`, `src/memory/`), and AgentX Voice is the Mac app you speak to (`apps/mac-voice/`, `src/voice/`).

## 1. You choose an entry point

A request can arrive through Telegram, a webhook, a schedule, the dashboard, the OpenCode-backed terminal UI, or the desktop assistant. Each entry point supplies a message and context, such as the agent, conversation, or current dashboard page.

## 2. The daemon routes the work

The daemon loads `agentx.json`, connects channels, and dispatches tasks to configured agents. Each agent has its own role, workspace, runtime, and tools. A workflow can coordinate several steps. A *mesh peer* (another machine running AgentX that this one is paired with) can run work there.

```text
Desktop / dashboard / terminal / channels
                     │ request + context
                     ▼
               AgentX daemon ───────► mesh peer's daemon
                     │                         │
                     ▼                         ▼
              configured agent          remote agent
                     │
              model runtime + tools
                     │
                     ▼
           response, events, task history
```

The browser dashboard is a separate server connected to the daemon. A working dashboard page does not prove its daemon or model connection is healthy. [Docker installation](../install.md) starts both services.

## 3. Models and tools have different jobs

The agent runtime handles an open-ended task: interpreting a request, generating a reply, and using available tools. Optional typed decision calls answer smaller questions at specific points in the code. [Jev and decision seats](jev.md) explains these calls and how to inspect them.

On macOS, the native helper reads accessibility information and can use OCR (reading text from the screen image), point at controls, click, or type. A vision model can describe captured pixels. These capabilities are separate: having a voice interface does not mean every request needs a screenshot or a computer action.

## 4. Evidence comes back with the result

Use **Activity** for past runs, **Live** for current work, and **Monitor** for reviews. For computer-use tasks, inspect the observed result as well as the command exit status. The [Screen Studio case](../tutorials/record-vscode.md) explains why that distinction matters.

## 5. Before the main model runs

The typed `request-gate` decision evaluates whether a new request benefits from Jev preprocessing. When active and affirmative, `request-context` selects optional context from a structured catalogue before the prompt is rendered. Mandatory instructions and same-chat continuity are preserved. Desktop requests always retain the assigned agent model. See [request intake and context selection](./jev.md#request-intake-and-context-selection) for the contract and fallback behavior.

## Where to read the implementation

| Part | Source directory |
|---|---|
| Channel adapters and the message router | `src/channels/` |
| Daemon API, config loader, dashboard pages | `src/daemon/` |
| Situations and the intent ledger | `src/situations/`, `src/intent/` |
| Admission queue | `src/admission/` |
| AgentX tools for agents (MCP) | `src/mcp/` |
| Requests, tracked plans, promises | `src/requests/` |
| Agent runtimes | `src/agents/`, `src/agent/` |
| Workflow engine and editor | `src/workflows/`, `src/web/workflow-editor/` |
| Typed decisions and backend adapters | `src/decisions/` |
| Computer perception and verification | `src/computer-use/` |
| Native desktop app and helper | `apps/mac-voice/`, `apps/mac-helper/` |
| Peer tasks and standalone A2A | `src/a2a/` |
| The AX symbol behind every app icon | `src/brand/ax-symbol.ts` |

Every AgentX icon is drawn from one source, the AX symbol in `src/brand/ax-symbol.ts`. The dashboard, the phone app and the member page draw theirs from it when asked. The Android, iPhone, Mac and Raycast icons are files written from it by `npx tsx scripts/gen-icons.ts`, and the test suite fails if one of them no longer matches. To change the mark, edit that source and rerun the script.

Continue to [Jev](jev.md), [A2A](../reference/a2a.md), or the [terminal command reference](../reference/cli.md).

## Check it worked

You can follow one request through the parts above:

1. Send an agent a short message from any entry point (for example **Test drive** in **Settings** › **Agents**).
2. **Browser:** open **Live** while it runs; the agent shows as working.
3. **Browser:** open **Activity** afterwards; the run is recorded with its channel and agent.
4. **Browser:** in the Hub, open **Settings** › **Diagnostics** and select **Routing** to see which agent the daemon chose for it.
5. **Browser:** the dashboard's tab shows the AX symbol, and `/favicon.svg` opens it on its own.

## If something is wrong

- **The dashboard loads but nothing runs:** the dashboard and the daemon are separate programs. Run `agentx daemon status`, then follow [It's not answering](../help/its-not-answering.md).
- **An app shows an older icon:** run `npx tsx scripts/gen-icons.ts --check`. It names any icon file that no longer matches the source; run it without `--check` to rewrite them. Phones and browsers keep icons for a while, so reinstall the app or clear the page's site data to see the new one.
- **Work meant for another machine never arrives:** check the pairing with `agentx mesh list` (each peer should show `healthy`). See [Add a second machine](../jobs/second-machine.md).
