// N1 point 7: each agent's mark, in one place. Views ask agentIcon(agent) and never draw their own, so a different mark
// replaces one here without touching a view. P9's own marks (no vendor logo), in the 24 px, 2 px-stroke style of the rest;
// they differ by shape, not only by colour (the colour is the view's, from the agent's data-agent).
const ic = d => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
const eyes = '<circle cx="9" cy="13" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="13" r="1.4" fill="currentColor" stroke="none"/>';
export const AGENT_ICONS = {
  // A round-cornered head with one antenna.
  claude: ic('<path d="M12 4v3"/><circle cx="12" cy="3" r="1"/><rect x="4" y="7" width="16" height="13" rx="4"/>' + eyes + '<path d="M9.5 17h5M2 12v3M22 12v3"/>'),
  // A square head with two antennas and a visor.
  codex: ic('<path d="M8 3v4M16 3v4"/><rect x="4" y="7" width="16" height="13" rx="1.5"/><rect x="7" y="11" width="10" height="4" rx="1"/><path d="M2 12v3M22 12v3"/>'),
  // Any other agent: a plain head.
  other: ic('<rect x="4" y="6" width="16" height="14" rx="3"/>' + eyes + '<path d="M2 12v3M22 12v3"/>'),
};
export const agentIcon = agent => AGENT_ICONS[agent] || AGENT_ICONS.other;
