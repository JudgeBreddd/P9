// A live terminal on P9's own tmux sessions (threat model surface 13), shared by the phone (phase 17 rows 4-5, over its
// WebSocket) and the desktop dock (over the desktop's relay). Keys go out as binary frames
// only while the socket is open; nothing typed while it is closed is kept, so a reconnect never replays a command.
// Each key frame starts with a lease the daemon sent (8 bytes); the daemon drops keys whose lease is over 5 s old, so
// keys typed into a dead link never run later. The lease is the newest one this page had read before the key's input
// event happened, so a stalled page cannot stamp an old key with a newer lease. No lease yet, no keys.
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

// xterm sends some typed text a tick later, on a timer: an IME result after compositionend (or sooner, if a keydown
// forces it out first) and the text after a keydown 229. Until that timer has run, any data is stamped no later than
// the oldest such event. This listener runs after xterm's own, so its timer runs after xterm's.
// Only the newest such event's timer clears it, so an earlier timer cannot clear it before a later xterm timer sends.
let owed = Infinity, owedEvents = 0;
for (const type of ['compositionend', 'keydown']) addEventListener(type, (event) => {
  if (type === 'keydown' && event.keyCode !== 229) return;
  owed = Math.min(owed, event.timeStamp);
  const mine = ++owedEvents;
  setTimeout(() => { if (mine === owedEvents) owed = Infinity; });
});

// screen: the box xterm draws in. state(text, live): the page shows the state and turns its own key buttons on or off.
// connect(id): a WebSocket to that terminal, or anything with the same readyState, send, close and on* handlers.
export function createTerminal({ screen, state, connect }) {
  const term = { view: null, socket: null, leases: [] };
  function show(text, live = false) {
    state(text, live);
    if (term.view) term.view.options.disableStdin = !live;
  }
  function sendKeys(data) {
    // Typed data runs inside its input event, or on one of xterm's timers above; with neither, it is xterm answering a
    // query in the output (no keys), and takes the newest lease.
    const typed = Math.min(owed, window.event?.timeStamp ?? Infinity), bytes = new TextEncoder().encode(data);
    // Strictly before: coarse or sleep-paused clocks (WebKit) can give a later lease the same time as the key.
    const lease = term.leases.findLast((held) => held.at < typed)?.bytes;
    if (!lease || term.socket?.readyState !== WebSocket.OPEN) return;
    // A paste goes in pieces well under the daemon's 64 KiB frame limit, each with the lease.
    for (let at = 0; at < bytes.length; at += 32768) {
      const piece = bytes.subarray(at, at + 32768), frame = new Uint8Array(8 + piece.length);
      frame.set(lease); frame.set(piece, 8);
      term.socket.send(frame);
    }
  }
  // Fits the terminal to its box from one measured character; tmux gets the size as the one text frame the daemon takes.
  function fit() {
    const view = term.view; if (!view?.element) return;
    const probe = document.createElement('span');
    probe.textContent = 'W'.repeat(40); probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:13px "JetBrains Mono",ui-monospace,monospace';
    document.body.append(probe); const cell = probe.getBoundingClientRect(); probe.remove();
    const box = screen.getBoundingClientRect();
    if (!box.width || !cell.width) return;
    const cols = Math.max(2, Math.min(500, Math.floor((box.width - 10) / (cell.width / 40)))), rows = Math.max(1, Math.min(200, Math.floor((box.height - 10) / cell.height)));
    if (cols !== view.cols || rows !== view.rows) view.resize(cols, rows);
    if (term.socket?.readyState === WebSocket.OPEN) term.socket.send(JSON.stringify({ resize: [view.cols, view.rows] }));
  }
  // Closes the open socket, if any; says whether there was one.
  function close() {
    const old = term.socket; term.socket = null; term.leases = []; old?.close();
    return Boolean(old);
  }
  function attach(id) {
    close();
    if (!term.view) {
      term.view = new Terminal({ fontSize: 13, fontFamily: '"JetBrains Mono", ui-monospace, monospace', scrollback: 2000, theme: { background: '#0d131c', foreground: '#edf3fb', cursor: '#6ee7f2' },
        // xterm opens OSC 8 links in its core (confirm, then window.open); surface 13 says links do not open.
        linkHandler: { activate() {} } });
      term.view.open(screen);
      term.view.onData(sendKeys);
    }
    term.view.reset();
    const socket = connect(id);
    socket.binaryType = 'arraybuffer';
    term.socket = socket;
    show('Connecting');
    socket.onopen = () => { if (term.socket === socket) fit(); };
    // Output the screen has not drawn yet is capped, so a flood closes the terminal instead of freezing the tab.
    let unrendered = 0;
    socket.onmessage = (event) => {
      if (term.socket !== socket) return;
      // Text frames are leases, never output.
      if (typeof event.data === 'string') {
        const hex = /^\{"lease":"([0-9a-f]{16})"\}$/.exec(event.data)?.[1];
        if (!hex) return;
        if (!term.leases.length) show('Connected', true);
        // Read time, never earlier than arrival; 8 cover 16 s, past the daemon's 5 s, so a stalled
        // key finds the lease it was typed under and is refused, rather than finding none.
        term.leases = [...term.leases.slice(-7), { bytes: Uint8Array.from(hex.match(/../g), (pair) => parseInt(pair, 16)), at: performance.now() }];
        return;
      }
      const bytes = new Uint8Array(event.data);
      unrendered += bytes.length;
      if (unrendered > 4 * 1024 * 1024) { term.socket = null; term.leases = []; socket.close(); return show('Closed: output too fast to show; press Refresh'); }
      term.view.write(bytes, () => { unrendered -= bytes.length; });
    };
    socket.onclose = (event) => {
      if (term.socket !== socket) return;
      term.socket = null; term.leases = [];
      show(event.code === 4408 ? 'Closed: keys arrived late and were dropped; press Refresh' : 'Closed: press Refresh to reconnect');
    };
  }
  return { attach, close, fit, sendKeys, show, focus: () => term.view?.focus(), get open() { return Boolean(term.socket); } };
}
