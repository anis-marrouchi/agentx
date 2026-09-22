<script setup>
const image = '/screenshots/editor-chat-reply.png'
const steps = [
  { title: 'Describe the job', text: 'In the workflow assistant, send “Build the demo report workflow”. The demo uses a scripted reply; a live agent uses your configured model.', image, alt: 'Workflow editor with the demo request and assistant proposal visible.', box: [83, 44, 15, 5] },
  { title: 'Read the proposal', text: 'The assistant proposes a manual start, a report from the CX agent, and a finish. Read this explanation before applying the graph.', image, alt: 'Assistant explanation of a three-step report workflow.', box: [73, 49, 23, 8] },
  { title: 'Apply to canvas', text: 'Apply to canvas replaces the current graph. This screenshot shows the proposal before that button is pressed.', image, alt: 'Apply to canvas button below the workflow proposal.', box: [74, 57, 8, 4] },
  { title: 'Inspect the flow', text: 'Follow the connections from start to report to done. Check the selected agent and its task before saving or running.', image: '/screenshots/editor-canvas.png', alt: 'Demo workflow after applying the proposal, with three connected nodes.', box: [26, 32, 44, 10] },
]
</script>

# Build your first workflow

**Outcome:** understand how a request becomes a workflow you can inspect. Allow about five minutes. This tour uses fictional demo data and does not send messages to an external channel.

## 1. Get the demo ready

From a built source checkout, start `pnpm docs:demo`. In another terminal, run `pnpm docs:seed`. Open `http://127.0.0.1:18931/workflows`, then open **Draft the demo shop report**.

## 2. Follow the visual walkthrough

Use **Next** to read at your own pace, or **Play tour** to advance every few seconds. Playback starts only when you request it.

<ScreenshotTour title="From a request to a reviewable workflow" :steps="steps" />

## 3. Try it yourself

1. Open **Ask AI to build…** in the editor.
2. Send **Build the demo report workflow**.
3. Read the proposal, then select **Apply to canvas**.
4. Inspect the report node, agent, and connections. Save the draft.

**Checkpoint:** you should see a manual start connected to the report agent and then an end node. The example remains disabled. Applying a proposal is not evidence that a workflow ran.

## 4. Go one level deeper

- [Check a workflow run](../automations/check-it-worked.md): inspect execution and output.
- [How AgentX fits together](../architecture/overview.md): follow a request through the system.
- [Workflow schema](../reference/workflow-schema.md): understand the saved graph.
- [Terminal reference](../reference/cli.md): repeat operations from a shell.
