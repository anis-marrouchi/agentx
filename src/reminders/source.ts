import type { NativeTask, NativeTasks } from "@/native"

// --- Apple Reminders, through the native adapter ---
//
// The OS task app is read and written by src/native (on macOS through the
// same tool the mac-pim skill uses, so the daemon and the skill see the
// same lists). These names stay for the poller and check-ins.

export type Reminder = NativeTask

/** The part of the OS task app the poller and check-ins use. */
export type ReminderSource = Pick<NativeTasks, "listOpen" | "complete">
