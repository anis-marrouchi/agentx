import { TEAM_FORMAT, type TeamPackageInput } from "@/teams/package"

export const devTeam: TeamPackageInput = {
  format: TEAM_FORMAT,
  name: "dev-team",
  title: "Dev team on GitLab",
  result: "Issues you assign on GitLab come back as merge requests with a second agent's review, and each weekday morning you see what is stuck.",
  description: "A developer agent turns assigned issues into merge requests, a reviewer agent reviews every merge request, and a morning digest lists what waits on you.",
  agents: {
    dev: {
      name: "Developer",
      mentions: ["@dev", "dev"],
      maxExecutionMinutes: 60,
      systemPrompt: [
        "You are the developer on this project's GitLab.",
        "When an issue is assigned to you, read it, ask one question if it is unclear, then work on a branch and open a merge request that links the issue.",
        "Keep each merge request small and say in its description what changed and how you checked it.",
        "Never push to the default branch and never merge. Ask @reviewer for a review when the merge request is ready.",
      ].join("\n"),
      skills: {
        "issue-to-merge-request": {
          "SKILL.md": [
            "---",
            "name: issue-to-merge-request",
            "description: Turn an assigned GitLab issue into a small, checked merge request.",
            "---",
            "",
            "# From issue to merge request",
            "",
            "1. Read the issue and its comments. If the expected result is not clear, ask one question on the issue and stop.",
            "2. Create a branch named after the issue number, for example `42-fix-login-redirect`.",
            "3. Make the smallest change that delivers the result. Add or update a test that shows it.",
            "4. Run the project's tests and linter. Do not open the merge request while they fail.",
            "5. Open the merge request with `Closes #<issue>` in the description, a two-line summary and how you checked it.",
            "6. Mention @reviewer on the merge request.",
            "",
          ].join("\n"),
        },
      },
    },
    reviewer: {
      name: "Reviewer",
      mentions: ["@reviewer", "reviewer"],
      systemPrompt: [
        "You review merge requests on this project's GitLab.",
        "Look for bugs, missing tests and changes the issue did not ask for. Be specific: name the file and line, and say what to change.",
        "Approve when it is ready. You never merge; the owner merges.",
      ].join("\n"),
      skills: {
        "merge-request-review": {
          "SKILL.md": [
            "---",
            "name: merge-request-review",
            "description: Review a GitLab merge request for bugs, missing tests and scope.",
            "---",
            "",
            "# Reviewing a merge request",
            "",
            "1. Read the linked issue first, then the whole diff.",
            "2. Check that the change does what the issue asks, and nothing else.",
            "3. Check that a test covers the change and that the pipeline is green.",
            "4. Leave one comment per problem, on the line it is about, with the change you want.",
            "5. End with one summary comment: approve, or the list of what must change first.",
            "",
          ].join("\n"),
        },
      },
    },
  },
  schedules: {
    "dev-morning-digest": {
      agent: "reviewer",
      schedule: "30 8 * * 1-5",
      prompt: "Write the morning digest for the owner: merge requests waiting for the owner to merge, merge requests with an open review for more than two days, and assigned issues with no merge request yet. One line each with its link. If nothing is stuck, say so in one line.",
      timeout: 900,
      maxOutputTokens: 800,
      autonomy: "report",
    },
  },
  channels: [
    { kind: "gitlab", agent: "dev", why: "issues assigned to @dev start its work" },
    { kind: "gitlab", agent: "reviewer", why: "merge requests that mention @reviewer get a review" },
  ],
}
