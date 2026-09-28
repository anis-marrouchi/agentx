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
// Run files are named after the moment they were written, e.g.
// 2026-09-23T08-15-00-018Z.json. A day's history only needs the files
// near that day, so names outside the window are skipped unread: with
// thousands of runs on disk, reading every file on every dashboard poll
// starved libuv's file-system pool and stalled every other route that
// touches disk (#245).
const RUN_NAME = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.json$/;
/** Widest UTC offset either side (UTC-12 … UTC+14), plus room for a long
 *  run whose file is stamped at the end rather than the start. */
const WINDOW_BEFORE_MS = 14 * 3_600_000 + 6 * 3_600_000;
const WINDOW_AFTER_MS = 24 * 3_600_000 + 12 * 3_600_000 + 6 * 3_600_000;

/** Epoch ms encoded in a run file name, or null for any other name. */
export function runFileTime(name: string): number | null {
  const m = RUN_NAME.exec(name);
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isNaN(t) ? null : t;
}

/** Whether a run file may hold a run started on `date` in some time zone.
 *  Names that don't carry a time are always read. */
export function mayHoldDay(name: string, date: string): boolean {
  const t = runFileTime(name);
  if (t === null) return true;
  const dayStart = Date.parse(`${date}T00:00:00.000Z`);
  return t >= dayStart - WINDOW_BEFORE_MS && t < dayStart + WINDOW_AFTER_MS;
}

// Dashboards on several machines ask for the same day every few seconds.
// One read serves every caller that arrives while it runs, and its result
// is reused briefly after.
const HISTORY_TTL_MS = 5_000;
const historyCache = new Map<string, { at: number; value: Promise<CronRunHistoryItem[]> }>();

export async function readCronRunHistory(
  options: ReadCronRunHistoryOptions,
): Promise<CronRunHistoryItem[]> {
  const key = JSON.stringify([options.runsDir ?? process.cwd(), options.date, options.timezone ?? "UTC", options.jobId ?? ""]);
  const now = Date.now();
  const hit = historyCache.get(key);
  if (hit && now - hit.at < HISTORY_TTL_MS) return hit.value;
  const value = readCronRunHistoryUncached(options);
  historyCache.set(key, { at: now, value });
  // A failed read must not be served to later callers.
  value.catch(() => historyCache.delete(key));
  for (const [k, v] of historyCache) if (now - v.at >= HISTORY_TTL_MS) historyCache.delete(k);
  return value;
}

/** Test hook: forget cached history reads. */
export function clearCronRunHistoryCache(): void {
  historyCache.clear();
}

async function readCronRunHistoryUncached(
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
      if (!mayHoldDay(runEntry.name, options.date)) continue;

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

export interface ReadRecentCronRunsOptions {
  /** Most recent attempts to keep per job. */
  perJob: number;
  runsDir?: string;
  /** Restrict to these job ids. Directories of removed jobs are skipped. */
  jobIds?: string[];
}

/**
 * Reads the latest persisted attempts per job regardless of calendar day,
 * newest first. Run files are named by their ISO start time, so only the
 * newest `perJob` names are opened; corrupt files are skipped.
 */
export async function readRecentCronRuns(
  options: ReadRecentCronRunsOptions,
): Promise<Map<string, CronRunHistoryItem[]>> {
  const out = new Map<string, CronRunHistoryItem[]>();
  const runsDir =
    options.runsDir ?? resolve(process.cwd(), ".agentx/cron/runs");
  const perJob = Math.max(0, Math.floor(options.perJob));
  const wanted = options.jobIds ? new Set(options.jobIds) : null;
  let jobEntries;
  try {
    jobEntries = await readdir(runsDir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const jobEntry of jobEntries) {
    if (!jobEntry.isDirectory()) continue;
    if (wanted && !wanted.has(jobEntry.name)) continue;
    let names: string[];
    try {
      names = (await readdir(resolve(runsDir, jobEntry.name)))
        .filter((name) => name.endsWith(".json"))
        .sort()
        .reverse();
    } catch {
      continue;
    }

    const runs: CronRunHistoryItem[] = [];
    for (const name of names) {
      if (runs.length >= perJob) break;
      try {
        const contents = await readFile(
          resolve(runsDir, jobEntry.name, name),
          "utf8",
        );
        const run = parseRun(JSON.parse(contents), jobEntry.name);
        if (run) runs.push(run);
      } catch {
        // Unreadable or mid-write; older files still tell the story.
      }
    }
    runs.sort(
      (a, b) =>
        new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );
    out.set(jobEntry.name, runs);
  }
  return out;
}
