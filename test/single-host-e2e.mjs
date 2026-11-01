// Verifies the single-file build hosted over HTTP(S) — the deployment shape that
// bypasses the missing-subdirectory 404s on the user's server. Everything is
// inlined, so there is only index.html and no js/ or assets/ to go missing.
import { openTarget } from './cdp.mjs';
import path from 'node:path';
import { mkdirSync } from 'node:fs';

const SHOTS = path.join('screenshots', 'single-host');
mkdirSync(SHOTS, { recursive: true });

const BASE = process.env.SINGLE_BASE || 'http://127.0.0.1:8099/';
const results = [];
function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page;
try {
  page = await openTarget(BASE, { port: 9223, viewport: { width: 390, height: 844 } });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await page.waitFor('document.querySelector("#init-screen")', 15000);
  await sleep(800);

  const boot = await page.evaluate(`(() => ({
    protocol: location.protocol,
    standalone: Boolean(window.__PQ_STANDALONE__),
    modeCount: document.querySelectorAll('#prompt-select option').length,
    modeLabel: document.querySelector('#mode-label')?.textContent || '',
    bg: document.querySelector('#bg-image')?.getAttribute('src')?.slice(0, 22) || '',
    externalResources: performance.getEntriesByType('resource')
      .map((e) => e.name)
      .filter((n) => !n.startsWith('data:') && !n.endsWith('index.html') && !n.includes('api.deepseek.com')),
  }))()`);

  check('served over http(s)', boot.protocol === 'http:', boot.protocol);
  check('standalone flag active', boot.standalone);
  check('four modes loaded', boot.modeCount === 4, `${boot.modeCount}`);
  check('background is inline data URL', boot.bg.startsWith('data:image/'), boot.bg);
  check('no external js/css/asset requests', boot.externalResources.length === 0, boot.externalResources.join(', '));

  await page.screenshot(path.join(SHOTS, 'single-host-init.png'));

  // Enter the app — no key validation against a mock needed here; verify the
  // UI transition works end to end with the DeepSeek calls intercepted.
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*api.deepseek.com*', requestStage: 'Request' }] });
  let validated = 0;
  page.on('Fetch.requestPaused', async (params) => {
    const { requestId, request } = params;
    try {
      if (request.method === 'OPTIONS') {
        await page.send('Fetch.fulfillRequest', {
          requestId,
          responseCode: 204,
          responseHeaders: [
            { name: 'Access-Control-Allow-Origin', value: BASE.replace(/\/$/, '') },
            { name: 'Access-Control-Allow-Methods', value: 'GET, POST, OPTIONS' },
            { name: 'Access-Control-Allow-Headers', value: 'authorization,content-type,accept' },
          ],
        });
        return;
      }
      if (request.url.endsWith('/models')) {
        validated += 1;
        await page.send('Fetch.fulfillRequest', {
          requestId,
          responseCode: 200,
          responseHeaders: [
            { name: 'Content-Type', value: 'application/json' },
            { name: 'Access-Control-Allow-Origin', value: BASE.replace(/\/$/, '') },
          ],
          body: Buffer.from(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-flash' }] })).toString('base64'),
        });
        return;
      }
      await page.send('Fetch.continueRequest', { requestId });
    } catch { /* ignore */ }
  });
  await sleep(200);

  await page.setValue('#api-key', 'sk-hosted-single-test-0000000000');
  await page.click('#enter-button');
  await page.waitFor('!document.querySelector("#app-screen").hidden', 15000);
  check('entered Q&A interface', await page.visible('#app-screen'));
  check('key validated directly against DeepSeek', validated === 1, `calls=${validated}`);
  await page.screenshot(path.join(SHOTS, 'single-host-main.png'));

  await page.close();
} catch (error) {
  console.error('SINGLE-HOST E2E ERROR:', error.message);
  results.push({ name: 'single-host run', passed: false, detail: error.message });
  if (page) { try { await page.close(); } catch { /* ignore */ } }
}

const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} single-host checks passed`);
if (failed.length) process.exitCode = 1;
