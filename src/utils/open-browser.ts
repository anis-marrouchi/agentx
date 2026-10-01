import { spawn } from "child_process"
import chalk from "chalk"

export function browserOpener(platform: string = process.platform): string {
  return platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open"
}

// A missing opener (a server has no xdg-open) arrives as an "error" event on
// the child, not as a throw. Unhandled, that event ends the process.
export function openBrowser(url: string, opener: string = browserOpener()): void {
  const failed = () => console.log(chalk.dim(`  Couldn't open a browser. Visit ${url}`))
  try {
    const child = spawn(opener, [url], { stdio: "ignore", detached: true })
    child.once("error", failed)
    child.unref()
  } catch {
    failed()
  }
}
