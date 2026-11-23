// CAT-1j: loaded with --import (or NODE_OPTIONS), this adds a made-up agent, Kestrel, to apps/server/agents.mjs's CATALOG
// as data only: the file is changed as it loads, so every table and route reads Kestrel the way it reads the two built in.
import { registerHooks } from 'node:module';

const KESTREL = `
  entry({ id: 'kestrel', name: 'Kestrel Agent', adapter: 'kestrel-acp', native: '@kestrel/kestrel-', cliPass: '',
    login: { args: ['login'], command: 'kestrel login' }, signIn: { kind: 'device-code', flag: '--device-auth', dir: 'codexHome', file: 'kestrel.json' },
    modes: { 'Look only': { value: 'look', tier: 0 }, 'Ask first': { value: 'ask', tier: 1 }, 'Free run': { value: 'free', tier: 4 } },
    acp: 2, tellStart: true, start: 'ask', auto: 'Ask first', narrow: 'look', models: 'session',
    usage: { reader: 'kestrel-plan', staleMs: STALE, pool: 'kestrel', hideSignedOut: false },
    signedOut: 'Kestrel is not signed in.', why: 'Kestrel, for Kestrel chats.', short: 'Kestrel', pick: 'Kestrel, made up for a test.', account: 'A Kestrel account.' }),`;
registerHooks({ load(url, context, next) {
  const got = next(url, context);
  if (!url.endsWith('/apps/server/agents.mjs')) return got;
  const source = String(got.source), at = source.indexOf('\n]);');
  if (at < 0) throw new Error('third-agent: the catalog\'s end was not found');
  return { ...got, source: source.slice(0, at) + KESTREL + source.slice(at) };
} });
