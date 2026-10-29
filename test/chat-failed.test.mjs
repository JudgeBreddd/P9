// A chat call main could not get an answer to (daemon-unavailable) says what happened in words: which P9, how long it
// waited when that was a while, and for a send that the message is back in the box. Other errors keep their code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chatFailed } from '../apps/web/src/helpers.mjs';

test('chatFailed: a send nobody answered, in words', () => {
  const gone = { error: 'daemon-unavailable', host: 'build-box' };
  assert.equal(chatFailed('prompt', gone, 181000), 'Could not send. P9 on build-box did not answer for 3 minutes. Your message is back in the box.');
  assert.equal(chatFailed('prompt', gone, 1200), 'Could not send. P9 on build-box is not answering. Your message is back in the box.');
  assert.equal(chatFailed('prompt', { error: 'daemon-unavailable' }, 70000), 'Could not send. P9 on this computer did not answer for 1 minute. Your message is back in the box.');
  assert.equal(chatFailed('cancel', gone, 500), 'Could not stop the turn. P9 on build-box is not answering. Try again in a moment.');
  assert.equal(chatFailed('prompt', { error: 'request-refused' }, 10), null);
  assert.equal(chatFailed('prompt', undefined, 10), null);
});
