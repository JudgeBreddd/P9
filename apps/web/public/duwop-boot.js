// DUWOP boot (@duwop/boot). Puts the saved look on <html> before the page paints, so there's no flash of
// the wrong theme. Must load as a plain blocking script in <head> (not type="module", not async/defer).
//   Vite:  <script src="/duwop-boot.js" data-key="duwop-look"></script> in index.html
//   Astro: <DuwopBoot /> in the layout's <head> (it adds this script with the app's config)
// data-key is the app's storageKey; data-default (optional) is the look for first-time visitors.
// It reads the copy lib/theme.ts applyLook saves, which already carries everything needed to paint.
(() => {
  const me = document.currentScript;
  try {
    const key = (me && me.dataset.key) || "duwop-look";
    const look = JSON.parse(localStorage.getItem(key) || (me && me.dataset.default) || "null");
    if (!look || !look.theme) return;
    const html = document.documentElement;
    // Renamed themes (lib/theme.ts renamedThemes): old saved ids still paint the right theme.
    html.dataset.theme = { trove: "duskwood" }[look.theme] || look.theme;
    html.dataset.fx = (look.effects || []).join(" ");
    // Themes with both looks follow the saved mode; "system" asks the device (lib/theme.ts isDark does the same).
    const mode = look.mode || "dark";
    const dark = !look.both
      ? look.dark !== false
      : mode === "system"
        ? matchMedia("(prefers-color-scheme: dark)").matches
        : mode === "dark";
    html.classList.toggle("dark", dark);
    html.toggleAttribute("data-amoled", !!look.amoled);
    if (look.family !== undefined) html.style.setProperty("--app-font", look.family ? `"${look.family}"` : "system-ui");
    if (look.adjust) html.style.setProperty("--app-font-adjust", String(look.adjust));
    for (const [k, v] of Object.entries(look.vars || {})) html.style.setProperty(k, v);
    if (look.display) html.style.setProperty("--app-display", `"${look.display}"`);
    for (const [id, href] of [
      ["app-font", look.url],
      ["app-display-font", look.displayUrl],
    ]) {
      if (!href) continue;
      const link = document.createElement("link");
      link.id = id;
      link.rel = "stylesheet";
      link.href = href;
      document.head.append(link);
    }
  } catch {
    // Storage blocked or bad JSON: the app applies its default once it loads.
  }
})();
