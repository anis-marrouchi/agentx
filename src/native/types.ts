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

/** Who else is talking to the person at this machine (#1126). */
export interface NativeSpeech {
  /** What is speaking or playing sound on this machine right now, in
   *  words ("a spoken line"), or null when nothing is. Processes whose
   *  parent is one of `exceptParents` are the caller's own and do not
   *  count. Never throws: an OS that can't tell answers null. */
  othersSpeaking(opts?: { exceptParents?: number[] }): Promise<string | null>
}

/** How long the person at this machine has not touched it (#1138 step B):
 *  the computer's part of the owner's presence. */
export interface NativeIdle {
  /** Seconds since the last keyboard or mouse input, or null when the OS
   *  can't tell. Never throws. */
  seconds(): Promise<number | null>
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
  readonly speech?: NativeSpeech
  readonly idle?: NativeIdle
  /** For doctor and the dashboard. Never throws. */
  describe(): Promise<NativeDescription>
}
