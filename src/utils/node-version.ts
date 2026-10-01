// No imports here: src/cli.ts runs this before it loads anything else.

// Keep in step with package.json "engines": undici 8 needs 22.19, and
// better-sqlite3 ships prebuilt binaries up to Node 26.
export function nodeVersionSupported(version: string): boolean {
  const [major, minor] = version.split(".").map(Number)
  return (major === 22 && minor >= 19) || (major >= 23 && major <= 26)
}

export function unsupportedNodeMessage(version: string): string | null {
  if (nodeVersionSupported(version)) return null
  return `AgentX needs Node.js 22.19 or newer, up to 26. This is Node.js ${version}.`
}
