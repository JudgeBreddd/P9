export function createLifecycle() {
  const starts = new Set();
  let stopping = null;

  function begin() {
    if (stopping) return null;
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

  return { begin, stopAll, stopping: () => Boolean(stopping) };
}
