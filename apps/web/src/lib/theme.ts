// DUWOP theme (@duwop/theme). Each theme is a set of colour tokens in duwop.css, selected by data-theme on
// <html>; effects are words in data-fx; AMOLED is data-amoled; the font is --app-font. applyLook puts a
// look on the page and saves it to localStorage, so the boot script can apply it before the app loads
// (no flash). Apps that also save it elsewhere (a server, an account) subscribe with onLookChange.

import { duwopConfig } from "./duwop-config";

export type Theme = {
  id: string;
  name: string;
  note: string;
  /** true / false for a fixed look; "both" for themes with a light and a dark look (the mode picks). */
  dark: boolean | "both";
  /** Font id this theme looks best with. A picker can offer it; applyLook never forces it. */
  font?: string;
  /** Effect ids this theme looks best with. */
  effects?: string[];
  /** A Google Fonts family for page titles (.fx-title), loaded with the theme. */
  display?: string;
};

export const themes: Theme[] = [
  { id: "duskwood", name: "Duskwood", note: "Gold on deep ink. The house look.", dark: true },
  { id: "midnight", name: "Midnight", note: "Electric blue, after dark.", dark: true },
  { id: "ember", name: "Ember", note: "Warm orange glow.", dark: true },
  { id: "forest", name: "Forest", note: "Deep green and emerald.", dark: true },
  { id: "synthwave", name: "Synthwave", note: "Neon pink and cyan.", dark: true },
  { id: "rose", name: "Rose", note: "Soft pink on plum.", dark: true },
  { id: "arctic", name: "Arctic", note: "Ice blue on slate.", dark: true },
  { id: "mono", name: "Mono", note: "Black and white, no colour.", dark: true },
  {
    id: "outrun",
    name: "Outrun",
    note: "80s arcade racer: sunset orange on violet.",
    dark: true,
    font: "chakra",
    effects: ["underglow", "ambient", "horizon", "motion"],
  },
  {
    id: "cyberpunk",
    name: "Cyberpunk",
    note: "Hazard yellow and cyan, hard edges.",
    dark: true,
    font: "chakra",
    effects: ["underglow", "neon"],
    display: "Orbitron",
  },
  {
    id: "8bit",
    name: "8-bit",
    note: "Pixel frames, arcade titles, cartridge colours.",
    dark: true,
    font: "pixelify",
    effects: ["underglow"],
    display: "Press Start 2P",
  },
  {
    id: "ascii",
    name: "ASCII",
    note: "Green phosphor terminal: text boxes, [ buttons ], scanlines.",
    dark: true,
    font: "jetbrains",
    effects: ["underglow", "neon"],
  },
  { id: "custom", name: "Roll the dice", note: "A random palette. Roll again for another.", dark: true },
  { id: "daylight", name: "Daylight", note: "Light mode.", dark: false },
  {
    id: "linen",
    name: "Linen",
    note: "Scandi neutrals: oat, clay and sage.",
    dark: false,
    font: "outfit",
    display: "Fraunces",
  },
];

export const effects = [
  { id: "underglow", name: "Underglow", note: "Cards lift and glow in the theme's colour when you point at them." },
  { id: "ambient", name: "Ambient glow", note: "A soft wash of the theme's colours behind the page." },
  { id: "motion", name: "Drifting glow", note: "Moves the ambient glow and the horizon grid. Needs one of them on." },
  { id: "shine", name: "Shine", note: "A sweep of light across a card on hover." },
  { id: "horizon", name: "Horizon", note: "An 80s neon grid running to the horizon." },
  { id: "neon", name: "Neon", note: "Headings glow like neon tubes, with the odd flicker." },
] as const;

/** The core effects plus this app's opt-in add-ons (extraEffects in duwop-config), for the picker. */
export const allEffects = [...effects, ...(duwopConfig.extraEffects ?? [])];

/** The core themes plus this app's add-on themes (extraThemes in duwop-config, e.g. @duwop/gods). */
export const allThemes: Theme[] = [...themes, ...(duwopConfig.extraThemes ?? [])];

