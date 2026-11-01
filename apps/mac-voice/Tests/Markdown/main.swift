// Tests for Markdown tables in the answer card.
// Run with ../../test.sh.
import Foundation

var failures = 0
func check(_ ok: Bool, _ what: String) {
    print("\(ok ? "ok  " : "FAIL") \(what)")
    if !ok { failures += 1 }
}

let table = Markdown.toHTML("""
Results:

| Name | Count | Note |
|:-----|------:|:----:|
| **a** | 1 | `x\\|y` |
| b | 22 |
""")
check(table.contains("<table>"), "a pipe table renders as a table")
check(table.contains("<th style=\"text-align:left\">Name</th><th style=\"text-align:right\">Count</th><th style=\"text-align:center\">Note</th>"), "header cells keep their alignment")
check(table.contains("<td style=\"text-align:left\"><strong>a</strong></td><td style=\"text-align:right\">1</td>"), "body cells get inline markdown and alignment")
check(table.contains("<code>x|y</code>"), "an escaped pipe stays inside its cell")
check(table.contains("<td style=\"text-align:right\">22</td><td style=\"text-align:center\"></td></tr>"), "a short row is padded to the header width")
check(!table.contains("|---") && !table.contains("<p>|"), "no raw pipes or separator row left")
check(table.contains("<div class=\"md-table\">"), "the table sits in a scrollable wrapper")

let bare = Markdown.toHTML("Name | Count\n--- | ---\nb | 2\n\nafter")
check(bare.contains("<th>Name</th><th>Count</th>") && bare.contains("<td>b</td><td>2</td>"), "a table without outer pipes renders")
check(bare.contains("</table></div><p></p><p>after</p>"), "the table ends at a blank line")

let notTable = Markdown.toHTML("a | b\nplain text")
check(!notTable.contains("<table>"), "a line with a pipe but no separator stays text")
check(!Markdown.toHTML("a | b\n---").contains("<table>"), "a rule under a two-cell line is not a one-column table")

let afterList = Markdown.toHTML("- item\n| a | b |\n|---|---|\n| 1 | 2 |")
check(afterList.contains("</ul><div class=\"md-table\"><table>"), "a table closes an open list")

let fenced = Markdown.toHTML("```\n| a | b |\n|---|---|\n```")
check(!fenced.contains("<table>"), "a table inside a code fence stays code")

if failures > 0 { print("\(failures) failed"); exit(1) }
print("all passed")
