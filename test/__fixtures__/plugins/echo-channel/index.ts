import type { AgentXPlugin, AgentXPluginContext } from "../../../../src/plugins/types"
import type { ChannelAdapter, IncomingMessage, OutgoingMessage } from "../../../../src/channels/types"

// Test fixture — an AgentXPlugin that:
//   1) registers a fake "echo" ChannelAdapter (start/stop/send no-ops),
//   2) subscribes to task:completed on the bus and counts events.
//
// The plugin exposes its captured ctx + counters so the test can
// inspect what the loader did.

export class EchoChannel implements ChannelAdapter {
  readonly name = "echo"
  started = 0
  stopped = 0
  sent: OutgoingMessage[] = []
  private handler?: (m: IncomingMessage) => Promise<void>

  async start(): Promise<void> { this.started++ }
  async stop(): Promise<void> { this.stopped++ }
  async send(msg: OutgoingMessage): Promise<string | void> {
    this.sent.push(msg)
    return "echo-msg-id"
  }
  onMessage(handler: (m: IncomingMessage) => Promise<void>): void {
    this.handler = handler
  }
  /** Test helper — drive an inbound message into the registered handler. */
  async push(m: IncomingMessage): Promise<void> {
    if (this.handler) await this.handler(m)
  }
}

const channel = new EchoChannel()

export const inspect = {
  channel,
  taskCompletedSeen: 0,
  capturedCtx: undefined as AgentXPluginContext | undefined,
  teardownCalled: 0,
  reset() {
    this.taskCompletedSeen = 0
    this.capturedCtx = undefined
    this.teardownCalled = 0
    channel.started = 0
    channel.stopped = 0
    channel.sent = []
  },
}

const plugin: AgentXPlugin = {
  manifest: {
    name: "echo-channel",
    version: "0.1.0",
  },
  async setup(ctx) {
    inspect.capturedCtx = ctx
    ctx.addChannel(channel)
    ctx.on("task:completed", () => {
      inspect.taskCompletedSeen++
    })
  },
  async teardown() {
    inspect.teardownCalled++
  },
}

export default plugin