/** Fonts from Google Fonts, loaded only when picked. Inter is the default; System needs no download. */
export const fonts = [
  // adjust: a font-size-adjust value that gives each font about the same text width as Inter, so switching
  // fonts never reshapes the layout (measured in Chromium; JetBrains Mono was 19% wider, Outfit 9% narrower).
  { id: "inter", name: "Inter", family: "Inter", adjust: 0, note: "The default. Clean and neutral." },
  { id: "system", name: "System", family: "", adjust: 0.539, note: "Your device's own font. Nothing to download." },
  { id: "outfit", name: "Outfit", family: "Outfit", adjust: 0.521, note: "Round and friendly." },
  { id: "spacegrotesk", name: "Space Grotesk", family: "Space Grotesk", adjust: 0.481, note: "Techy, a bit quirky." },
  { id: "lexend", name: "Lexend", family: "Lexend", adjust: 0.525, note: "Wide and easy to read." },
  {
    id: "atkinson",
    name: "Atkinson Hyperlegible",
    family: "Atkinson Hyperlegible",
    adjust: 0.537,
    note: "Made for low vision.",
  },
  { id: "nunito", name: "Nunito", family: "Nunito", adjust: 0.505, note: "Soft rounded ends." },
  { id: "jetbrains", name: "JetBrains Mono", family: "JetBrains Mono", adjust: 0.466, note: "Monospace, for the nerds." },
  { id: "pixelify", name: "Pixelify Sans", family: "Pixelify Sans", adjust: 0.453, note: "Chunky pixels, 8-bit style." },
  { id: "chakra", name: "Chakra Petch", family: "Chakra Petch", adjust: 0.529, note: "Squared-off, sci-fi HUD." },
] as const;

/**
 * The look after picking a theme: its own font and effects, or the defaults when it has none. A font another
 * theme brought along goes back to the default; one the person picked themselves stays. (Builder 2026-10-10:
 * themes should look the part without a separate "Use them" step.)
 */
export function lookForTheme(id: string, look: Look): Look {
  const theme = allThemes.find((t) => t.id === id) ?? themes[0];
  const themeFonts = new Set(themes.map((t) => t.font).filter(Boolean));
  const font = theme.font ?? (themeFonts.has(look.font) ? duwopConfig.defaultLook.font : look.font);
  // Add-on effects (popcorn and the like) aren't part of any theme's look, so switching themes keeps them.
  const addOns = look.effects.filter((e) => duwopConfig.extraEffects?.some((x) => x.id === e));
  return { ...look, theme: theme.id, font, effects: [...(theme.effects ?? duwopConfig.defaultLook.effects), ...addOns] };
}

const googleFont = (family: string) =>
  `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@400;500;600;700&display=swap`;

/** A rolled palette: neutral hue and chroma, accent hue, second-glow hue. */
export type Palette = { nh: number; nc: number; ph: number; gh: number };

/** light / dark / system, for themes with both looks. System follows the device and updates live. */
export type Mode = "light" | "dark" | "system";

export type Look = { theme: string; effects: string[]; amoled: boolean; font: string; palette?: Palette; mode?: Mode };

const prefersDark = () => typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;

/** Whether a theme shows dark under a mode. Fixed themes ignore the mode; "both" themes follow it (default: dark). */
export const isDark = (theme: Theme, mode: Mode = "dark") =>
  theme.dark !== "both" ? theme.dark : mode === "system" ? prefersDark() : mode === "dark";

/** The themes this app lets users pick (lib/duwop-config.ts). */
export const allowedThemes = () =>
  duwopConfig.themes === "all" ? allThemes : allThemes.filter((t) => duwopConfig.themes.includes(t.id));

/** A random, readable palette for the "custom" theme: any neutral hue, an accent on the opposite side of
 *  the wheel, lightness and chroma kept in the range every other dark theme uses. */
export function rollPalette(): Palette {
  const nh = Math.round(Math.random() * 360);
  const ph = Math.round(nh + 120 + Math.random() * 120) % 360;
  return { nh, nc: Math.round((0.01 + Math.random() * 0.04) * 1000) / 1000, ph, gh: (ph + 40 + Math.round(Math.random() * 60)) % 360 };
}

