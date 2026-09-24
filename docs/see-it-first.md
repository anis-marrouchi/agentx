# See it first, without an account

::: info Terminal
Run this from a built source checkout with Node.js 22. It starts an isolated demo; it does not use your real agents or credentials. See [Install](./install.md) for the current npm packaging issue.
:::

```sh
node dist/cli.js demo
```

AgentX starts three local daemons and walks through a task that passes from one agent to another machine. The network connection, routing, and event records are real. **The model replies are scripted**, so the demo does not call a paid model. Follow the dashboard addresses printed in the terminal to watch the run.

The demo is a tour of routing, not a populated copy of your business. Some dashboard views will be empty. When you finish, stop the demo as instructed in its terminal output. [Install AgentX](./install.md) to create a real team.

For the populated documentation tour, leave `pnpm docs:demo` running, then run `pnpm docs:seed` in a second terminal. The seeder adds fictional reviews, disabled schedules, and two disabled workflows. It never connects a real channel. In the workflow editor, **Build the demo report workflow** demonstrates a fixed authoring reply.

To keep the populated demo between sessions, run it in Docker instead. The image plays the scenario and seeds the same fixtures once, then resumes from a named volume on every restart:

```sh
docker compose -f docker-compose.demo.yml up --build -d
open http://127.0.0.1:18931/live
docker compose -f docker-compose.demo.yml down -v   # reset to a fresh demo
```

![Three local demo nodes in Live](/screenshots/live.png)

*The isolated scripted demo after a cross-node task.*

Next: [follow the annotated workflow walkthrough](tutorials/first-workflow.md), then explore the [architecture](architecture/overview.md).
