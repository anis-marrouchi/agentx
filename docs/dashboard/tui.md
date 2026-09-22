# Terminal UI with OpenCode

Start with the [terminal prerequisites and installation steps](../requirements.md#terminal-interface).

`agentx tui` opens OpenCode with an AgentX agent selected as its model. AgentX runs the agent and its tools; OpenCode supplies the terminal conversation interface. No OpenCode plugin is required.

## Start a session

Start the AgentX daemon, then run this in an interactive terminal:

```sh
agentx tui --agent coder-agent
```

Use an agent ID from your configuration. Without `--agent`, the launcher selects the first agent returned by the daemon. From a source checkout, replace `agentx` with `node dist/cli.js`.

The launcher reads the daemon's agents, constructs a provider configuration for this child process, and starts `opencode --standalone`. It does not need to rewrite your saved OpenCode configuration.

## OpenCode versions and fallback

This integration expects **OpenCode v2 or newer**. Check `opencode --version` and consult the [OpenCode v2 documentation](https://opencode.ai/v2/docs) for installation.

If OpenCode is missing, its version cannot be read, or it is too old, AgentX prints the reason and opens its built-in Ink terminal UI. You can select that UI explicitly:

```sh
agentx tui --legacy
```

An OpenCode process that fails after launch reports an error; that later failure does not automatically reopen the legacy UI.

## Connections and limits

Use `--config path/to/agentx.json` to select another configuration, or `--node http://127.0.0.1:18800` to override the daemon URL. The legacy client supports `--token` for remote authentication. The current OpenCode launch configuration does **not** forward that token into provider settings, so an authenticated remote OpenCode connection needs additional provider configuration. Start with the local daemon.

The model bridge returns text through AgentX's OpenAI-compatible endpoint. It does not relay OpenCode tool calls or incremental model tokens; the AgentX agent still uses its own tools while working. Provider credentials belong to the AgentX runtime. OpenCode availability alone does not supply a model account.

For configuring AgentX models inside OpenCode directly, see the [integration README](https://github.com/anis-marrouchi/agentx/blob/docs-v2/integrations/opencode/README.md).
