export function mountLandingVideo(element) {
  const video = element.querySelector('video');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const lifetime = new AbortController();
  let visible = false, manualPause = false, destroyed = false, failed = false;
  video.muted = true;
  const state = value => { element.dataset.videoState = value; };
  // Shown = laid out now (its dialog open). The IntersectionObserver alone missed the dialog opening on a busy first load:
  // one callback, not intersecting, while #land was closed, and none after, so the video never played (first-open test).
  const shown = () => element.checkVisibility?.() ?? visible;
  const sync = () => {
    if (destroyed) return;
    if (reduced.matches) { video.pause(); state('still'); return; }
    if (failed) { state('error'); return; }
    if (!shown() || document.hidden || manualPause) {
      video.pause(); state(video.currentTime ? 'paused' : 'loading'); return;
    }
    state('loading');
    video.play().then(() => {
      if (!destroyed && shown() && !document.hidden && !manualPause && !reduced.matches) state('playing');
    }).catch(error => {
      if (!destroyed && error.name !== 'AbortError') state('blocked');
    });
  };
  const observer = new IntersectionObserver(entries => { visible = entries[0].isIntersecting; sync(); });
  observer.observe(element);
  document.addEventListener('visibilitychange', sync, { signal: lifetime.signal });
  reduced.addEventListener('change', sync, { signal: lifetime.signal });
  video.addEventListener('error', () => { failed = true; state('error'); }, { signal: lifetime.signal });
  video.addEventListener('playing', () => { if (!reduced.matches) state('playing'); }, { signal: lifetime.signal });
  video.querySelector('source')?.addEventListener('error', () => { failed = true; state('error'); }, { signal: lifetime.signal });
  sync();
  return {
    setPaused(paused) { manualPause = paused; sync(); },
    // The landing opened or closed: the caller says so rather than wait on the observer.
    refresh: sync,
    destroy() { destroyed = true; observer.disconnect(); lifetime.abort(); video.pause(); },
  };
}
