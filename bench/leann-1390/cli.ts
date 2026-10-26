// Entry point for `pnpm bench:leann`. See bench/leann-1390/README.md.

import { gradeRuns } from "./grade"
import { runArm } from "./run"

const [cmd, ...rest] = process.argv.slice(2)
if (cmd === "run") runArm(rest)
else if (cmd === "grade") gradeRuns(rest)
else {
  process.stderr.write("usage: pnpm bench:leann run <state-dir> --arm A|B | pnpm bench:leann grade <state-dir>\n")
  process.exit(2)
}
