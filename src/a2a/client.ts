import type { AgentCard, Task, MessagePart, JsonRpcResponse } from "./types"

// --- A2A Client: call remote agents via A2A protocol ---

export class A2AClient {
  private baseUrl: string
  private token?: string

  constructor(baseUrl: string, token?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "")
    this.token = token
  }

  /**
   * Fetch the remote agent's card.
   */
  async getAgentCard(): Promise<AgentCard> {
    const res = await fetch(`${this.baseUrl}/.well-known/agent-card.json`, {
      headers: this.headers(),
    })
    if (!res.ok) throw new Error(`Failed to fetch agent card: ${res.status}`)
    return res.json() as Promise<AgentCard>
  }

  /**
   * Send a task synchronously and wait for completion.
   */
  async sendTask(
    text: string,
    metadata?: Record<string, unknown>,
  ): Promise<Task> {
    const response = await this.rpc("tasks/send", {
      id: `task-${Date.now().toString(36)}`,
      message: {
        role: "user",
        parts: [{ type: "text", text }] as MessagePart[],
      },
      metadata,
    })

    if (response.error) {
      throw new Error(`A2A error: ${response.error.message}`)
    }

    return response.result as Task
  }

  /**
   * Send a task with SSE streaming.
   */
  async *sendTaskStream(
    text: string,
    metadata?: Record<string, unknown>,
  ): AsyncIterable<{ state: string; message?: string; final: boolean }> {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tasks/sendSubscribe",
      params: {
        id: `task-${Date.now().toString(36)}`,
        message: {
          role: "user",
          parts: [{ type: "text", text }],
        },
        metadata,
      },
    })

    const res = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        ...this.headers(),
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
      },
      body,
    })

    if (!res.ok || !res.body) {
      throw new Error(`A2A stream error: ${res.status}`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() || ""

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.slice(6))
            yield {
              state: data.state,
              message: data.message?.parts?.[0]?.text,
              final: data.final,
            }
          } catch {
            // Skip malformed events
          }
        }
      }
    }
  }

  /**
   * Get task status by ID.
   */
  async getTask(taskId: string): Promise<Task> {
    const response = await this.rpc("tasks/get", { id: taskId })
    if (response.error) {
      throw new Error(`A2A error: ${response.error.message}`)
    }
    return response.result as Task
  }

  /**
   * Cancel a running task.
   */
  async cancelTask(taskId: string): Promise<Task> {
    const response = await this.rpc("tasks/cancel", { id: taskId })
    if (response.error) {
      throw new Error(`A2A error: ${response.error.message}`)
    }
    return response.result as Task
  }

  private async rpc(method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    const res = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        ...this.headers(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method,
        params,
      }),
    })

    if (!res.ok) {
      throw new Error(`A2A HTTP error: ${res.status}`)
    }

    return res.json() as Promise<JsonRpcResponse>
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {}
    if (this.token) {
      h["Authorization"] = `Bearer ${this.token}`
    }
    return h
  }
}
