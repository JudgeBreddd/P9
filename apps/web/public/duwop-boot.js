// DUWOP boot (@duwop/boot). Puts the saved look on <html> before the page paints, so there's no flash of
// the wrong theme. Must load as a plain blocking script in <head> (not type="module", not async/defer).
//   Vite:  <script src="/duwop-boot.js" data-key="duwop-look"></script> in index.html
//   Astro: <DuwopBoot /> in the layout's <head> (it adds this script with the app's config)
// data-key is the app's storageKey; data-default (optional) is the look for first-time visitors.
// data-themes and data-effects (optional): JSON lists of the theme and effect ids the app has.
// It reads the copy lib/theme.ts applyLook saves, which already carries everything needed to paint.
(() => {
  const me = document.currentScript;
  try {
    const key = (me && me.dataset.key) || "duwop-look";
    let look = JSON.parse(localStorage.getItem(key) || (me && me.dataset.default) || "null");
    // data-themes and data-effects (optional) are the ids the app has (lib/theme.ts allThemes, allEffects). A look saved under a
    // theme the app no longer has paints as a first visit, and an effect it no longer has is dropped (O119; current() does the same).
    const has = (k) => JSON.parse((me && me.dataset[k]) || "null");
    const themes = has("themes"), effects = has("effects");
    // Renamed themes (lib/theme.ts renamedThemes): old saved ids still paint the right theme.
    const id = look && ({ trove: "duskwood" }[look.theme] || look.theme);
    if (look && themes && !themes.includes(id)) look = JSON.parse((me && me.dataset.default) || "null");
    if (!look || !look.theme) return;
    const html = document.documentElement;
    html.dataset.theme = { trove: "duskwood" }[look.theme] || look.theme;
    html.dataset.fx = (look.effects || []).filter((e) => !effects || effects.includes(e)).join(" ");
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
