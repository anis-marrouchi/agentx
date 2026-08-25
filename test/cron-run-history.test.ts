import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  CRON_ERROR_SUMMARY_LIMIT,
  CRON_RESPONSE_SUMMARY_LIMIT,
  readCronRunHistory,
} from "../src/crons/run-history";

let runsDir: string;

beforeEach(() => {
  runsDir = mkdtempSync(path.join(tmpdir(), "agentx-cron-runs-"));
});

afterEach(() => {
  rmSync(runsDir, { recursive: true, force: true });
});

function writeRun(
  jobId: string,
  filename: string,
  run: Record<string, unknown>,
) {
  const jobDir = path.join(runsDir, jobId);
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(path.join(jobDir, filename), JSON.stringify(run));
}

function run(overrides: Record<string, unknown> = {}) {
  return {
    jobId: "daily-brief",
    startedAt: "2026-08-25T12:00:00.000Z",
    completedAt: "2026-08-25T12:00:01.000Z",
    success: true,
    response: "Brief sent",
    duration: 1000,
    isRetry: false,
    retryAttempt: 0,
    ...overrides,
  };
}

describe("readCronRunHistory", () => {
  it("returns persisted runs newest-first with timing, retry, and correlation fields", async () => {
    writeRun(
      "daily-brief",
      "older.json",
      run({
        startedAt: "2026-08-25T08:00:00.000Z",
        completedAt: "2026-08-25T08:00:02.000Z",
      }),
    );
    writeRun(
      "daily-brief",
      "newer.json",
      run({
        startedAt: "2026-08-25T18:00:00.000Z",
        completedAt: "2026-08-25T18:00:03.000Z",
        duration: 3000,
        isRetry: true,
        retryAttempt: 2,
        taskId: "task-1",
        sessionId: "session-1",
      }),
    );

    const history = await readCronRunHistory({ date: "2026-08-25", runsDir });

    expect(history).toHaveLength(2);
    expect(history.map((item) => item.startedAt)).toEqual([
      "2026-08-25T18:00:00.000Z",
      "2026-08-25T08:00:00.000Z",
    ]);
    expect(history[0]).toMatchObject({
      jobId: "daily-brief",
      duration: 3000,
      status: "success",
      isRetry: true,
      retryAttempt: 2,
      taskId: "task-1",
      sessionId: "session-1",
    });
  });

  it("filters by the requested local date in an IANA timezone", async () => {
    writeRun(
      "daily-brief",
      "local-day.json",
      run({
        startedAt: "2026-08-26T02:30:00.000Z",
        completedAt: "2026-08-26T02:31:00.000Z",
      }),
    );

    expect(
      await readCronRunHistory({
        date: "2026-08-25",
        timezone: "America/New_York",
        runsDir,
      }),
    ).toHaveLength(1);
    expect(
      await readCronRunHistory({ date: "2026-08-25", runsDir }),
    ).toHaveLength(0);
  });

  it("classifies failures and timeouts", async () => {
    writeRun(
      "daily-brief",
      "failed.json",
      run({ success: false, error: "provider rejected request" }),
    );
    writeRun(
      "daily-brief",
      "timeout.json",
      run({
        startedAt: "2026-08-25T13:00:00.000Z",
        completedAt: "2026-08-25T13:01:00.000Z",
        success: false,
        error: "Agent timed out after 60 seconds",
      }),
    );

    const history = await readCronRunHistory({ date: "2026-08-25", runsDir });
    expect(history.map((item) => item.status)).toEqual(["timeout", "failed"]);
  });

  it("bounds response and error summaries without returning raw output fields", async () => {
    writeRun(
      "daily-brief",
      "large.json",
      run({
        success: false,
        response: "r".repeat(CRON_RESPONSE_SUMMARY_LIMIT + 100),
        error: "e".repeat(CRON_ERROR_SUMMARY_LIMIT + 100),
      }),
    );

    const [item] = await readCronRunHistory({ date: "2026-08-25", runsDir });
    expect(item.responseSummary).toHaveLength(CRON_RESPONSE_SUMMARY_LIMIT);
    expect(item.errorSummary).toHaveLength(CRON_ERROR_SUMMARY_LIMIT);
    expect(item).not.toHaveProperty("response");
    expect(item).not.toHaveProperty("error");
  });

  it("skips malformed JSON, invalid records, directories, and non-JSON files", async () => {
    const jobDir = path.join(runsDir, "daily-brief");
    mkdirSync(path.join(jobDir, "not-a-file.json"), { recursive: true });
    writeFileSync(path.join(jobDir, "malformed.json"), "{");
    writeFileSync(
      path.join(jobDir, "invalid.json"),
      JSON.stringify(run({ startedAt: "never" })),
    );
    writeFileSync(path.join(jobDir, "notes.txt"), JSON.stringify(run()));
    writeRun("daily-brief", "valid.json", run());
    writeFileSync(path.join(runsDir, "stray.json"), JSON.stringify(run()));

    const history = await readCronRunHistory({ date: "2026-08-25", runsDir });
    expect(history).toHaveLength(1);
  });

  it("handles invalid dates, invalid timezones, and missing directories safely", async () => {
    await expect(
      readCronRunHistory({ date: "2026-02-30", runsDir }),
    ).resolves.toEqual([]);
    await expect(
      readCronRunHistory({
        date: "2026-08-25",
        timezone: "Mars/Olympus_Mons",
        runsDir,
      }),
    ).resolves.toEqual([]);
    await expect(
      readCronRunHistory({
        date: "2026-08-25",
        runsDir: path.join(runsDir, "missing"),
      }),
    ).resolves.toEqual([]);
  });
});
