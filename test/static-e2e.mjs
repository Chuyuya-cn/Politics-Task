// Verifies the static-hosting build the way it will actually be used: over
// http(s), iPhone viewport, calling DeepSeek directly with CORS preflight.
// Requests to api.deepseek.com are stubbed via CDP so no credit is spent.
import { openTarget } from './cdp.mjs';
import path from 'node:path';
import { mkdirSync } from 'node:fs';

const SHOTS = path.join('screenshots', 'static');
mkdirSync(SHOTS, { recursive: true });

const BASE = process.env.STATIC_BASE || 'http://127.0.0.1:8099/';
const results = [];
function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ANSWER = '人民代表大会制度是我国的根本政治制度。[1]\n\n它居于政治制度体系核心，实行民主集中制。[2]\n';
const SEARCH = {
  results: [
    { title: '中华人民共和国宪法（节选）', url: 'https://www.gov.cn/guoqing/2018-03/22/content_5276318.htm', summary: '一切权力属于人民。', site_name: '中国政府网', date: '2018-03-22T00:00:00+00:00' },
    { title: '全国人民代表大会组织法', url: 'https://www.gov.cn/xinwen/2021-03/12/content_5592295.htm', summary: '最高国家权力机关。', site_name: '中国政府网', date: '2021-03-12T00:00:00+00:00' },
  ],
};

function sse() {
  const chunks = ANSWER.match(/.{1,24}/gs) || [];
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '先厘清定位。' }, index: 0 }] })}\n\n`,
    ...chunks.map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c }, index: 0 }] })}\n\n`),
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
}

