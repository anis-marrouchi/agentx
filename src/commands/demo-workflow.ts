/** Publication-safe fixture, used only by the scripted demo provider. */
export const demoReportWorkflow = {
  id: "demo-report",
  version: 2 as const,
  title: "Draft the demo shop report",
  description: "Scripted documentation example. Review and enable before running.",
  status: "draft",
  state: "disabled",
  nodes: [
    { id: "start", type: "trigger.manual", config: {}, position: { x: 80, y: 180 } },
    { id: "report", type: "agent", config: { agentId: "cx", prompt: "Prepare the demo shop report." }, position: { x: 380, y: 180 } },
    { id: "done", type: "end", config: { status: "completed" }, position: { x: 680, y: 180 } },
  ],
  edges: [{ from: "start", to: "report" }, { from: "report", to: "done" }],
}
