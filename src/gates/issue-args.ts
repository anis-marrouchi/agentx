import { parseShell } from "@/guard/file-access"

export interface IssueCreateArgs {
  description: string
  hasMilestone: boolean
}

/** Read literal glab issue creates. An unparsed command is left to GitLab. */
export function readIssueCreates(command: string): IssueCreateArgs[] {
  // The general shell parser does not retain expansions or heredoc bodies.
  // Leave those commands alone until their arguments can be read reliably.
  if (/[$`<]/.test(command)) return []

  const creates: IssueCreateArgs[] = []
  for (const { words, files } of parseShell(command)) {
    const [tool, group, action, ...args] = words
    if (!tool || !/(^|\/)glab$/.test(tool) || group !== "issue" || action !== "create" || files.length) continue
    const issue = readIssueFlags(args)
    if (issue) creates.push(issue)
  }
  return creates
}

const VALUE_FLAGS = new Set([
  "-t", "--title", "-a", "--assignee", "-l", "--label", "-R", "--repo",
  "--linked-issues", "--issue-type", "--weight", "--due-date", "--time-estimate",
])
const BOOLEAN_FLAGS = new Set(["-y", "--yes", "-c", "--confidential", "--no-editor", "--web"])

function readIssueFlags(args: string[]): IssueCreateArgs | null {
  let description: string | undefined
  let hasMilestone = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    const separator = arg.indexOf("=")
    const flag = separator < 0 ? arg : arg.slice(0, separator)
    if (BOOLEAN_FLAGS.has(flag) && separator < 0) continue

    if (flag !== "-d" && flag !== "--description" && flag !== "-m" && flag !== "--milestone" && !VALUE_FLAGS.has(flag)) return null
    const value = separator < 0 ? args[++index] : arg.slice(separator + 1)
    if (value === undefined || (separator < 0 && /^--?[a-z]/i.test(value))) return null
    if (flag === "-d" || flag === "--description") description = value
    if (flag === "-m" || flag === "--milestone") hasMilestone = value.trim().length > 0
  }
  return description === undefined ? null : { description, hasMilestone }
}
