import { execFile } from "child_process"

/**
 * execFile, not exec — an entity name is untrusted input that reaches
 * this from chat messages and GitLab issue titles. Through a shell,
 * a contact called `; rm -rf ~` is a command. execFile passes argv
 * directly and never opens one.
 */
export function run(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        timeout: opts.timeoutMs ?? 15_000,
        signal: opts.signal,
        maxBuffer: 4 * 1024 * 1024,
        // The daemon's PATH is not a login shell's. wacli and gog live in
        // Homebrew, and ~/.local/bin is where the fleet's own tools land.
        env: {
          ...process.env,
          PATH: [
            process.env.PATH ?? "",
            "/opt/homebrew/bin",
            "/usr/local/bin",
            `${process.env.HOME ?? ""}/.local/bin`,
          ].filter(Boolean).join(":"),
        },
      },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === "number"
          ? ((err as { code: number }).code)
          : err ? 1 : 0
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code })
      },
    )
  })
}

export async function binaryExists(cmd: string): Promise<boolean> {
  const { code } = await run("command", ["-v", cmd], { timeoutMs: 3000 }).catch(() => ({ code: 1 }) as never)
  if (code === 0) return true
  // `command` is a shell builtin, so the above fails on most systems.
  const { code: which } = await run("/usr/bin/which", [cmd], { timeoutMs: 3000 })
  return which === 0
}
