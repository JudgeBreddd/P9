// Command Center (@duwop/command-center): the theme entries for command-center.css. All dark-only.
// Add them in lib/duwop-config.ts: import { commandCenter } from "./command-center"; ... extraThemes: commandCenter.

import type { Theme } from "./theme";

export const commandCenter: Theme[] = [
  { id: "event-horizon-prime", name: "Event Horizon Prime", note: "Blue, amber and violet light over deep space.", dark: true, font: "spacegrotesk", effects: ["underglow", "motion", "shine"], display: "Fraunces" },
  {
    id: "redline",
    name: "Redline",
    note: "True black, gunmetal and a red glow behind every card.",
    dark: true,
    font: "jetbrains",
    effects: ["underglow", "ambient"],
  },
  {
    id: "night-drive",
    name: "Night Drive",
    note: "Blue on night indigo (the Tokyo Night palette by enkia, MIT).",
    dark: true,
    font: "jetbrains",
    effects: ["underglow"],
  },
  {
    id: "event-horizon",
    name: "Event Horizon",
    note: "Near-black and steel blue. Glows only when you point at it.",
    dark: true,
    font: "spacegrotesk",
    effects: ["underglow"],
  },
];
