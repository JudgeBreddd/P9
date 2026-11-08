// Memory extractor's classifier (learning layer, plan-layers-2-5.md phase 4: Extract). Sorts one sentence's meaning
// vector (model2vec, 256 numbers, length 1) into a kind a new chat needs, or 'skip'. Online: learn() is one
// passive-aggressive step (PA-I, Crammer et al. 2006) on that example alone, so a new label changes the answer at once
// and there is never a full retrain. No AI, no network: plain arithmetic on the weights, which hold numbers only.
// Imports nothing, so the memory worker can load it on its own.

export const KINDS = ['state', 'decision', 'how-to-work', 'code-map', 'dead-end', 'skip'];
export const LEARN = 1; // bump when the saved format or the update rule changes: saved weights of another version are retrained

export function createClassifier(dim, { C = 1 } = {}) {
  return { version: LEARN, dim, C, seen: 0, w: new Float32Array(KINDS.length * (dim + 1)) }; // +1: a bias per kind
}

export function scores(c, x) {
  const out = new Float32Array(KINDS.length), d = c.dim + 1;
  for (let k = 0; k < KINDS.length; k++) {
    let s = c.w[k * d + c.dim];
    for (let i = 0; i < c.dim; i++) s += c.w[k * d + i] * x[i];
    out[k] = s;
  }
  return out;
}

// The best kind and its margin over the runner-up (how sure the classifier is).
export function classify(c, x) {
  const s = scores(c, x);
  let a = 0, b = -1;
  for (let k = 1; k < s.length; k++) if (s[k] > s[a]) { b = a; a = k; } else if (b < 0 || s[k] > s[b]) b = k;
  return { kind: KINDS[a], margin: s[a] - s[b] };
}

// One PA-I step: if the right kind doesn't beat the best wrong one by 1, move both just enough (capped by C).
// Returns the loss before the step (0 = already right with margin).
export function learn(c, x, kind) {
  const y = KINDS.indexOf(kind);
  if (y < 0) throw new Error(`unknown kind ${kind}`);
  const s = scores(c, x);
  let r = -1;
  for (let k = 0; k < s.length; k++) if (k !== y && (r < 0 || s[k] > s[r])) r = k;
  const loss = Math.max(0, 1 - (s[y] - s[r]));
  c.seen++;
  if (!loss) return 0;
  let xx = 1; // the bias input
  for (let i = 0; i < c.dim; i++) xx += x[i] * x[i];
  const tau = Math.min(c.C, loss / (2 * xx)), d = c.dim + 1;
  for (let i = 0; i <= c.dim; i++) {
    const v = i < c.dim ? x[i] : 1;
    c.w[y * d + i] += tau * v;
    c.w[r * d + i] -= tau * v;
  }
  return loss;
}

export function saveClassifier(c) {
  return JSON.stringify({ version: c.version, dim: c.dim, C: c.C, seen: c.seen, kinds: KINDS,
    w: Buffer.from(c.w.buffer, c.w.byteOffset, c.w.byteLength).toString('base64') });
}

// null when the saved weights are another version or another kind list: the caller starts fresh and relearns.
export function loadClassifier(text) {
  const j = JSON.parse(text);
  if (j.version !== LEARN || JSON.stringify(j.kinds) !== JSON.stringify(KINDS)) return null;
  const b = Buffer.from(j.w, 'base64');
  const w = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  if (w.length !== KINDS.length * (j.dim + 1)) return null;
  return { version: j.version, dim: j.dim, C: j.C, seen: j.seen, w };
}
