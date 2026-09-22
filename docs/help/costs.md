# Understand model costs

The scripted [demo](../see-it-first.md) does not call a paid model. Real agents may incur provider charges when they read context or produce replies. The amount depends on the model, how much context it receives, and how often work runs.

Open the dashboard's cost or usage views to inspect recorded usage, and compare it with your provider's bill. A schedule that runs frequently can spend money even when no one sends a message. Begin with a low-frequency schedule and check its first runs before increasing it.

An agent can use a configured model account or API key. AgentX itself does not make the provider subscription free. See your provider's current billing terms for the actual price.

Monitor's automatic reviewer can also consume Claude Code usage, separately from the agent's task model. A scripted demo disables that background reviewer.
