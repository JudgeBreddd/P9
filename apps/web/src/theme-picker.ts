import { applyLook, loadLook, lookForTheme, allowedThemes, allThemes, allEffects, fonts, isDark, paletteVars, rollPalette, onLookChange, type Look } from './lib/theme';

// The look's colours as #rrggbbaa for the Dev Focus editor, which cannot read the oklch tokens: each one is painted on a
// 1x1 canvas and read back. Sent to main on every change (desktop only; the phone has no window.p9.look).
const EDITOR_TOKENS = ['background', 'foreground', 'card', 'primary', 'primary-foreground', 'muted', 'muted-foreground', 'accent', 'border', 'ring'];
function editorLook() {
  const css = getComputedStyle(document.documentElement), ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
  const hex = (token: string) => {
    ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = css.getPropertyValue('--' + token).trim(); ctx.fillRect(0, 0, 1, 1);
    return '#' + [...ctx.getImageData(0, 0, 1, 1).data].map(n => n.toString(16).padStart(2, '0')).join('');
  };
  return { dark: document.documentElement.classList.contains('dark'), colors: Object.fromEntries(EDITOR_TOKENS.map(token => [token, hex(token)])) };
}
export function shareLook(signal: AbortSignal) {
  const p9 = (window as any).p9;
  if (!p9?.look) return;
  const send = () => p9.look(editorLook()).catch(() => {});
  const stop = onLookChange(send); signal.addEventListener('abort', () => { stop(); });
  send();
}

// The picker is DUWOP's Appearance card (@duwop/appearance, appearance.tsx) without React: theme cards painted in
// their own theme, AMOLED, font and effects (Builder, 2026-10-19: "cards + all").
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') => {
  const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
};
// P9 bundles its fonts (loadFonts: false, a strict CSP), so the picker offers only those it has an @font-face for, plus System.
const bundled = (family: string) => !family || [...document.fonts].some(face => face.family.replace(/"/g, '') === family);
const offeredFonts = () => fonts.filter(font => bundled(font.family));
function toggleSwitch(label: string, note: string, attribute: string, onclick: () => void) {
  const row = el('label', 'fx-row'), button = el('button', 'switch'), text = el('span', '', label);
  button.type = 'button'; button.setAttribute('role', 'switch'); button.setAttribute('aria-label', label); button.setAttribute(attribute.split('=')[0], attribute.split('=')[1] ?? '');
  button.onclick = () => { onclick(); refresh(); };
  text.append(el('small', '', note)); row.append(button, text);
  return row;
}

function refresh() {
  const look = loadLook(), theme = allThemes.find(t => t.id === look.theme);
  const all = <T extends HTMLElement>(selector: string) => document.querySelectorAll<T>(selector);
  all('[data-theme-pick]').forEach(card => {
    card.setAttribute('aria-pressed', String(card.dataset.themePick === look.theme));
    card.toggleAttribute('data-amoled', look.amoled);
    if (card.dataset.themePick === 'custom' && look.palette) for (const [k, v] of Object.entries(paletteVars(look.palette))) card.style.setProperty(k, v);
  });
  all('[data-font-pick]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.fontPick === look.font)));
  all('[data-font-note]').forEach(note => { note.textContent = fonts.find(f => f.id === look.font)?.note ?? ''; });
  const backdrop = look.effects.includes('ambient') || look.effects.includes('horizon');
  all<HTMLButtonElement>('[data-fx-pick]').forEach(button => {
    button.setAttribute('aria-checked', String(look.effects.includes(button.dataset.fxPick!)));
    button.disabled = button.dataset.fxPick === 'motion' && !backdrop;
  });
  all<HTMLButtonElement>('[data-amoled-switch]').forEach(button => { button.setAttribute('aria-checked', String(look.amoled)); button.disabled = !theme?.dark; });
  all('[data-roll]').forEach(button => { button.hidden = look.theme !== 'custom'; });
  all('[data-theme-label]').forEach(label => { label.textContent = allowedThemes().find(t => t.id === look.theme)?.name ?? ''; });
}
function change(patch: Partial<Look>) { applyLook({ ...loadLook(), ...patch }); refresh(); }
function set(id: string) {
  const look = loadLook();
  change({ ...lookForTheme(id, look), palette: id === 'custom' ? (look.palette ?? rollPalette()) : look.palette });
}

export const DUWOP = {
  init() { applyLook(loadLook()); refresh(); },
  set,
  menu(container: HTMLElement) {
    container.classList.add('theme-pop');
    const look = loadLook();
    container.append(el('div', 'hd eyebrow', 'Theme'));
    const grid = el('div', 'tgrid');
    for (const theme of allowedThemes()) {
      // The card carries the theme itself (and AMOLED), so it shows the real colours.
      const card = el('button', 'tcard'); card.type = 'button';
      card.dataset.themePick = card.dataset.theme = theme.id;
      card.classList.toggle('dark', isDark(theme, look.mode));
      const dots = el('span', 'dots'); dots.append(el('i'), el('i'), el('i'));
      card.append(dots, el('b', '', theme.name), el('small', '', theme.note));
      card.onclick = () => set(theme.id); grid.append(card);
    }
    const roll = el('button', 'roll', 'Roll again'); roll.type = 'button'; roll.dataset.roll = '';
    roll.onclick = () => change({ palette: rollPalette() });
    container.append(grid, roll, el('p', 'tnote', 'Picking a theme also sets its own font and effects. You can change them below.'),
      toggleSwitch('AMOLED mode', 'True black backgrounds: easier on OLED screens and their batteries. Works with every dark theme.', 'data-amoled-switch',
        () => change({ amoled: !loadLook().amoled })));
    container.append(el('div', 'hd eyebrow sect', 'Font'));
    const fontGrid = el('div', 'fgrid');
    for (const font of offeredFonts()) {
      const button = el('button', 'fbtn', font.name); button.type = 'button'; button.dataset.fontPick = font.id; button.title = font.note;
      button.onclick = () => change({ font: font.id }); fontGrid.append(button);
    }
    const fontNote = el('p', 'tnote'); fontNote.dataset.fontNote = '';
    container.append(fontGrid, fontNote, el('div', 'hd eyebrow sect', 'Effects'));
    for (const effect of allEffects) container.append(toggleSwitch(effect.name, effect.note, 'data-fx-pick=' + effect.id, () => {
      const effects = loadLook().effects;
      change({ effects: effects.includes(effect.id) ? effects.filter(e => e !== effect.id) : [...effects, effect.id] });
    }));
    container.append(el('p', 'tnote', 'Movement is switched off if your device is set to reduce motion.'));
    refresh();
  },
};
