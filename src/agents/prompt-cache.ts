// The prompt cache's lifetime: one number for every "warm or cold" check.
//
// A cached prompt prefix is assumed to live this long after it was last
// written or read. Anthropic's default lifetime is five minutes with a
// one-hour option, and Claude Code writes with the one-hour lifetime: on a
// week of live traces, 525 of 584 runs resumed more than 60 minutes after the
// chat's previous run wrote 20k+ again, while runs inside the hour read it.
// An hour is also the assumption whose error is cheap (see routing.ts).
//
// Used by model routing (routing.ts, session-model.ts), the cost signals
// (improve/cost.ts) and the default of the resume gate's
// `session.resumeGate.cacheTtlMinutes` setting, which can still override it
// for the gate alone (#2031). A leaf module with no imports, so config.ts
// can read it without pulling in the decision seats.

/** How long a cached prompt prefix is assumed to stay reusable. */
export const CACHE_TTL_MS = 60 * 60 * 1000

/** The same lifetime in whole minutes, for settings counted in minutes. */
export const CACHE_TTL_MINUTES = CACHE_TTL_MS / 60_000
