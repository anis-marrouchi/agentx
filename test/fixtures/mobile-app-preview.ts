// Isolated UI fixture: binds only loopback and never calls an agent or device.
import { createServer } from "node:http"
import { renderAppPage } from "../../src/daemon/ui/pages/app"
const now = Date.now(),
  ts = new Date(now).toISOString()
const conversation = {
  id: "cdemo",
  node: "local",
  nodeName: "Studio",
  agent: "helper",
  agentName: "Helper",
  title: "Website build",
  updatedAt: now,
  messages: [
    { role: "user", content: "Why is the website build slow today?" },
    {
      role: "assistant",
      content:
        "Most of the time goes to the photo step. It got slower after yesterday’s update.\n\n```sh\nnpm run build -- --optimize-images --quality 90 --width 2400 ./public/photos/*.jpg\n```\n\n| Step | Today | Yesterday | Change |\n|---|---|---|---|\n| Photos | 48 seconds | 17 seconds | 31 seconds slower |\n| Scripts | 12 seconds | 11 seconds | 1 second slower |\n\nI can make the photos smaller. Shall I?",
    },
    { role: "user", content: "Yes, go ahead. Tell me the new time." },
    {
      role: "assistant",
      content: "Done. The photo step now takes 18 seconds.",
    },
  ],
}
const originalMessages = structuredClone(conversation.messages)
const agents = [
  {
    id: "helper",
    name: "Helper",
    active: 1,
    busy: true,
    running: 1,
    errors: 0,
    last: { ok: true, text: "Making the photos smaller." },
  },
  { id: "support", name: "Support", active: 0, busy: false, errors: 0 },
]
const data: any = {
  "/api/app/me": { device: "Demo phone", node: "Studio" },
  "/api/app/agents": {
    nodes: [
      { name: "Studio", target: "local", online: true, agents },
      { name: "Workshop", target: "peer", online: false, agents: [] },
    ],
  },
  "/api/app/conversations": { conversations: [conversation] },
  "/api/app/conversations/cdemo": conversation,
  "/api/app/chat/active": {
    conversations: [
      { ...conversation, state: "open" },
      {
        id: "cother",
        agentName: "Support",
        agent: "support",
        nodeName: "Studio",
        state: "thinking",
        title: "Reviewing requests",
      },
    ],
  },
  "/api/app/fleet": {
    ts,
    nodes: [
      {
        name: "Studio",
        url: "local",
        reachable: true,
        uptimeSec: 36000,
        agents,
        crons: {
          today: { success: 4, failed: 0 },
          items: [
            {
              id: "Morning summary",
              enabled: true,
              schedule: "0 9 * * *",
              agent: "helper",
              last: { status: "success", text: "Summary delivered." },
            },
          ],
        },
      },
      {
        name: "Workshop",
        url: "peer",
        reachable: false,
        agents: [],
        error: "Connection lost",
      },
    ],
  },
  "/api/app/activity": {
    ts,
    tasks: [
      {
        taskId: "t1",
        agentName: "Helper",
        node: "local",
        nodeName: "Studio",
        channel: "app",
        startedAt: ts,
        preview: "Making the website photos smaller.",
      },
    ],
  },
  "/api/app/approvals": {
    nodes: [
      {
        node: "local",
        nodeName: "Studio",
        items: [
          {
            key: "a1",
            title: "Review the draft",
            ask: "Is this ready to share?",
            recommend: "Read the changes first",
            raisedBy: "Support",
          },
        ],
      },
    ],
  },
  "/api/app/push": {
    available: false,
    reason: "Notifications are off in this demo.",
  },
  "/api/app/alerts": {
    items: [
      {
        id: 1,
        at: now,
        title: "Website update ready",
        body: "The photo step is faster. Open the conversation to see the result.",
        url: "/app#chat=cdemo",
      },
      {
        id: 2,
        at: now - 180000,
        title: "Workshop offline",
        body: "This computer stopped answering. The rest of the fleet still works.",
      },
    ],
  },
  "/api/app/announcements": { items: [], announce: false },
  "/api/app/camera/asks": { asks: [] },
  "/api/app/camera/config": {
    peers: [{ name: "Workshop" }],
    agents: [{ id: "helper", name: "Helper" }],
  },
}
createServer(async (req, res) => {
  const path = req.url!.split("?")[0]
  if (path === "/__reset") {
    conversation.messages = structuredClone(originalMessages)
    res.end("ok")
    return
  }
  if (path === "/app") {
    res.setHeader("Content-Type", "text/html")
    res.end(renderAppPage())
    return
  }
  if (path === "/api/app/chat" && req.method === "POST") {
    let raw = ""
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    conversation.messages.push(
      { role: "user", content: body.message },
      { role: "assistant", content: "Demo answer received." },
    )
    res.setHeader("Content-Type", "text/event-stream")
    res.end(
      "event: conversation\ndata: " +
        JSON.stringify(conversation) +
        "\n\nevent: final\ndata: " +
        JSON.stringify({ content: "Demo answer received.", status: "done" }) +
        "\n\n",
    )
    return
  }
  if (path === "/api/app/voice/transcribe") {
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ text: "Voice test message" }))
    return
  }
  if (req.method === "POST") {
    console.log(path)
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ ok: true }))
    return
  }
  if (path in data) {
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify(data[path]))
    return
  }
  res.writeHead(404)
  res.end()
}).listen(18948, "127.0.0.1", () =>
  console.log("Preview http://127.0.0.1:18948/app"),
)
