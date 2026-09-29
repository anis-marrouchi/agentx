/** Cap for decision seats awaited before the agent spawns. A slow answer
 *  there delays every reply; the backend default (30s) suits offline
 *  seats. Kept apart from seat.ts so tests that mock the seat module keep
 *  a real constant. */
export const PRE_SPAWN_SEAT_TIMEOUT_MS = 1_500
