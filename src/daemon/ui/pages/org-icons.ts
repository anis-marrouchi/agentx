// --- Person and agent icons for the org charts (#1681) ---
//
// One look on /org and on the Hub Org page: a head and shoulders for a
// person, a robot for an agent. Filled with currentColor; the robot's eyes
// take the class `org-eye` so a page paints them in its card colour. No
// single quotes or backslashes: both pages splice them into client JS.

export const ORG_PERSON_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><circle cx="8" cy="4.75" r="3"/><path d="M1.75 15c0-3.4 2.8-5.75 6.25-5.75s6.25 2.35 6.25 5.75z"/></svg>'

export const ORG_AGENT_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><circle cx="8" cy="1.75" r="1.25"/><rect x="7.4" y="2.5" width="1.2" height="2.5"/><rect x="2" y="5" width="12" height="9.5" rx="2.5"/><circle cx="5.6" cy="9.5" r="1.3" class="org-eye"/><circle cx="10.4" cy="9.5" r="1.3" class="org-eye"/></svg>'
