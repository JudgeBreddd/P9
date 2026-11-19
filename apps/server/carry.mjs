// O193: who P9 wakes next in a sprint, as one plain function. decide(state, event) reads the sprint's saved state and
// one event and returns the wakes ({ chat, text, key }), or none. It sends nothing and stores nothing: delegate.mjs
// builds the state, sends each wake as a queued prompt and records its key, so a key is spent only by a wake sent.
//
// state: { lead: { id, busy }, started (ms or 0), first (the sprint's first carry), reviewer: { id, title, busy } or null, woken: { key: at },
//          workers: [{ id, title, busy, ready, reviews: { item: { state, commit, fixes, at, onMain, open } }, note: { commit, text } }] }
// event: { type: 'ready' | 'verdict' | 'end' | 'idle' | 'start', chat, at, ended, sentToLead, background }
//   end: a turn or run of `chat` ended; idle: `chat` is still stopped 10 min after its end at `ended` (O188's check),
//   sentToLead whether it sent its lead anything but a note in that run, background whether it is waiting on a
//   background task of its own (unknown to P9 until O194: false); start: P9 started.
//
// Each review record names one next actor: queued -> the reviewer (the lead if there is none), fix -> the worker,
// passed -> the lead. A busy actor is skipped and the next event looks again. A record is live only if it is from this
// sprint run (not older than its start, else its first carry), its commit is not on main, and it is still the head of a
// branch on origin (open: false; undefined when unknown). The first carry lists the stale ones to the lead, once. An actor woken that is
// still stopped 10 min after an end since the wake (or lost its turn to a restart), with the record unchanged, tells the
// lead once: a single end is often mid-work. A worker still stopped with no ready, nothing sent to the lead and no
// background task wakes the lead, once per end.
export function decide(state, event) {
  const wakes = [], seen = state.woken ?? {}, lead = state.lead.id, stale = [];
  const add = (chat, text, key) => { if (!seen[key] && !wakes.some((w) => w.key === key)) wakes.push({ chat, text, key }); };
  for (const w of state.workers) {
    for (const [item, r] of Object.entries(w.reviews ?? {})) {
      if (!['queued', 'fix', 'passed'].includes(r.state)) continue;
      if (r.onMain || r.open === false || (state.started && r.at < state.started)) { stale.push(`${w.title} ${item} (${r.state} at ${String(r.commit).slice(0, 7)})`); continue; }
      const key = [w.id, item, r.state, r.commit].join(':');
      const actor = r.state === 'fix' ? w : r.state === 'queued' && state.reviewer ? state.reviewer : { ...state.lead, title: 'the lead' };
      if (actor.busy) continue;
      if (!seen[key]) {
        const note = w.note?.commit === r.commit ? ': ' + w.note.text : '';
        add(actor.id, r.state === 'passed' ? `[p9] ${item} by ${w.title} passed at ${r.commit}: merge it.`
          : r.state === 'fix' ? `[p9] ${item}: the reviewer asked for a fix (fix ${r.fixes}) at ${r.commit}${note}`
            : actor.id !== lead ? `[p9] Ready for review: ${item}, by ${w.title} (chat ${w.id}), commit ${r.commit}. Read its report, then call verdict with that chat and commit.`
              : `[p9] ${item} by ${w.title} is ready at ${r.commit}, and no reviewer can take it: start or bring back one with key review.`, key);
      } else if (actor.id !== lead && (event.type === 'start' || (event.type === 'idle' && event.chat === actor.id && !event.background && event.ended > seen[key]))) {
        add(lead, `[p9] ${actor.title} ended its turn on ${item} at ${r.commit} without acting on it.`, key + ':told');
      }
    }
  }
  const w = event.type === 'idle' && state.workers.find((x) => x.id === event.chat);
  if (w && !w.busy && !w.ready && !event.sentToLead && !event.background && !wakes.some((x) => x.chat === lead && x.key.startsWith(w.id + ':'))) {
    add(lead, `[p9] ${w.title} ended its turn with no ready and nothing queued for you.`, `${w.id}:idle:${event.ended ?? event.at}`);
  }
  if (state.first && stale.length) add(lead, `[p9] Not carried (older than this sprint, merged, or no longer an open PR head): ${stale.slice(0, 30).join('; ')}.`, 'stale');
  return wakes;
}
