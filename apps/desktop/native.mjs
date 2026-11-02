// Small pure helpers of the desktop shell, kept out of main.mjs so a test can load them without Electron.
// The right-click menu, as VS Code and Chrome show it: in a text box Cut, Copy, Paste, Select All (a misspelled word adds its
// suggestions on top); on selected text Copy; on an image Copy Image, on a link Copy Link Address (016 cC: both were missing);
// elsewhere nothing, so the page's own handlers see the click. copyImage/copyLink come from main.mjs (webContents, clipboard).
export function contextMenu({ isEditable, selectionText, editFlags = {}, misspelledWord, dictionarySuggestions = [], mediaType, hasImageContents, linkURL }, replace, learn, { copyImage, copyLink } = {}) {
  if (isEditable) {
    const spelling = misspelledWord ? [...dictionarySuggestions.slice(0, 5).map(label => ({ label, click: () => replace(label) })),
      { label: 'Add to dictionary', click: () => learn(misspelledWord) }, { type: 'separator' }] : [];
    return [...spelling, { role: 'cut', enabled: editFlags.canCut !== false }, { role: 'copy', enabled: editFlags.canCopy !== false },
      { role: 'paste', enabled: editFlags.canPaste !== false }, { type: 'separator' }, { role: 'selectAll' }];
  }
  const items = selectionText ? [{ role: 'copy' }] : [];
  if (mediaType === 'image' && hasImageContents !== false && copyImage) items.push({ label: 'Copy Image', click: copyImage });
  if (linkURL && copyLink) items.push({ label: 'Copy Link Address', click: () => copyLink(linkURL) });
  return items;
}
// Windows prints the full name in "net user <login>" as "Full Name   <name>"; the label is localized, so another language gets ''.
export const windowsFullName = text => /^[ \t]*Full Name[ \t]{2,}([^\r\n]*?)[ \t]*\r?$/m.exec(text)?.[1] ?? '';
