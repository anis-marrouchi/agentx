// The facts cap, in its own module: memory-store.ts and improve/tidy.ts
// import each other, so a constant one of them reads at load time must
// live in neither.

/** The most facts an agent keeps; prune drops the oldest past it. */
export const MAX_MEMORIES = 200
