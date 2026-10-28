export function createLifecycle() {
  const starts = new Set();
  let stopping = null, held = null;

  // held: a server update about to restart the service (update.mjs) refuses new starts the same way Stop all does.
  function begin() {
    if (stopping || held) return null;
    let release;
    const settled = new Promise((resolve) => { release = resolve; });
    starts.add(settled);
    return () => { starts.delete(settled); release(); };
  }

  function stopAll(stop) {
    if (stopping) return stopping;
    stopping = (async () => {
      await Promise.all([...starts]);
      return stop();
    })().finally(() => { stopping = null; });
    return stopping;
  }

  return { begin, stopAll, stopping: () => Boolean(stopping), hold: (reason) => { held = reason; }, release: (reason) => { if (held === reason) held = null; },
    // The refusal for a start begin() turned down.
    refusal: () => held ?? 'stop-all-running' };
}
