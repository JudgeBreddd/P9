// Glamours of the Gods (@duwop/gods): the theme entries for gods.css. Each has a light and a dark look
// (dark: "both"), so a site can offer light / dark / system (@duwop/mode) and still choose its own colours.
// Add them in lib/duwop-config.ts: import { gods } from "./gods"; ... extraThemes: gods.

import type { Theme } from "./theme";

const god = (id: string, name: string, note: string): Theme => ({
  id,
  name,
  note,
  dark: "both",
  display: "Cinzel",
  effects: ["underglow", "ambient"],
});

export const gods: Theme[] = [
  god("olympus", "Olympus", "White marble and gold."),
  god("hades", "Hades", "Obsidian, pomegranate and ember."),
];
