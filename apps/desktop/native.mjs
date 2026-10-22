// Small pure helpers of the desktop shell, kept out of main.mjs so a test can load them without Electron.
// The right-click menu, as VS Code and Chrome show it: in a text box Cut, Copy, Paste, Select All (a misspelled word adds its
// suggestions on top); on selected text Copy; elsewhere nothing, so the page's own handlers see the click.
export function contextMenu({ isEditable, selectionText, editFlags = {}, misspelledWord, dictionarySuggestions = [] }, replace, learn) {
  if (isEditable) {
    const spelling = misspelledWord ? [...dictionarySuggestions.slice(0, 5).map(label => ({ label, click: () => replace(label) })),
      { label: 'Add to dictionary', click: () => learn(misspelledWord) }, { type: 'separator' }] : [];
    return [...spelling, { role: 'cut', enabled: editFlags.canCut !== false }, { role: 'copy', enabled: editFlags.canCopy !== false },
      { role: 'paste', enabled: editFlags.canPaste !== false }, { type: 'separator' }, { role: 'selectAll' }];
  }
  return selectionText ? [{ role: 'copy' }] : [];
}
// Windows prints the full name in "net user <login>" as "Full Name   <name>"; the label is localized, so another language gets ''.
export const windowsFullName = text => /^[ \t]*Full Name[ \t]{2,}([^\r\n]*?)[ \t]*\r?$/m.exec(text)?.[1] ?? '';
