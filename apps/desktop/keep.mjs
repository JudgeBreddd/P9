// Row I1: Keep P9 running on a remote? Per host, as answered with Do not ask again or set in Settings > Remote: true (its
// service, with linger) or false (a background daemon while connected, the way VS Code's server runs). A stored choice, no
// secret. The choice is applied on the remote at each connect: Yes there in background mode moves P9 to its service, No there
// on its service moves it to the background daemon (remote.mjs remoteMode). Either one stops the daemon the window uses, so the
// tunnel drops and connects again on its own.
// run(host, action, password) -> Promise<{ phase, command? }> (remote.mjs remoteMode); save(): writes keep (p9-server.json, 0600).
// password: row I2's admin password for linger, passed through once and never kept here.
// ponytail: 50 hosts kept, the oldest go.
export function createKeeper({ saved, run, save, named }) {
  let keep = Object.fromEntries(Object.entries(saved && typeof saved === 'object' ? saved : {}).filter(([h, v]) => named(h) && typeof v === 'boolean').slice(-50));
  const asked = new Set(); // answered this run, without Do not ask again
  let keeping = null; // the last keep or release this run, for the window
  const store = async (host, choice) => {
    const { [host]: _, ...rest } = keep;
    keep = choice === null ? rest : Object.fromEntries(Object.entries({ ...rest, [host]: choice }).slice(-50));
    await save();
  };
  // force: the person asked just now; otherwise one that did not work is not tried again this run.
  const apply = (host, background, choice, force = false, password = null) => {
    const action = choice === true && background ? 'keep' : choice === false && !background ? 'release' : null;
    if (!action || keeping?.phase === 'running' || (!force && keeping?.host === host && keeping.action === action)) return false;
    const mine = keeping = { host, action, phase: 'running' };
    run(host, action, password).then(({ phase, command }) => { if (keeping === mine) keeping = { host, action, phase, ...(command && { command }) }; },
      () => { if (keeping === mine) keeping = { host, action, phase: 'failed' }; });
    return true;
  };
  return {
    get keep() { return keep; },
    // A connect to host; background: P9 there runs in background mode.
    connected(host, background) { if (typeof keep[host] === 'boolean') apply(host, background, keep[host]); },
    // The question's answer, or Keep it running. A stored choice follows the latest answer, or the next connect would undo it.
    async answer(host, background, yes, remember) {
      asked.add(host);
      if (remember || typeof keep[host] === 'boolean') await store(host, yes);
      apply(host, background, yes, true);
    },
    // Settings > Remote: true, false or null (ask). background: null when host is not this window's connected remote.
    async set(host, background, choice) {
      await store(host, choice);
      if (background !== null && choice !== null) apply(host, background, choice, true);
    },
    // Keep it running with the admin password, after linger was refused there (row I2).
    admin(host, background, password) { return apply(host, background, true, true, password); },
    // For the status poll. ask: the question is due (background mode there, no stored choice, not answered this run).
    status(host, background) {
      return { background, ask: background && keep[host] === undefined && !asked.has(host), ...(keeping?.host === host && { keeping }) };
    },
  };
}
