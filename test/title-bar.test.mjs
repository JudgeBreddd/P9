import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron } from '@playwright/test';

const root = fileURLToPath(new URL('../', import.meta.url));

// O25: on Windows and Linux the OS title bar is gone. The window buttons are drawn over the right end of P9's top row, the row
// is the drag region, and every control in it still takes a click (no-drag, clear of the buttons). macOS keeps its title bar.
test('title bar: no OS title bar; the top row drags, its controls click, the window buttons have room', { timeout: 90000, skip: process.platform === 'darwin' }, async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'p9-titlebar-'));
  const env = { ...process.env, P9_SAMPLE_DATA: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  const application = await _electron.launch({ args: [path.join(root, 'apps/desktop/start.cjs'), '--user-data-dir=' + profile], env, chromiumSandbox: true, timeout: 15000 });
  try {
    const page = await application.firstWindow({ timeout: 15000 });
    await page.locator('.topbar #setBtn').waitFor({ timeout: 15000 });
    const bar = await page.evaluate(() => {
      const top = document.querySelector('.topbar'), wco = navigator.windowControlsOverlay;
      const area = wco?.visible ? wco.getTitlebarAreaRect() : null;
      const region = el => getComputedStyle(el).getPropertyValue('-webkit-app-region') || getComputedStyle(el).webkitAppRegion;
      const controls = [...top.querySelectorAll('button, [role=tab]')].filter(el => el.offsetParent && el.getBoundingClientRect().width);
      return {
        overlay: !!wco?.visible, area: area && { x: area.x, width: area.width, height: area.height }, width: innerWidth,
        topRegion: region(top), topRight: top.getBoundingClientRect().right - parseFloat(getComputedStyle(top).paddingRight),
        controls: controls.map(el => {
          const r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          const strip = el.closest('.tabs')?.getBoundingClientRect(), cx = r.x + r.width / 2;
          return { id: el.id || el.className, region: region(el), right: Math.min(r.right, strip?.right ?? r.right), hit: el === hit || el.contains(hit),
            hidden: !!strip && (cx < strip.left || cx > strip.right), what: hit && (hit.id || hit.className || hit.tagName), at: [Math.round(r.x), Math.round(r.right)], strip: strip && [Math.round(strip.left), Math.round(strip.right)] };
        }),
      };
    });
    assert.ok(bar.overlay, 'the window-controls overlay is on (titleBarStyle hidden + titleBarOverlay)');
    assert.ok(bar.area.width < bar.width, `room is left for the window buttons: title bar area ${bar.area.width} of ${bar.width}`);
    assert.equal(bar.topRegion, 'drag', 'the top row drags the window');
    assert.ok(bar.controls.length > 4, 'the top row has its controls');
    for (const c of bar.controls) {
      assert.equal(c.region, 'no-drag', `${c.id} takes clicks, not drags`);
      if (!c.hidden) assert.ok(c.hit, `${c.id} is on top at its centre: ${JSON.stringify(c)}`);
      assert.ok(c.right <= bar.area.x + bar.area.width, `${c.id} ends left of the window buttons (${c.right} > ${bar.area.x + bar.area.width})`);
    }
    if (process.env.P9_EVIDENCE) await page.screenshot({ path: path.join(process.env.P9_EVIDENCE, 'title-bar-top-row.png'), clip: { x: 0, y: 0, width: bar.width, height: 44 } });
    else if (!process.env.GITHUB_ACTIONS) console.log('P9_SHOT title-bar-top-row ' + (await page.screenshot({ clip: { x: 0, y: 0, width: bar.width, height: 44 } })).toString('base64'));
  } finally { await application.close(); await rm(profile, { recursive: true, force: true }); }
});
