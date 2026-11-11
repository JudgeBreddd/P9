// Live Codex plan use (5 h and 7 d), so the meters are right when the same Codex account is used on another computer:
// the session files limits.mjs reads only know what this computer's own Codex turns saw. Each poll starts the bundled
// Codex's app server (through codex-acp's own `cli` pass-through, as sign-in does), asks the one account call below,
// and ends the process. No thread is started and nothing is sent to a model. The poll's timing is claude-usage.mjs's.
// Any failure leaves the session files as the source.
import { spawn } from 'node:child_process';
import os from 'node:os';
import { adapterEntry } from './chat.mjs';
import { childEnv } from './child-env.mjs';
import { createPoll, TIMEOUT_MS } from './claude-usage.mjs';

export const READ_CALL = 'account/rateLimits/read';

// One read: { primary, secondary } as Codex answers them ({ usedPercent, windowDurationMins, resetsAt in seconds }).
export function readOnce(entry = adapterEntry('codex'), timeout = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, 'cli', 'app-server'], { cwd: os.tmpdir(), env: childEnv(), stdio: ['pipe', 'pipe', 'ignore'] });
    const send = (message) => child.stdin.write(JSON.stringify(message) + '\n');
    const end = (error, value) => { clearTimeout(timer); child.kill(); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => end(new Error('timed out')), timeout);
    let text = '';
    child.on('error', () => end(new Error('Codex did not start')));
    child.on('exit', () => end(new Error('Codex ended before it answered')));
    child.stdin.on('error', () => {}); // a process that has already gone: its exit says so
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      text += chunk;
      if (text.length > 1048576) return end(new Error('answer too long'));
      for (let at; (at = text.indexOf('\n')) >= 0; text = text.slice(at + 1)) {
        let message;
        try { message = JSON.parse(text.slice(0, at)); } catch { continue; }
        if (message?.id === 1 && message.result) { send({ method: 'initialized' }); send({ id: 2, method: READ_CALL }); }
        else if (message?.id === 1 || message?.id === 2) {
          const limits = message.result?.rateLimits;
          // Never the error's own text: it can name the account.
          return limits && typeof limits === 'object' ? end(null, { primary: limits.primary, secondary: limits.secondary }) : end(new Error('no plan limits (signed out, or not a ChatGPT plan)'));
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'p9', version: '1' } } });
  });
}

export const createCodexUsage = ({ read = readOnce, ...rest } = {}) => createPoll({ ...rest, name: 'codex', read });
