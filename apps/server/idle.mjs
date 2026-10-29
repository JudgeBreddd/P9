// Background mode (no user service on this machine; install.sh, threat model row I1): the daemon stops itself, the same stop
// as SIGTERM, once nobody has used it for `seconds`, as VS Code's server does. Busy: a connection opened since the last look,
// one still open (the desktop's ssh forward, the phone, a terminal), or a chat mid-turn. A turn holds the stop until it ends.
export function watchIdle({ seconds, servers, turns, stop, every = Math.min(seconds * 250, 15000) }) {
  let last = Date.now();
  for (const server of servers) server.on('connection', () => { last = Date.now(); });
  const open = () => Promise.all(servers.map((server) => new Promise((resolve) => server.getConnections((error, count) => resolve(error ? 1 : count)))));
  const timer = setInterval(async () => {
    if (turns() || (await open()).some(Boolean)) last = Date.now();
    else if (Date.now() - last >= seconds * 1000) { clearInterval(timer); stop(); }
  }, every);
  timer.unref();
  return timer;
}
