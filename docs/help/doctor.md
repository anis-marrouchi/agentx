# Run a health check

::: info Terminal
```sh
agentx doctor
```
:::

Doctor checks the environment, configuration, agent workspaces, and the running daemon. Read any failure and its suggested fix. `agentx doctor --json` gives the same checks in a machine-readable format; `--no-running` skips the daemon probe when the service is intentionally stopped.

Doctor is a check, not an installer or a repair command. If the browser opens but messages do not arrive, start with [It's not answering](./its-not-answering.md).
