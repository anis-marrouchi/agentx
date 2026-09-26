# How AgentX fits together

Start with [the visual workflow tutorial](../tutorials/first-workflow.md). This page explains what happens behind the controls you used.

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
| Routing, daemon API, channel lifecycle | `src/daemon/` |
| Agent runtimes | `src/agents/`, `src/agent/` |
| Workflow engine and editor | `src/workflows/`, `src/web/workflow-editor/` |
| Typed decisions and backend adapters | `src/decisions/` |
| Computer perception and verification | `src/computer-use/` |
| Native desktop app and helper | `apps/mac-voice/`, `apps/mac-helper/` |
| Peer tasks and standalone A2A | `src/a2a/` |

Continue to [Jev](jev.md), [A2A](../reference/a2a.md), or the [terminal command reference](../reference/cli.md).

## Check it worked

You can follow one request through the parts above:

1. Send an agent a short message from any entry point (for example **Test drive** in **Settings** › **Agents**).
2. **Browser:** open **Live** while it runs; the agent shows as working.
3. **Browser:** open **Activity** afterwards; the run is recorded with its channel and agent.
4. **Browser:** open `/admin/health` and select **Routing** to see which agent the daemon chose for it.

## If something is wrong

- **The dashboard loads but nothing runs:** the dashboard and the daemon are separate programs. Run `agentx daemon status`, then follow [It's not answering](../help/its-not-answering.md).
- **Work meant for another machine never arrives:** check the pairing with `agentx mesh list` (each peer should show `healthy`). See [Add a second machine](../jobs/second-machine.md).
