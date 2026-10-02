import { watch, type FSWatcher } from "fs"
import { basename, dirname } from "path"

/** Call `onChange` after the file at `path` is written, at most once per
 *  `debounceMs`. The folder is watched, not the file: an editor that saves
 *  by writing a new file over the old one leaves a watch on the file
 *  following the old one, blind to every later save. */
export function watchConfigFile(path: string, onChange: () => void, debounceMs = 500): FSWatcher {
  const name = basename(path)
  let timer: ReturnType<typeof setTimeout> | undefined
  const watcher = watch(dirname(path), { persistent: false }, (_event, changed) => {
    if (changed !== name) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(onChange, debounceMs)
  })
  watcher.on("close", () => { if (timer) clearTimeout(timer) })
  return watcher
}
