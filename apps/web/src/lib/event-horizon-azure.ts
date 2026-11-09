import type { Theme } from "./theme";

// P9's own theme (not a DUWOP pack): colours in event-horizon-azure.css; the Dev Focus editor has a matching theme
// (apps/dev/public/event-horizon-azure-theme.json) with its syntax colours.
export const eventHorizonAzure: Theme[] = [
  {
    id: "p9-event-horizon-azure",
    name: "Event Horizon Azure",
    note: "Near-black navy, violet structure, azure behaviour, amber literals.",
    dark: true,
    effects: [],
  },
];
