// A log view's heading (#11) on a Markdown file saved with Windows line ends (CRLF) finds the heading, the same as LF.
import test from 'node:test';
import assert from 'node:assert/strict';
import { logPart } from '../apps/server/mission.mjs';

test('log view heading reads a CRLF file the same as an LF one', () => {
  const lf = '# Status\nintro\n## Now\none\ntwo\n## Later\nfive';
  const crlf = lf.replaceAll('\n', '\r\n');
  assert.equal(logPart(lf, { heading: 'Now', from: 'start' }), '## Now\none\ntwo');
  assert.equal(logPart(crlf, { heading: 'Now', from: 'start' }), '## Now\none\ntwo');
  assert.equal(logPart(crlf, { lines: 1 }), 'five');
});
