import { parseTeamPackage, type TeamPackage, type TeamPackageInput } from "@/teams/package"
import { clientInbox } from "./client-inbox/team"
import { salesFollowUp } from "./sales-follow-up/team"
import { devTeam } from "./dev-team/team"
import { contentTeam } from "./content/team"
import { supportTeam } from "./support/team"

// The teams shipped with AgentX. Each folder holds the package (team.ts)
// and a README.md that opens with the result the team delivers; a test
// keeps the two in step.

const CATALOG: TeamPackageInput[] = [clientInbox, supportTeam, salesFollowUp, devTeam, contentTeam]

/** Shipped teams, parsed and checked like any imported package. */
export function shippedTeams(): TeamPackage[] {
  return CATALOG.map((t) => parseTeamPackage(t))
}

export function shippedTeam(name: string): TeamPackage | undefined {
  const raw = CATALOG.find((t) => t.name === name)
  return raw ? parseTeamPackage(raw) : undefined
}
