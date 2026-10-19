import type { NativeNotes } from "../types"
import { output as defaultOutput, type Output } from "./run"

// Apple Notes through JXA (osascript -l JavaScript). The folder, title
// and body travel as argv and are read by the script, never spliced into
// it, so nothing in them can run as code. Notes stores a body as HTML:
// the script escapes the text and keeps its line breaks. The first call
// from the daemon's process asks for the macOS Automation permission
// (System Settings › Privacy & Security › Automation › Notes).

export const NOTES_SCRIPT = `
function run(argv) {
  var folderName = argv[0], title = argv[1], body = argv[2]
  var Notes = Application("Notes")
  var esc = function (s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") }
  var folder = Notes.folders.whose({ name: folderName })()[0]
  if (!folder) {
    folder = Notes.Folder({ name: folderName })
    Notes.folders.push(folder)
    folder = Notes.folders.whose({ name: folderName })()[0]
  }
  var lines = body.split("\\n").map(function (l) { return "<div>" + (l ? esc(l) : "<br>") + "</div>" })
  // Notes takes the title from the first line: a name as well would show it twice.
  var note = Notes.Note({ body: "<div><h1>" + esc(title) + "</h1></div>" + lines.join("") })
  folder.notes.push(note)
  return note.id()
}
`

export function macosNotes(exec: Output = defaultOutput): NativeNotes {
  return {
    async add({ folder, title, body }) {
      const raw = await exec("/usr/bin/osascript", ["-l", "JavaScript", "-e", NOTES_SCRIPT, folder, title, body])
      const id = raw.trim()
      if (!id) throw new Error("Notes did not return the new note's id")
      return { id }
    },
  }
}
