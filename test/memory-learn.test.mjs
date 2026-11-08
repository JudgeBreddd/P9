// Memory extractor's classifier (memory-learn.mjs; _research/p9-learning-layer/plan-layers-2-5.md phase 4 test 4):
// learns online, one label at a time, with no network, under 1 ms a sentence. Vectors are made by hand from a fixed
// seed (256 numbers, length 1, like model2vec's), so every expected answer below follows from the update rule alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { KINDS, createClassifier, classify, learn, scores, saveClassifier, loadClassifier } from '../apps/server/memory-learn.mjs';

const DIM = 256;
function rng(seed) { return () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) - 0.5; }
function vec(seed) {
  const r = rng(seed), v = new Float32Array(DIM);
  let n = 0;
  for (let i = 0; i < DIM; i++) { v[i] = r(); n += v[i] * v[i]; }
  for (let i = 0; i < DIM; i++) v[i] /= Math.sqrt(n);
  return v;
}

test('one new label changes the answer for that sentence, with no retrain', () => {
  const c = createClassifier(DIM);
  const base = Array.from({ length: 60 }, (_, i) => [vec(100 + i), KINDS[i % KINDS.length]]);
  for (let pass = 0; pass < 5; pass++) for (const [x, k] of base) learn(c, x, k);
  const x = vec(7);
  const before = classify(c, x).kind;
  const want = KINDS.find((k) => k !== before);
  const w0 = Float32Array.from(c.w);
  const first = learn(c, x, want); // one step on this one example
  assert.equal(classify(c, x).kind, want);
  // only the right kind's row and the runner-up's row moved: a single local step, not a pass over the 60 examples
  const d = DIM + 1, moved = KINDS.filter((_, k) => c.w.subarray(k * d, (k + 1) * d).some((v, i) => v !== w0[k * d + i]));
  assert.equal(moved.length, 2);
  assert.ok(moved.includes(want));
  // C caps the step, so one step may flip the answer without reaching the full margin of 1; the same label again
  // then costs less, never more
  assert.ok(learn(c, x, want) < first);
});

test('a mistake costs its step, a known answer costs nothing (C caps one noisy label)', () => {
  const c = createClassifier(DIM, { C: 0.01 });
  const x = vec(9);
  assert.ok(learn(c, x, 'decision') > 0);
  const s = scores(c, x);
  assert.ok(s[KINDS.indexOf('decision')] - Math.max(...s.filter((_, k) => k !== 1)) < 1, 'C = 0.01 keeps one label from moving all the way');
});

test('saved weights round-trip, and another version or kind list is refused', () => {
  const c = createClassifier(DIM);
  for (let i = 0; i < 30; i++) learn(c, vec(200 + i), KINDS[i % 6]);
  const back = loadClassifier(saveClassifier(c));
  for (let i = 0; i < 10; i++) assert.deepEqual(classify(back, vec(300 + i)), classify(c, vec(300 + i)));
  const j = JSON.parse(saveClassifier(c));
  assert.equal(loadClassifier(JSON.stringify({ ...j, version: 0 })), null);
  assert.equal(loadClassifier(JSON.stringify({ ...j, kinds: [...KINDS].reverse() })), null);
});

test('no network and no AI: the module imports nothing', () => {
  const src = readFileSync(new URL('../apps/server/memory-learn.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /^\s*import\b|\brequire\(|\bfetch\(|\bimport\(/m);
});

test('under 1 ms a sentence: classify and learn on 10,000 vectors', () => {
  const c = createClassifier(DIM), xs = Array.from({ length: 200 }, (_, i) => vec(400 + i));
  const t = performance.now();
  for (let i = 0; i < 10000; i++) { const x = xs[i % 200]; classify(c, x); learn(c, x, KINDS[i % 6]); }
  const perMs = (performance.now() - t) / 10000;
  assert.ok(perMs < 1, `${perMs} ms a sentence`);
});

// Phase 4 test 7. The app has no model2vec yet, so a hashed bag of letters stands in for the text-to-vector step;
// what is under test is that nothing past that step keeps the text.
test('no transcript text ships: saved weights hold none of 5 planted markers', () => {
  const MARKERS = ['ZEBRA-QUILL-7731', 'marker_two_xq9', 'PlantedSecret#3', 'fourth/marker/path.mjs', 'fifthMarkerWord'];
  function hashVec(text) {
    const v = new Float32Array(DIM);
    for (let i = 0; i < text.length; i++) v[(text.charCodeAt(i) * 31 + i) % DIM] += 1;
    let n = 0;
    for (const a of v) n += a * a;
    for (let i = 0; i < DIM; i++) v[i] /= Math.sqrt(n) || 1;
    return v;
  }
  const c = createClassifier(DIM);
  for (let round = 0; round < 20; round++)
    MARKERS.forEach((m, i) => learn(c, hashVec(`the answer was in ${m} after the deploy`), KINDS[i % KINDS.length]));
  const saved = saveClassifier(c);
  assert.deepEqual(Object.keys(JSON.parse(saved)).sort(), ['C', 'dim', 'kinds', 'seen', 'version', 'w']);
  const bytes = Buffer.from(JSON.parse(saved).w, 'base64');
  for (const m of MARKERS) {
    assert.ok(!saved.includes(m), `${m} in the saved text`);
    assert.ok(!bytes.includes(Buffer.from(m)), `${m} in the weight bytes`);
  }
});
