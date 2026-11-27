// A run still going, read as a task record (#2101 R17b).
//
// A run's record (GET /agents/:id/tasks/:taskId) is written when it ends, so
// the Hub's Files tab said "not found" on a live run. With ?live=1 the node
// answers instead with the output so far, in the record's shape, marked
// live: true. Without the flag nothing changes: the archived Task page still
// reads 404 for a run that has no record.

import type { RunningTask } from "@/agents/registry"

/** The part of the registry this needs. */
export interface LiveTaskSource {
  list(): Array<{ id: string; runningTasks: RunningTask[] }>
  subscribeToTaskOutput(taskId: string, sub: (chunk: string) => void): { initial: string; done: boolean; unsubscribe: () => void } | null
}

export interface LiveTaskRecord {
  live: true
  id: string
  agentId: string
  message: string
  sender?: string
  channel: string
  startedAt: string
  transcript: string
  responseText: string
}

/** The agent's running task as a record, or null when it is not running on this node. */
export function liveTaskRecord(src: LiveTaskSource, agentId: string, taskId: string): LiveTaskRecord | null {
  const agent = src.list().find((a) => a.id === agentId)
  const run = agent?.runningTasks.find((t) => t.id === taskId)
  if (!run) return null
  const sub = src.subscribeToTaskOutput(taskId, () => {})
  if (!sub) return null
  sub.unsubscribe()
  return {
    live: true,
    id: taskId,
    agentId,
    message: run.message,
    ...(run.sender ? { sender: run.sender } : {}),
    channel: run.channel,
    startedAt: run.startedAt.toISOString(),
    transcript: sub.initial,
    responseText: "",
  }
}