/** The CSS variables a palette sets on <html>. */
export const paletteVars = (p: Palette): Record<string, string> => ({
  "--nh": String(p.nh),
  "--nc": String(p.nc),
  "--primary": `oklch(0.78 0.16 ${p.ph})`,
  "--glow2": `oklch(0.68 0.18 ${p.gh})`,
});
const PALETTE_VARS = ["--nh", "--nc", "--primary", "--glow2"];

/** Theme ids that were renamed, so looks saved under the old id keep working. duwop-boot.js has its own copy. */
export const renamedThemes: Record<string, string> = { trove: "duskwood" };
const current = (look: Look): Look =>
  renamedThemes[look.theme] ? { ...look, theme: renamedThemes[look.theme] } : look;

const listeners = new Set<(look: Look) => void>();

// The look on the page now. When it's in system mode, a change on the device (sunset, a settings toggle) re-applies it.
let shown: Look | null = null;
if (typeof matchMedia === "function")
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (shown?.mode === "system") applyLook(shown);
  });

/** Runs fn every time applyLook runs. Returns a function that unsubscribes. */
export function onLookChange(fn: (look: Look) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The saved look, or the app's default. */
export function loadLook(): Look {
  try {
    const saved = JSON.parse(localStorage.getItem(duwopConfig.storageKey) || "null");
    if (saved?.theme && Array.isArray(saved.effects)) return current(saved);
  } catch {
    // Storage blocked or bad JSON: fall through to the default.
  }
  return duwopConfig.defaultLook;
}

/** Puts a look on the page now, remembers it for the next load, and tells onLookChange subscribers.
 *  Returns the look as applied (the "custom" theme gains a palette if it had none). */
export function applyLook(look: Look): Look {
  look = current(look);
  const html = document.documentElement;
  const theme = allThemes.find((t) => t.id === look.theme) ?? themes[0];
  const font = fonts.find((f) => f.id === look.font) ?? fonts[0];
  // loadFonts: false = the app hosts its fonts itself (a strict CSP, no Google calls); only the names are set.
  const google = duwopConfig.loadFonts !== false;
  const url = google && font.family ? googleFont(font.family) : "";
  // Press Start 2P has only a regular weight; asking for others fails the whole request.
  const displayUrl = google && theme.display
    ? `https://fonts.googleapis.com/css2?family=${encodeURIComponent(theme.display)}&display=swap`
    : "";
  if (theme.id === "custom" && !look.palette) look = { ...look, palette: rollPalette() };
  const vars = theme.id === "custom" && look.palette ? paletteVars(look.palette) : {};

  html.dataset.theme = theme.id;
  html.dataset.fx = look.effects.join(" ");
  const dark = isDark(theme, look.mode);
  shown = look;
  html.classList.toggle("dark", dark);
  html.toggleAttribute("data-amoled", look.amoled);
  html.style.setProperty("--app-font", font.family ? `"${font.family}"` : "system-ui");
  if (font.adjust) html.style.setProperty("--app-font-adjust", String(font.adjust));
  else html.style.removeProperty("--app-font-adjust");
  for (const v of PALETTE_VARS) html.style.removeProperty(v);
  for (const [k, v] of Object.entries(vars)) html.style.setProperty(k, v);
  if (theme.display) html.style.setProperty("--app-display", `"${theme.display}"`);
  else html.style.removeProperty("--app-display");
  loadFont(url);
  loadFont(displayUrl, "app-display-font");

  try {
    // The boot script reads this copy, so it carries everything needed to paint without this module.
    localStorage.setItem(
      duwopConfig.storageKey,
      JSON.stringify({
        ...look,
        dark,
        both: theme.dark === "both",
        family: font.family,
        adjust: font.adjust,
        url,
        vars,
        display: theme.display ?? "",
        displayUrl,
      }),
    );
  } catch {
    // Private windows can refuse storage; the look still applies for this visit.
  }
  for (const fn of listeners) fn(look);
  return look;
}

function loadFont(url: string, id = "app-font") {
  let link = document.getElementById(id) as HTMLLinkElement | null;
  if (!url) return link?.remove();
  if (!link) {
    link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    document.head.append(link);
  }
  if (link.href !== url) link.href = url;
}
