// --- Schedules that report only exceptions (#1289) ---
//
// A job with `report: "exceptions"` is asked to answer with one fixed word
// when all is as expected. Such a quiet answer is kept in the run record but
// sent nowhere: the run decides whether there is anything to say, not a
// rule written in AgentX. Failures are alerted as for any job.

/** The answer a run gives when it has nothing to report. */
export const NOTHING_TO_REPORT = "NOTHING_TO_REPORT"

export type CronReportMode = "always" | "exceptions"

/** Append the quiet rule to an agent prompt of a `report: "exceptions"` job. */
export function withQuietRule(prompt: string, report?: CronReportMode): string {
  if (report !== "exceptions") return prompt
  return `${prompt}\n\n[Report only exceptions]\nThis schedule reports only when something is wrong or needs a person. If everything is as expected, reply with exactly ${NOTHING_TO_REPORT} and nothing else. Otherwise, say what is wrong.`
}

/** Whether `text` is the quiet answer. Markdown around the word, a closing
 *  full stop and letter case are forgiven; any other words are not. */
export function isQuietAnswer(text: string | undefined): boolean {
  if (!text) return false
  const word = text.trim().replace(/^[`*_"'\s]+|[`*_"'.!\s]+$/g, "")
  return word.toUpperCase() === NOTHING_TO_REPORT
}

/** Whether a run of a job in `report` mode said nothing worth sending. */
export function isQuietRun(report: CronReportMode | undefined, text: string | undefined): boolean {
  return report === "exceptions" && isQuietAnswer(text)
}
