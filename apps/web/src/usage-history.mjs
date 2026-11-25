// A3 (2): the Usage window's Tokens and Cost tabs, loaded the first time one opens (mission-view.mjs turnsBody), so the
// shell's startup bundle does not carry them. page: the /usage/turns answer (server usage-turns.mjs): one row per day,
// provider, model and profile, chats per provider. The figures are summed here; a sum covers only the turns that reported
// it, and the lines under each view say how many did. A cost is shown only where a turn has a price: no price is never $0.
const RANGES = [[1, 'Past 24h'], [7, '7 days'], [30, '30 days'], [90, '90 days']];
const TYPES = [['input', 'Input'], ['cacheRead', 'Cache read'], ['cacheWrite', 'Cache write'], ['output', 'Output']];
const COMPACT = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 });
const tokens = (n) => COMPACT.format(n);
const dollars = (n) => (n == null ? 'no price' : n > 0 && n < 0.005 ? '<$0.01' : '$' + n.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const sum = (rows, pick) => rows.reduce((total, row) => total + (pick(row) ?? 0), 0);
// null when no row has a price, so a group of unpriced turns reads "no price", not $0.00.
const cost = (rows, pick = (row) => row.usd) => (rows.some((row) => pick(row) != null) ? sum(rows, pick) : null);
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
const groupBy = (rows, key) => { const out = new Map(); for (const row of rows) { const k = key(row); out.set(k, [...(out.get(k) ?? []), row]); } return out; };
// Every local date from the range's start to today, so a day with no turns still has its place on the chart.
function daysOf(since) {
  const out = [], today = new Date().toLocaleDateString('sv');
  for (const d = new Date(new Date(since).setHours(12, 0, 0, 0)); out.at(-1) !== today && out.length < 100; d.setDate(d.getDate() + 1)) out.push(d.toLocaleDateString('sv'));
  return out;
}

// U: mission-view's UH ({ tab: 'tokens'|'cost', days, by: 'model'|'day', page }). names: agent id -> name.
export function historyHtml(U, esc, names) {
  const range = `<div class="uh-range" role="group" aria-label="Range">${RANGES.map(([days, label]) => `<button type="button" data-slot="button" data-variant="ghost" data-size="sm" data-uh-days="${days}" aria-pressed="${U.days === days}">${label}</button>`).join('')}</div>`;
  const page = U.page;
  if (!page || page.days !== U.days) return range + '<p class="sm muted">Loading…</p>';
  if (page.state === 'rebuilding') return range + '<p class="empty" data-uh-state="rebuilding">Building the usage history from your chat records. This runs once after an update; it shows here when done.</p>';
  if (page.state !== 'ok') return range + '<p class="empty" data-uh-state="unavailable">The usage history cannot be read right now. Try again in a minute.</p>';
  const rows = page.rows ?? [];
  if (!rows.length) return range + '<p class="empty" data-uh-state="empty">No turns in this range.</p>';
  const isCost = U.tab === 'cost', value = isCost ? (r) => cost(r) : (r) => sum(r, (row) => row.total);
  const shown = (v) => (isCost ? dollars(v) : tokens(v ?? 0));
  const turns = sum(rows, (row) => row.turns), grand = value(rows);
  const chats = Object.values(page.chats ?? {}).reduce((a, b) => a + b, 0);
  const name = (provider) => esc(names?.[provider] ?? provider ?? 'unknown');
  const share = (v) => (grand && v != null ? Math.round((v / grand) * 100) + '%' : '–');

  // Top: the total, and one line per provider (its chats, its share, its dollars).
  const providers = [...groupBy(rows, (row) => row.provider)].sort(([, a], [, b]) => (value(b) ?? -1) - (value(a) ?? -1));
  const head = `<div class="uh-head"><div class="uh-total"><b data-uh-total>${shown(grand)}</b><span>${isCost ? `API estimate · prices as of ${esc(page.pricesAsOf)}` : `${plural(turns, 'turn')} · ${plural(chats, 'chat')}`}</span></div>`
    + `<ul class="uh-provs">${providers.map(([provider, list]) => `<li><span class="dot" data-agent="${esc(provider)}"></span><b>${name(provider)}</b><span>${plural(page.chats?.[provider] ?? 0, 'chat')}</span><span>${share(value(list))}</span><span>${isCost ? dollars(cost(list)) : tokens(value(list))}</span></li>`).join('')}</ul></div>`;

  // The daily chart: a column a day, stacked by provider.
  const byDay = groupBy(rows, (row) => row.day), days = daysOf(page.since);
  const dayValue = (list, provider) => value(list.filter((row) => row.provider === provider)) ?? 0;
  const top = Math.max(...days.map((day) => value(byDay.get(day) ?? []) ?? 0), 0);
  const chart = `<div class="uh-chart" role="img" aria-label="${isCost ? 'Estimated cost' : 'Tokens'} per day, by agent">${days.map((day) => {
    const list = byDay.get(day) ?? [];
    return `<span class="uh-col" title="${esc(day)}: ${shown(value(list) ?? (isCost ? null : 0))}">${providers.map(([provider]) => { const v = dayValue(list, provider);
      return v && top ? `<i data-agent="${esc(provider)}" style="height:${((v / top) * 100).toFixed(1)}%"></i>` : ''; }).join('')}</span>`; }).join('')}</div>`
    + `<div class="uh-axis"><span>${esc(days[0])}</span><span>Today</span></div>`;

  // Totals, and the same split by token type as one bar.
  const stats = (pairs) => `<div class="stats">${pairs.map(([label, v]) => `<div><span>${label}</span><b>${v}</b></div>`).join('')}</div>`;
  const totals = isCost
    ? stats([['Estimated cost', dollars(grand)], ...TYPES.map(([type, label]) => [label, dollars(cost(rows, (row) => row.cost?.[type]))])])
    : stats([['Processed tokens', tokens(grand)], ['Cached input', tokens(sum(rows, (row) => row.cacheRead))], ['Uncached input', tokens(sum(rows, (row) => row.input))],
      ['Output', tokens(sum(rows, (row) => row.output))], ['Cache savings', dollars(cost(rows, (row) => row.saved))]]);
  const parts = TYPES.map(([type, label]) => [type, label, isCost ? cost(rows, (row) => row.cost?.[type]) ?? 0 : sum(rows, (row) => row[type])]);
  const whole = parts.reduce((a, p) => a + p[2], 0);
  const bar = whole ? `<h4 class="uh-h">${isCost ? 'Cost' : 'Tokens'} by type</h4><div class="uh-type" role="img" aria-label="${parts.map(([, label, v]) => `${label} ${Math.round((v / whole) * 100)}%`).join(', ')}">${parts.map(([type, , v]) => (v ? `<i data-type="${type}" style="width:${((v / whole) * 100).toFixed(1)}%"></i>` : '')).join('')}</div>`
    + `<ul class="uh-legend">${parts.map(([type, label, v]) => `<li><i data-type="${type}"></i>${label} <b>${shown(v)}</b></li>`).join('')}</ul>` : '';

  // Breakdown by model or day, largest first; a group with no price sorts last on the Cost tab.
  const groups = [...groupBy(rows, U.by === 'day' ? (row) => row.day : (row) => `${row.provider}\u0000${row.model}\u0000${row.profile}`)]
    .map(([, list]) => ({ list, v: value(list), t: sum(list, (row) => row.total) }))
    .sort((a, b) => (U.by === 'day' ? (a.list[0].day < b.list[0].day ? 1 : -1) : (b.v ?? -1) - (a.v ?? -1) || b.t - a.t));
  const label = ({ list: [row] }) => (U.by === 'day' ? esc(row.day)
    : `<span class="dot" data-agent="${esc(row.provider)}"></span>${esc(row.model ?? 'unknown model')}${row.profile ? ' <span class="muted">(profile)</span>' : ''}`);
  const by = `<div class="uh-by"><h4 class="uh-h">Breakdown</h4><div role="group" aria-label="Breakdown by">${[['model', 'Model'], ['day', 'Day']].map(([id, text]) => `<button type="button" data-slot="button" data-variant="ghost" data-size="sm" data-uh-by="${id}" aria-pressed="${U.by === id}">${text}</button>`).join('')}</div></div>`
    + `<table class="uh-table"><thead><tr><th>#</th><th>${U.by === 'day' ? 'Day' : 'Model'}</th><th>Cost</th><th>Share</th><th>Tokens</th></tr></thead><tbody>${groups.map((g, i) => `<tr><td>${i + 1}</td><td>${label(g)}</td><td>${dollars(cost(g.list))}</td><td>${share(g.v)}</td><td>${tokens(g.t)}</td></tr>`).join('')}</tbody></table>`;

  // What the figures cover.
  const counted = sum(rows, (row) => row.known?.total), priced = sum(rows, (row) => row.priced), estimated = sum(rows, (row) => row.estimated);
  const notes = [counted < turns && `${counted.toLocaleString()} of ${plural(turns, 'turn')} reported token counts; the rest add none.`,
    isCost && `${priced.toLocaleString()} of ${plural(turns, 'turn')} have a price. Turns on a model with no price, in a profile chat, or missing a count are left out.`,
    isCost && estimated && `${plural(estimated, 'priced turn')} include work outside the main reply (compactions, subagents), priced at the chat's model.`]
    .filter(Boolean).map((line) => `<p class="sm muted">${line}</p>`).join('');
  return range + head + chart + totals + bar + by + notes;
}
