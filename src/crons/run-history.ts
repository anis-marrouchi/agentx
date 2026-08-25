import { readFile, readdir } from "fs/promises";
import { resolve } from "path";

export const CRON_RESPONSE_SUMMARY_LIMIT = 500;
export const CRON_ERROR_SUMMARY_LIMIT = 300;

export type CronRunHistoryStatus = "success" | "failed" | "timeout";

export interface CronRunHistoryItem {
  jobId: string;
  startedAt: string;
  completedAt: string;
  duration: number;
  status: CronRunHistoryStatus;
  responseSummary?: string;
  errorSummary?: string;
  isRetry: boolean;
  retryAttempt: number;
  runId?: string;
  taskId?: string;
  rootTaskId?: string;
  traceId?: string;
  sessionId?: string;
}

export interface ReadCronRunHistoryOptions {
  date: string;
  timezone?: string;
  runsDir?: string;
  jobId?: string;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIMEOUT_PATTERN = /\b(?:time(?:d)?\s*out|timeout)\b/i;
const ID_FIELDS = [
  "runId",
  "taskId",
  "rootTaskId",
  "traceId",
  "sessionId",
] as const;

type JsonRecord = Record<string, unknown>;

/**
 * Reads persisted cron attempts for one local calendar day. Invalid input,
 * missing directories, and corrupt entries are treated as an empty history.
 */
export async function readCronRunHistory(
  options: ReadCronRunHistoryOptions,
): Promise<CronRunHistoryItem[]> {
  const timezone = options.timezone ?? "UTC";
  const dateFormatter = makeDateFormatter(options.date, timezone);
  if (!dateFormatter) return [];

  const runsDir =
    options.runsDir ?? resolve(process.cwd(), ".agentx/cron/runs");
  let jobEntries;
  try {
    jobEntries = await readdir(runsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const runs: CronRunHistoryItem[] = [];
  for (const jobEntry of jobEntries) {
    if (!jobEntry.isDirectory()) continue;
    if (options.jobId !== undefined && jobEntry.name !== options.jobId)
      continue;

    let runEntries;
    try {
      runEntries = await readdir(resolve(runsDir, jobEntry.name), {
        withFileTypes: true,
      });
    } catch {
      continue;
    }

    for (const runEntry of runEntries) {
      if (!runEntry.isFile() || !runEntry.name.endsWith(".json")) continue;

      try {
        const contents = await readFile(
          resolve(runsDir, jobEntry.name, runEntry.name),
          "utf8",
        );
        const value: unknown = JSON.parse(contents);
        const run = parseRun(value, jobEntry.name);
        if (run && formatDate(dateFormatter, run.startedAt) === options.date)
          runs.push(run);
      } catch {
        // A run can disappear or become unreadable while history is being listed.
      }
    }
  }

  return runs.sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );
}

function makeDateFormatter(
  date: string,
  timezone: string,
): Intl.DateTimeFormat | null {
  if (!DATE_PATTERN.test(date)) return null;

  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date
  )
    return null;

  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    return null;
  }
}

function formatDate(formatter: Intl.DateTimeFormat, value: string): string {
  const parts = formatter.formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function parseRun(
  value: unknown,
  directoryJobId: string,
): CronRunHistoryItem | null {
  if (!isRecord(value)) return null;
  if (value.jobId !== directoryJobId || typeof value.jobId !== "string")
    return null;
  if (typeof value.startedAt !== "string" || !isValidDate(value.startedAt))
    return null;
  if (typeof value.completedAt !== "string" || !isValidDate(value.completedAt))
    return null;
  if (
    typeof value.duration !== "number" ||
    !Number.isFinite(value.duration) ||
    value.duration < 0
  )
    return null;
  if (typeof value.success !== "boolean") return null;

  const response =
    typeof value.response === "string" ? value.response : undefined;
  const error = typeof value.error === "string" ? value.error : undefined;
  const run: CronRunHistoryItem = {
    jobId: value.jobId,
    startedAt: new Date(value.startedAt).toISOString(),
    completedAt: new Date(value.completedAt).toISOString(),
    duration: value.duration,
    status: classifyStatus(value.success, error),
    responseSummary: summarize(response, CRON_RESPONSE_SUMMARY_LIMIT),
    errorSummary: summarize(error, CRON_ERROR_SUMMARY_LIMIT),
    isRetry: value.isRetry === true,
    retryAttempt: isNonNegativeInteger(value.retryAttempt)
      ? value.retryAttempt
      : 0,
  };

  for (const field of ID_FIELDS) {
    const id = value[field];
    if (typeof id === "string" && id.length > 0) {
      run[field] = id.slice(0, 200);
    }
  }

  return run;
}

function classifyStatus(
  success: boolean,
  error?: string,
): CronRunHistoryStatus {
  if (success) return "success";
  return error && TIMEOUT_PATTERN.test(error) ? "timeout" : "failed";
}

function summarize(
  value: string | undefined,
  limit: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 3)}...`;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidDate(value: string): boolean {
  return Number.isFinite(new Date(value).getTime());
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
