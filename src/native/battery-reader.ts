// --- Where the battery sensor's reader works (#863) ---
//
// The battery sensor (src/sensors) reads `pmset -g batt`, which only macOS
// has. The core asks here instead of naming the OS, so another OS's reader
// is added in src/native/ (#1062).

const BATTERY_READER_PLATFORMS: readonly NodeJS.Platform[] = ["darwin"]

/** Null when this platform has a battery reader, otherwise why not. */
export function batteryReaderMissing(platform: NodeJS.Platform = process.platform): string | null {
  return BATTERY_READER_PLATFORMS.includes(platform) ? null : `a battery sensor reads pmset, which only macOS has (this node is ${platform})`
}
