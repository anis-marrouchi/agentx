// --- Native apps: the one place AgentX talks to the operating system ---
//
// #1062. Core code asks a NativeAdapter for what the OS already does well
// (due-dated tasks, notes, banners, sounds, Focus) and never names the OS
// itself; test/native/no-os-in-core.test.ts holds that line. A capability an
// OS lacks is left undefined, so callers check `adapter.tasks` and so on
// instead of checking the platform.

export type NativeOs = "macos" | "windows" | "none"

/** One task in the OS task app (Apple Reminders on macOS). Field names
 *  match what remindctl prints, so the reminders poller reads them as is. */
export interface NativeTask {
  id: string
  title: string
  notes?: string
  /** ISO time; absent for tasks without a due date. */
  dueDate?: string
  isCompleted: boolean
  listName?: string
}

export type NativePriority = "none" | "low" | "medium" | "high"

export interface NativeTasks {
  /** Creates the list when it does not exist yet. */
  ensureList(list: string): Promise<void>
  /** Open (not completed) tasks in one list. */
  listOpen(list: string): Promise<NativeTask[]>
  add(t: { list: string; title: string; notes: string; due?: Date; priority?: NativePriority }): Promise<{ id: string }>
  update(id: string, patch: { title?: string; notes?: string; due?: Date | null }): Promise<void>
  /** Tick one off, by full id. */
  complete(id: string): Promise<void>
  remove(id: string): Promise<void>
}

export interface NativeNotes {
  add(n: { folder: string; title: string; body: string }): Promise<{ id: string }>
}

export type BannerOutcome = "posted" | "not-allowed" | "failed"
export type BannerStatus = "ready" | "not-asked" | "not-allowed" | "hidden" | "missing" | "outdated"

export interface NativeBanner {
  post(b: { title: string; message: string }): Promise<BannerOutcome>
  status(): Promise<BannerStatus>
}

export interface NativeSound {
  play(name: string, volume: number): Promise<void>
  /** Is there a sound by this name? Synchronous, for config checks. */
  has(name: string): boolean
  names(): Promise<string[]>
}

export interface NativeFocus {
  /** null when the OS can't tell. */
  active(): Promise<boolean | null>
}

export interface NativeDescription {
  os: NativeOs
  tasks: boolean
  notes: boolean
  banner: boolean
  sound: boolean
  focus: boolean
  /** Why a capability is missing or not working, in plain words. */
  problems: string[]
}

export interface NativeAdapter {
  readonly os: NativeOs
  readonly tasks?: NativeTasks
  readonly notes?: NativeNotes
  readonly banner?: NativeBanner
  readonly sound?: NativeSound
  readonly focus?: NativeFocus
  /** For doctor and the dashboard. Never throws. */
  describe(): Promise<NativeDescription>
}
