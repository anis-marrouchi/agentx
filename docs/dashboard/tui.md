# Terminal UI with OpenCode

Start with the [terminal prerequisites and installation steps](../requirements.md#terminal-interface).

`agentx tui` lets you talk to an AgentX agent from a terminal window. It opens OpenCode, a separate terminal chat program, with your agent in place of a model. AgentX runs the agent and its tools; OpenCode only supplies the conversation screen. No OpenCode plugin is needed.

## Start a session

1. **Terminal:** make sure the daemon (the AgentX background service) is running:
   ```sh
   agentx daemon status
   ```
2. **Terminal:** check that OpenCode is version 2 or newer:
   ```sh
   opencode --version
   ```
3. **Terminal:** open the terminal UI with the agent you want, using its id from your settings (here `support`):
   ```sh
   agentx tui --agent support
   ```
4. Type a message in OpenCode and press Enter.

Without `--agent`, the first agent the daemon lists is used. From a source checkout, replace `agentx` with `node dist/cli.js`. The command must run in an interactive terminal window.

AgentX passes OpenCode its settings for this one session only (it starts `opencode --standalone`). Your saved OpenCode settings are not changed.

![OpenCode started by agentx tui --agent cx: a question and the agent's reply, with "Build · AgentX CX" under the reply showing the AgentX agent is the model](/screenshots/tui/opencode-agent.png)

## If OpenCode is missing: the built-in terminal UI

If OpenCode is missing, its version can't be read, or it's older than version 2, AgentX prints the reason and opens its own simpler terminal UI instead. To choose that UI on purpose:

1. **Terminal:** run:
   ```sh
   agentx tui --legacy
   ```

If OpenCode starts and then fails, AgentX reports the error; it does not switch to the built-in UI on its own. See the [OpenCode v2 documentation](https://opencode.ai/v2/docs) to install or update OpenCode.

## Connections and limits

- `--config path/to/agentx.json` uses another settings file.
- `--node http://127.0.0.1:18800` connects to a different daemon address.
- `--token` (a password for another machine's daemon) works with the built-in UI only. The OpenCode launch doesn't pass it on, so connecting OpenCode to a remote daemon that needs a token takes extra OpenCode setup. Start with the daemon on your own machine.

OpenCode receives the agent's finished text. It does not see the agent's tool use or the reply word by word; the agent still uses its own tools while it works. The model account belongs to AgentX: installing OpenCode does not give you one.

To set up AgentX models inside OpenCode yourself, see the [integration README](https://github.com/anis-marrouchi/agentx/blob/main/integrations/opencode/README.md).

## Check it worked

1. **Terminal:** run `agentx tui --agent support` (with your agent's id).
2. The terminal prints `Opening <OpenCode version> with AgentX model support.` and OpenCode opens.
3. Send a short message. The agent's answer appears in OpenCode, and the task shows on the dashboard's [Live](./live.md) tab.

## If something is wrong

- **`agentx tui requires an interactive terminal`:** run it directly in a terminal window, not from a script or a pipe.
- **`OpenCode … is too old`:** update OpenCode to version 2 or newer, or use `--legacy`.
- **`Unknown AgentX agent: …`:** the id after `--agent` doesn't match any agent. Check the ids in the dashboard's **Settings › Agents**.
- **`No AgentX agents returned by …`:** the daemon has no agents, or you connected to the wrong address. Check `agentx daemon status` and `--node`.
- **`OpenCode exited with code …`:** OpenCode itself failed. Run `opencode` on its own to see its error.
