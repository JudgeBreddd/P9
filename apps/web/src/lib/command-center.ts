// Command Center (@duwop/command-center): the theme entries for command-center.css. All dark-only.
// Add them in lib/duwop-config.ts: import { commandCenter } from "./command-center"; ... extraThemes: commandCenter.

import type { Theme } from "./theme";

export const commandCenter: Theme[] = [
  { id: "event-horizon-prime", name: "Event Horizon Prime", note: "Blue, amber and violet light over deep space.", dark: true, font: "spacegrotesk", effects: ["underglow", "motion", "shine"], display: "Fraunces" },
  {
    id: "night-drive",
    name: "Night Drive",
    note: "Blue on night indigo (the Tokyo Night palette by enkia, MIT).",
    dark: true,
    font: "jetbrains",
    effects: ["underglow"],
  },
];
