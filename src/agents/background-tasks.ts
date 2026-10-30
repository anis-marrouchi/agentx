/**
 * Background work a claude run still has open (#892): tasks the CLI
 * announced with `system/task_started` and has not yet closed with
 * `system/task_notification`. A `result` while any is open ends a turn,
 * not the run: the CLI stays up and runs a new turn once the work ends.
 * A task the CLI marks as not backgrounded (a subagent it waits for)
 * ends inside its turn and is not counted.
 */
export class BackgroundTasks {
  private open = new Set<string>()

  observe(event: any): void {
    if (event?.type !== "system" || typeof event.task_id !== "string") return
    if (event.subtype === "task_started" && event.is_backgrounded !== false) this.open.add(event.task_id)
    else if (event.subtype === "task_notification") this.open.delete(event.task_id)
  }

  get pending(): number {
    return this.open.size
  }
}
