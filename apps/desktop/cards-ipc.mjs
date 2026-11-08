// The cards window: its view and IPC handlers. Split out of main.mjs's createDesktop (F9) with no change in behaviour; names that stay in createDesktop come in through outer.
import { CARDS_URL, cardsSite } from './cards-page.mjs';
import { session, WebContentsView, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';

export function cardsIpc(outer) {
  // The Dev Focus cards overlay (threat model row 3, p9:cards): the shell hands over a bounded list of card texts and where to
  // put them; the overlay view above the editor draws them and says which one was clicked. Created when first needed, closed a
  // minute after it was last hidden, so it costs nothing in the other focuses.
  const fromCards = event => outer.cardsView && event.sender === outer.cardsView.webContents && event.senderFrame === outer.cardsView.webContents.mainFrame && event.senderFrame.url.startsWith(CARDS_URL);
  const text = (value, max) => typeof value === 'string' && value.length <= max;
  const openCards = () => {
    if (outer.cardsView) return outer.cardsView;
    const cardsSession = session.fromPartition('p9-cards'); // not persist: nothing kept
    if (!cardsSession.protocol.isProtocolHandled('p9')) { outer.sites.cards = cardsSite(); cardsSession.protocol.handle('p9', outer.serve('cards')); }
    cardsSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (_details, callback) => callback({ cancel: true }));
    cardsSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    cardsSession.setPermissionCheckHandler(() => false);
    outer.cardsView = new WebContentsView({ webPreferences: { preload: fileURLToPath(new URL('./cards-preload.cjs', import.meta.url)), session: cardsSession, sandbox: true,
      contextIsolation: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false } });
    outer.cardsView.setBackgroundColor('#00000000');
    outer.cardsView.webContents.on('dom-ready', () => outer.cardsView?.webContents.setZoomFactor(outer.settings.zoom));
    outer.cardsView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    outer.cardsView.webContents.on('will-navigate', event => event.preventDefault());
    outer.cardsView.webContents.on('will-attach-webview', event => event.preventDefault());
    outer.cardsView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    outer.window.contentView.addChildView(outer.cardsView);
    outer.cardsView.webContents.loadURL(CARDS_URL).catch(() => {});
    return outer.cardsView;
  };
  ipcMain.handle('p9:cards', (event, ...args) => {
    const [c] = args, whole = value => Number.isSafeInteger(value) && value >= 0 && value <= 100000;
    if (event.sender !== outer.window.webContents || event.senderFrame !== outer.window.webContents.mainFrame || event.senderFrame.url !== outer.APP_URL
        || args.length !== 1 || !c || typeof c.visible !== 'boolean'
        || (c.visible && (!['x', 'y', 'width'].every(key => whole(c[key])) || !Array.isArray(c.items) || c.items.length > 8
          || !c.items.every(i => i && text(i.key, 300) && text(i.title, 200) && text(i.sub, 300) && (i.n === undefined || whole(i.n)))))) throw new Error('ipc-sender-refused');
    if (!c.visible || !c.items.length) {
      outer.cardsView?.setVisible(false);
      if (outer.cardsView && !outer.cardsHide) outer.cardsHide = setTimeout(() => { outer.cardsHide = null; if (outer.cardsView && !outer.cardsView.getVisible()) { outer.window.contentView.removeChildView(outer.cardsView); outer.cardsView.webContents.close(); outer.cardsView = null; } }, 60000);
      return { ok: true };
    }
    clearTimeout(outer.cardsHide); outer.cardsHide = null;
    const z = outer.window.webContents.getZoomFactor(), px = value => Math.round(value * z), view = openCards();
    outer.cardsItems = c.items.map(i => ({ key: i.key, title: i.title, sub: i.sub, ...(i.n === undefined ? {} : { n: i.n }) }));
    view.webContents.send('p9cards:list', outer.cardsItems);
    const bounds = view.getBounds();
    view.setBounds({ x: px(c.x), y: px(c.y), width: px(c.width), height: bounds.height }); // the page says how tall it is
    view.setVisible(true);
    return { ok: true };
  });
  ipcMain.handle('p9cards:ready', event => { if (!fromCards(event)) throw new Error('ipc-sender-refused'); return { items: outer.cardsItems, look: outer.look }; });
  ipcMain.on('p9cards:size', (event, height) => {
    if (!fromCards(event) || !Number.isSafeInteger(height) || height < 0 || height > 4000) return;
    const b = outer.cardsView.getBounds(); outer.cardsView.setBounds({ ...b, height: Math.round(height * outer.window.webContents.getZoomFactor()) });
  });
  ipcMain.on('p9cards:act', (event, input) => {
    if (!fromCards(event) || !input || !text(input.key, 300) || !['open', 'x'].includes(input.action)) return;
    outer.window.webContents.focus();
    outer.window.webContents.send('p9:card-act', { key: input.key, action: input.action });
  });
}
