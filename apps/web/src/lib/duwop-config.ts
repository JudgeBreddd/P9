// This app's DUWOP settings (@duwop/theme). The one file an app edits: which look new visitors get,
// and which themes its users may pick. Theme, effect and font ids are listed in ./theme.ts.

import { commandCenter } from "./command-center";
import { gods } from "./gods";
import type { Look, Theme } from "./theme";

export const duwopConfig: {
  /** localStorage key for the saved look. Give each app its own so two apps on one domain don't clash. */
  storageKey: string;
  /** What a first-time visitor sees. */
  defaultLook: Look;
  /** Theme ids users may pick, or "all". "custom" is the random palette roller. */
  themes: string[] | "all";
  /** Opt-in effects from add-on items (e.g. @duwop/popcorn), shown in the picker after the core ones. */
  extraEffects?: { id: string; name: string; note: string }[];
  /** Themes from add-on packs (e.g. @duwop/gods: extraThemes: gods), offered after the core ones. */
  extraThemes?: Theme[];
  /** false when the app hosts its own fonts (e.g. @fontsource, for a strict CSP): DUWOP then never calls Google Fonts. */
  loadFonts?: boolean;
} = {
  storageKey: "p9-look",
  defaultLook: { theme: "event-horizon-prime", effects: ["underglow", "motion", "shine"], amoled: true, font: "spacegrotesk" },
  themes: "all",  // Builder, 2026-10-19: "add the rest of the duwop themes"
  extraThemes: [...commandCenter, ...gods],
  loadFonts: false,
};
