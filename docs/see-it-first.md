# See it first, without an account

The demo shows AgentX passing a task from one agent to an agent on another machine. It runs three AgentX daemons (background services) on your own computer and needs no model account: the network connection, routing and records are real, but **the model replies are scripted**, so nothing calls a paid model. It doesn't touch your real agents or credentials.

You need Node.js 22.19 or newer, up to 26. Nothing else: no download of the source code, no account and no API key. See [Before you start](./requirements.md#option-b-run-from-source) if Node.js isn't installed yet.

## Run the demo

1. **Terminal:** start the demo:
   ```sh
   npx agentix-cli demo
   ```
   The first run downloads the AgentX package, which takes a minute or two. The demo writes its files to a folder called `.agentx-demo` in the folder you ran it from.
2. Wait for the line `Dashboard: http://127.0.0.1:18931/live`. The demo opens it in your browser. On a machine with no browser, such as a server, it prints `Couldn't open a browser. Visit http://127.0.0.1:18931/live` and carries on.
3. **Browser:** watch the **Live** tab. The task moves from one machine to another.
4. **Terminal:** press Enter to play the scenario again, or Ctrl-C to stop the demo.

If you already have a built copy of the source code (see [Install › Run from source](./install.md#run-from-source)), `node dist/cli.js demo` in that folder does the same.

![Three local demo nodes in Live](/screenshots/live.png)

*The demo after a task has moved between machines.*

The demo is a tour of routing, not a filled-in copy of a business, so some dashboard views stay empty.

![The demo's terminal output: three local daemons start, the dashboard address is printed, and the scripted task passes from the cx agent to the builder agent on another machine and back](/screenshots/see-it-first/demo-terminal.png)

*The terminal after one run of the scenario.*

## See a filled-in demo

The filled-in demo is the one used for the screenshots on this site. It adds made-up reviews, switched-off schedules and two switched-off workflows. It never connects a real channel. Unlike the plain demo, it needs a built copy of the source code: see [Install › Run from source](./install.md#run-from-source).

1. **Terminal:** in the AgentX source folder, start the demo and leave it running:
   ```sh
   pnpm docs:demo
   ```
2. **Terminal:** open a second terminal in the same folder.
3. **Terminal:** add the made-up data:
   ```sh
   pnpm docs:seed
   ```
4. **Browser:** open `http://127.0.0.1:18931/live`.
5. **Browser:** open the **Workflows** tab, then open **Draft the demo shop report**.
6. **Browser:** select **Ask AI to build…**, type `Build the demo report workflow`, and send it. The demo answers with a fixed example.

![The workflow editor in the filled-in demo](/screenshots/editor-chat-closed.png)

## Keep the demo between sessions (Docker)

Docker runs programs in a sealed box, called a container. The Docker version of the demo plays the scenario and adds the same made-up data once, then keeps it in a named storage area (a Docker volume) so it's still there next time.

1. **Terminal:** start it:
   ```sh
   docker compose -f docker-compose.demo.yml up --build -d
   ```
2. **Browser:** open `http://127.0.0.1:18931/live`.
3. **Terminal:** when you want a fresh demo, remove it and its stored data:
   ```sh
   docker compose -f docker-compose.demo.yml down -v
   ```

Next: [follow the annotated workflow walkthrough](tutorials/first-workflow.md), then [install AgentX](./install.md) to create a real team.

## Check it worked

1. **Browser:** `http://127.0.0.1:18931/live` shows agents on three machines.
2. The terminal prints `A2A mesh healthy`, which means the three demo machines can reach each other.

## If something is wrong

- **`npx` asks `Need to install the following packages: agentix-cli`:** answer `y`. It's the download mentioned in step 1.
- **`Cannot find module … dist/cli.js`:** you ran the source version and the source hasn't been built. Run `pnpm install`, then `pnpm build`. Or use `npx agentix-cli demo`, which needs no build.
- **The demo won't start because a port is busy:** another demo is already running, perhaps in another terminal. Stop that one with Ctrl-C, or start this one elsewhere with `npx agentix-cli demo --base-port 19021` (the dashboard is then on the base port plus 10).
- **`AgentX needs Node.js 22.19 or newer, up to 26`:** the command stopped because this Node.js is too old or too new. Install Node.js 22, check with `node --version`, and run it again.
- **The Docker demo shows old data:** run `docker compose -f docker-compose.demo.yml down -v` to start fresh.
