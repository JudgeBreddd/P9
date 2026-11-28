import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.document = { getElementById: () => null };

const { installSettings } = await import('../apps/web/src/settings-view.mjs');

test('wizRemote: remote box starts empty to avoid pre-filling first host (issue #566)', () => {
  const settings = installSettings({});
  settings.W.hosts = { hosts: ['192.168.68.79', 'icm-server'], remotes: [] };

  const html = settings.wizRemote(() => '<button>Connect</button>');
  assert.match(html, /<input[^>]+id="welHost"[^>]+value=""/);
  assert.match(html, /placeholder="192\.168\.68\.79"/);
  assert.match(html, /<datalist id="welHosts"><option value="192\.168\.68\.79"><\/option><option value="icm-server"><\/option><\/datalist>/);
});

test('wizRemote: uses h.last as placeholder when available', () => {
  const settings = installSettings({});
  settings.W.hosts = { last: 'icm-server', hosts: ['192.168.68.79', 'icm-server'], remotes: ['icm-server'] };

  const html = settings.wizRemote(() => '<button>Connect</button>');
  assert.match(html, /<input[^>]+id="welHost"[^>]+value=""/);
  assert.match(html, /placeholder="icm-server"/);
});

test('wizRemote: falls back to user@address as placeholder when no hosts exist', () => {
  const settings = installSettings({});
  settings.W.hosts = { hosts: [], remotes: [] };

  const html = settings.wizRemote(() => '<button>Connect</button>');
  assert.match(html, /<input[^>]+id="welHost"[^>]+value=""/);
  assert.match(html, /placeholder="user@address"/);
});

test('wizRemote: preserves typed host in value when W.host is set', () => {
  const settings = installSettings({});
  settings.W.hosts = { hosts: ['192.168.68.79', 'icm-server'], remotes: [] };
  settings.W.host = 'custom-server';

  const html = settings.wizRemote(() => '<button>Connect</button>');
  assert.match(html, /<input[^>]+id="welHost"[^>]+value="custom-server"/);
  assert.match(html, /placeholder="192\.168\.68\.79"/);
});
