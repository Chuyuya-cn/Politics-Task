// Verifies the single-file standalone build loaded from file://, which is how a
// student opens it on a phone. The page must work with no local server: content
// comes from the embedded block and API calls go straight to DeepSeek.
import { openTarget } from './cdp.mjs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { mkdirSync } from 'node:fs';

const SHOTS = path.join('screenshots', 'standalone');
mkdirSync(SHOTS, { recursive: true });

const results = [];
function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FILE = pathToFileURL(path.resolve('web/政问-单文件版.html')).href;

const devices = [
  { name: 'android', width: 412, height: 915, dpr: 2.6 },
  { name: 'ios', width: 390, height: 844, dpr: 3 },
  { name: 'harmony', width: 360, height: 780, dpr: 3 },
];

let page;
try {
  page = await openTarget(FILE, { port: 9223, viewport: { width: 412, height: 915 } });
  await page.waitFor('document.querySelector("#init-screen")', 12000);
  await sleep(900);

  const boot = await page.evaluate(`(() => ({
    protocol: location.protocol,
    standalone: Boolean(window.__PQ_STANDALONE__),
    hasContent: Boolean(window.__PQ_CONTENT__),
    promptCount: Object.keys(window.__PQ_CONTENT__?.prompts || {}).length,
    bgCount: (window.__PQ_CONTENT__?.manifest?.backgrounds || []).length,
    bgSrc: document.querySelector('#bg-image')?.getAttribute('src')?.slice(0, 22) || '',
    bootErrorVisible: !document.querySelector('#boot-error').hidden,
    initVisible: !document.querySelector('#init-screen').hidden,
    modeCount: document.querySelectorAll('#prompt-select option').length,
    modeLabel: document.querySelector('#mode-label')?.textContent || '',
  }))()`);

  check('opened from file://', boot.protocol === 'file:', boot.protocol);
  check('standalone flag set', boot.standalone);
  check('content embedded', boot.hasContent && boot.promptCount === 4, `${boot.promptCount} prompts`);
  check('background is data URL', boot.bgSrc.startsWith('data:image/svg+xml'), boot.bgSrc);
  check('boot error not shown', !boot.bootErrorVisible);
  check('init screen visible (not blocked)', boot.initVisible);
  check('four modes loaded from embedded content', boot.modeCount === 4, `${boot.modeCount}`);
  check('default mode label present', boot.modeLabel.length > 0, boot.modeLabel);

  // No network calls to a local server should be attempted.
  const requests = await page.evaluate(`(() => {
    const entries = performance.getEntriesByType('resource').map((e) => e.name);
    return entries.filter((n) => n.includes('/local-api/'));
  })()`);
  check('no /local-api requests in standalone mode', requests.length === 0, requests.join(', '));

  await page.screenshot(path.join(SHOTS, 'standalone-init.png'));

  // Walk all three mobile viewports against the same file.
  for (const device of devices) {
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: device.width,
      height: device.height,
      deviceScaleFactor: device.dpr,
      mobile: true,
    });
    await sleep(450);
    const metrics = await page.evaluate(`(() => {
      const input = document.querySelector('#api-key');
      const btn = document.querySelector('#enter-button');
      const wrap = document.querySelector('.init-wrap').getBoundingClientRect();
      return {
        font: parseFloat(getComputedStyle(input).fontSize),
        btnH: Math.round(btn.getBoundingClientRect().height),
        overflowX: document.documentElement.scrollWidth - innerWidth,
        fits: wrap.top >= 0 && wrap.bottom <= innerHeight + 1,
        appHeight: getComputedStyle(document.documentElement).getPropertyValue('--app-height').trim(),
      };
    })()`);
    check(`${device.name}: input 16px`, metrics.font >= 16, `${metrics.font}px`);
    check(`${device.name}: button >= 44px`, metrics.btnH >= 44, `${metrics.btnH}px`);
    check(`${device.name}: no horizontal overflow`, metrics.overflowX <= 1, `${metrics.overflowX}`);
    check(`${device.name}: card fits viewport`, metrics.fits);
    check(`${device.name}: --app-height set`, /px$/.test(metrics.appHeight), metrics.appHeight);
    await page.screenshot(path.join(SHOTS, `standalone-${device.name}-init.png`));
  }

  // Key validation now hits DeepSeek directly; a bogus key must produce a clean
  // Chinese error rather than a CORS failure or a raw English message.
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
  });
  await page.setValue('#api-key', 'sk-bogus-standalone-key-0000000000');
  await page.click('#enter-button');
  await page.waitFor('!document.querySelector("#key-error").hidden', 25000);
  const err = await page.text('#key-error');
  check('bogus key shows inline error', err.length > 0, err.slice(0, 60));
  check('error is translated to Chinese', /[\u4e00-\u9fa5]/.test(err), err.slice(0, 60));
  check('still on init screen', await page.visible('#init-screen'));
  await page.screenshot(path.join(SHOTS, 'standalone-invalid-key.png'));

  await page.close();
} catch (error) {
  console.error('STANDALONE E2E ERROR:', error.message);
  results.push({ name: 'standalone run', passed: false, detail: error.message });
  if (page) { try { await page.close(); } catch { /* ignore */ } }
}

const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} standalone checks passed`);
if (failed.length) process.exitCode = 1;
