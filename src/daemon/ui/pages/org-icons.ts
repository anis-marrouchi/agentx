// --- Icons for the kind of org member (#1681) ---
//
// A person and an agent look different at a glance on /org and on the Hub's
// Org page: these icons sit beside the words "Person" and "Agent". Kept in a
// module of their own, with no imports, so both pages can use them without
// an import cycle. No backslashes: they go into client-script template literals.

export const PERSON_ICON = '<svg class="org-ico" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="5" r="3"/><path d="M2.5 14.5c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5"/></svg>'
export const AGENT_ICON = '<svg class="org-ico" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="5.5" width="11" height="8" rx="1.5"/><path d="M8 5.5V2.5M6 9.5h.01M10 9.5h.01"/></svg>'