let page;
try {
  page = await openTarget(BASE, { port: 9223, viewport: { width: 390, height: 844 } });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await page.send('Emulation.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    platform: 'iPhone',
  });
  await page.send('Page.reload');
  await page.waitFor('document.querySelector("#init-screen")', 15000);
  await sleep(800);

  const boot = await page.evaluate(`(() => ({
    protocol: location.protocol,
    staticFlag: Boolean(window.__PQ_STATIC_HOST__),
    standalone: Boolean(window.__PQ_STANDALONE__),
    manifestLink: Boolean(document.querySelector('link[rel=manifest]')),
    secureContext: window.isSecureContext,
    manifest: performance.getEntriesByType('resource').some((e) => e.name.includes('content.json')),
  }))()`);

  check('served over http(s), not file://', boot.protocol === 'http:', boot.protocol);
  check('static-host flag active', boot.staticFlag);
  check('standalone flag absent', !boot.standalone);
  check('PWA manifest linked (add to home screen)', boot.manifestLink);
  check('loads content.json instead of local-api', boot.manifest);

  const content = await (await fetch(BASE + 'content.json')).json();
  check('content.json lists prompts', content.prompts.length === 4, `${content.prompts.length}`);
  check('content.json lists backgrounds', content.backgrounds.length >= 1);
  check('prompt urls are static paths', content.prompts.every((p) => p.url.startsWith('prompts/')));
  check('prompts shipped as .txt (IIS-safe)', content.prompts.every((p) => p.url.endsWith('.txt')));

  const promptRes = await fetch(BASE + content.prompts[0].url);
  const promptText = await promptRes.text();
  check('prompt file served as static asset', promptRes.ok && promptText.includes('回答方向'), `${promptText.length} chars`);

  // Backgrounds are inlined as data URLs so IIS needs no .svg MIME mapping.
  const bg = content.backgrounds[0];
  check('background is an inline data URL', String(bg?.url || '').startsWith('data:image/'), String(bg?.url || '').slice(0, 30));
  const bgUsable = await page.evaluate(`(() => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth > 0);
    img.onerror = () => resolve(false);
    img.src = ${JSON.stringify(bg?.url || '')};
  }))()`);
  check('inline background actually decodes', bgUsable);
  check('page rendered the background', await page.evaluate('document.querySelector("#bg-image").naturalWidth > 0'));

  const modeCount = await page.count('#prompt-select option');
  check('four modes loaded from static manifest', modeCount === 4, `${modeCount}`);

  await page.screenshot(path.join(SHOTS, 'static-init-ios.png'));

  // Intercept the API, including preflight.
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*api.deepseek.com*', requestStage: 'Request' }] });
  const seen = { validate: 0, search: 0, chat: 0, chatBody: '', searchBody: '' };

  page.on('Fetch.requestPaused', async (params) => {
    const { requestId, request } = params;
    const url = request.url;
    const cors = [
      { name: 'Access-Control-Allow-Origin', value: 'http://127.0.0.1:8099' },
      { name: 'Access-Control-Allow-Methods', value: 'GET, POST, OPTIONS' },
      { name: 'Access-Control-Allow-Headers', value: 'authorization,content-type,accept' },
    ];
    try {
      if (request.method === 'OPTIONS') {
        await page.send('Fetch.fulfillRequest', { requestId, responseCode: 204, responseHeaders: cors });
        return;
      }
      if (url.endsWith('/models')) {
        seen.validate += 1;
        await page.send('Fetch.fulfillRequest', {
          requestId,
          responseCode: 200,
          responseHeaders: [...cors, { name: 'Content-Type', value: 'application/json' }],
          body: Buffer.from(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-flash' }] })).toString('base64'),
        });
        return;
      }
      if (url.includes('/v1/tools/search')) {
        seen.search += 1;
        seen.searchBody = request.postData || '';
        await page.send('Fetch.fulfillRequest', {
          requestId,
          responseCode: 200,
          responseHeaders: [...cors, { name: 'Content-Type', value: 'application/json' }],
          body: Buffer.from(JSON.stringify(SEARCH)).toString('base64'),
        });
        return;
      }
      if (url.includes('/chat/completions')) {
        seen.chat += 1;
        seen.chatBody = request.postData || '';
        await page.send('Fetch.fulfillRequest', {
          requestId,
          responseCode: 200,
          responseHeaders: [...cors, { name: 'Content-Type', value: 'text/event-stream; charset=utf-8' }],
          body: Buffer.from(sse(), 'utf8').toString('base64'),
        });
        return;
      }
      await page.send('Fetch.continueRequest', { requestId });
    } catch { /* page may navigate */ }
  });
  await sleep(250);

  await page.setValue('#api-key', 'sk-static-host-test-000000000000');
  await page.click('#enter-button');
  await page.waitFor('!document.querySelector("#app-screen").hidden', 15000);
  check('key validated against api.deepseek.com directly', seen.validate === 1, `calls=${seen.validate}`);
  check('entered Q&A on iPhone viewport', await page.visible('#app-screen'));
  await sleep(400);
  await page.screenshot(path.join(SHOTS, 'static-main-ios.png'));

  await page.setValue('#question', '如何理解人民代表大会制度？');
  await page.click('#send-button');
  await page.waitFor(`(() => {
    const card = document.querySelector('.answer-card');
    return card && !card.classList.contains('is-pending')
      && (card.querySelector('.answer-markdown')?.innerText || '').length > 30;
  })()`, 30000);
  await sleep(400);

  const ui = await page.evaluate(`(() => ({
    text: document.querySelector('.answer-markdown').innerText,
    citations: document.querySelectorAll('.citation').length,
    sources: document.querySelectorAll('.source-item').length,
    overflow: document.documentElement.scrollWidth - innerWidth,
  }))()`);

  check('search called the official API', seen.search === 1, `calls=${seen.search}`);
  check('chat streamed from the official API', seen.chat === 1, `calls=${seen.chat}`);
  check('answer rendered', ui.text.includes('人民代表大会制度'), `${ui.text.length} chars`);
  check('citations rendered', ui.citations > 0, `${ui.citations}`);
  check('sources rendered', ui.sources === 2, `${ui.sources}`);
  check('no horizontal overflow on iPhone', ui.overflow <= 1, `overflow=${ui.overflow}`);

  const chat = seen.chatBody ? JSON.parse(seen.chatBody) : null;
  const search = seen.searchBody ? JSON.parse(seen.searchBody) : null;
  check('model is deepseek-flash', chat?.model === 'deepseek-flash', String(chat?.model));
  check('low reasoning effort preserved', chat?.reasoning_effort === 'low');
  check('streaming requested', chat?.stream === true);
  check('system prompt includes sources', /\[1\]/.test(chat?.messages?.[0]?.content || ''));
  check('search requested five results', search?.count === 5, String(search?.count));

  await page.screenshot(path.join(SHOTS, 'static-answer-ios.png'));

  // Service worker registration should succeed on http://127.0.0.1 (secure ctx).
  const sw = await page.evaluate(`navigator.serviceWorker.getRegistrations().then((r) => r.length)`);
  check('service worker registered for offline shell', sw === 1, `registrations=${sw}`);

  await page.close();
} catch (error) {
  console.error('STATIC E2E ERROR:', error.message);
  results.push({ name: 'static run', passed: false, detail: error.message });
  if (page) { try { await page.close(); } catch { /* ignore */ } }
}

const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} static-hosting checks passed`);
if (failed.length) process.exitCode = 1;
