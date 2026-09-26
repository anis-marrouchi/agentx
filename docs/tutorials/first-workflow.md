<script setup>
const image = '/screenshots/editor-chat-reply.png'
const steps = [
  { title: 'Describe the job', text: 'In the workflow assistant, send “Build the demo report workflow”. The demo uses a scripted reply; a live agent uses your configured model.', image, alt: 'Workflow editor with the demo request and assistant proposal visible.', box: [83, 44, 15, 5] },
  { title: 'Read the proposal', text: 'The assistant proposes a manual start, a report from the demo's `cx` agent, and a finish. Read this explanation before applying the graph.', image, alt: 'Assistant explanation of a three-step report workflow.', box: [73, 49, 23, 8] },
  { title: 'Apply to canvas', text: 'Apply to canvas replaces the current workflow on the canvas. This screenshot shows the proposal before that button is pressed.', image, alt: 'Apply to canvas button below the workflow proposal.', box: [74, 57, 8, 4] },
  { title: 'Inspect the flow', text: 'Follow the connections from start to report to done. Check the selected agent and its task before saving or running.', image: '/screenshots/editor-canvas.png', alt: 'Demo workflow after applying the proposal, with three connected nodes.', box: [26, 32, 44, 10] },
]
</script>

# Build your first workflow

**Outcome:** understand how a request becomes a workflow you can inspect. Allow about five minutes. This tour uses fictional demo data and does not send messages anywhere outside your machine.

A **workflow** is a set of steps AgentX runs in order, such as "start, ask an agent for a report, finish". In the editor, each step is a box (a *node*) on a drawing area (the *canvas*), and lines connect the boxes in the order they run.

## 1. Get the demo ready

You need a source checkout of AgentX that has been built with `pnpm build` (see [Install](../install.md#run-from-source)).

1. **Terminal:** from the checkout, start the demo and leave it running:
   ```sh
   pnpm docs:demo
   ```
2. **Terminal:** in a second terminal window, add the demo data:
   ```sh
   pnpm docs:seed
   ```
3. **Browser:** open `http://127.0.0.1:18931/workflows`.
4. Select **Draft the demo shop report** in the list on the left.

   ![The Workflows list in the demo](/screenshots/workflows-list.png)

5. Select **Edit on canvas**. The workflow editor opens.

## 2. Follow the visual walkthrough

Use **Next** to read at your own pace, or **Play tour** to advance every few seconds. Playback starts only when you ask for it.

<ScreenshotTour title="From a request to a reviewable workflow" :steps="steps" />

## 3. Try it yourself

1. **Browser:** in the editor, select **Ask AI to build…** at the bottom of the page.
2. Type **Build the demo report workflow** and select **Send**.
3. Read the assistant's proposal.
4. Select **Apply to canvas**.
5. Select the **report** box and check its agent and task in the panel on the right.
6. Follow the lines from **start** to **report** to **done**.
7. Select **Save**.

## 4. Go one level deeper

- [Check a workflow run](../automations/check-it-worked.md): inspect execution and output.
- [How AgentX fits together](../architecture/overview.md): follow a request through the system.
- [Workflow schema](../reference/workflow-schema.md): understand the saved workflow file.
- [Terminal reference](../reference/cli.md): repeat operations from a shell.

## Check it worked

- The canvas shows three connected boxes: **start** (you start it), **report** (ask an agent) and **done** (finish).
- The example stays switched off. Applying a proposal only draws the workflow; it doesn't run it. To see a real run, follow [Check that it worked](../automations/check-it-worked.md).

## If something is wrong

- **`http://127.0.0.1:18931` doesn't open:** the demo isn't running. Check the first terminal for errors and start `pnpm docs:demo` again.
- **`pnpm docs:demo` fails at once:** build the checkout first with `pnpm build`. If it says a port is in use, another demo is already running; stop it with Ctrl-C in its terminal.
- **There is no Draft the demo shop report workflow:** run `pnpm docs:seed` again while the demo is running.
- **The assistant doesn't reply:** in the demo it only knows the exact request **Build the demo report workflow**. Check the spelling.
