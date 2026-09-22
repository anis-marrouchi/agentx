# AgentX in the OpenCode TUI

`agentx tui` opens OpenCode v2 with an AgentX agent selected as the model:

```bash
agentx tui
agentx tui --agent coder-agent
```

The AgentX daemon must be running. The command reads its agents, supplies an
OpenCode provider configuration for this TUI session, and starts OpenCode's
full-screen interface. It does not install or load an OpenCode plugin.

If OpenCode is missing, cannot run, or is older than v2, `agentx tui` explains
the problem and opens the built-in AgentX terminal UI. You can choose that UI
directly with `agentx tui --legacy`. Install OpenCode v2 from
<https://opencode.ai/v2/docs> to use its interface.

## Use AgentX models in OpenCode directly

To use `opencode` without the `agentx tui` launcher, configure a custom provider
in `~/.config/opencode/opencode.jsonc` and select `agentx/<agent-id>` from
OpenCode's `/models` menu:

```json
{
  "providers": {
    "agentx": {
      "name": "AgentX",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "http://127.0.0.1:18800/v1" },
      "models": { "coder-agent": { "name": "AgentX Coder" } }
    }
  }
}
```

This uses AgentX's OpenAI-compatible chat endpoint. It returns text; it does
not relay OpenCode tool calls or token-by-token output. AgentX agents still
use their own configured runtime and tools while handling the request.
