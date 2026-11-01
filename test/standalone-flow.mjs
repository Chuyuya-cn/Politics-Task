// Verifies the full question/answer flow of the single-file build without
// spending API credit: Chrome DevTools intercepts requests to
// api.deepseek.com and fulfils them with canned responses, including a real SSE
// stream. This proves the file:// build can reach the network path end to end.
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

const ANSWER = [
  '人民代表大会制度是我国的根本政治制度。\n\n',
  '从制度定位看，它居于我国政治制度体系的核心，体现为三个维度：\n\n',
  '1. **权力来源**：国家一切权力属于人民，人民通过选举产生各级人大代表。[1]\n',
  '2. **组织原则**：实行民主集中制。[2]\n',
  '3. **制度关系**：其他基本政治制度在它的框架内运行。[3]\n\n',
  '> 提示：注意区分根本政治制度与基本政治制度。\n',
].join('');

const SEARCH_RESULTS = {
  results: [
    { title: '中华人民共和国宪法（节选）', url: 'https://www.gov.cn/guoqing/2018-03/22/content_5276318.htm', summary: '一切权力属于人民。', site_name: '中国政府网', date: '2018-03-22T00:00:00+00:00' },
    { title: '全国人民代表大会组织法', url: 'https://www.gov.cn/xinwen/2021-03/12/content_5592295.htm', summary: '全国人大是最高国家权力机关。', site_name: '中国政府网', date: '2021-03-12T00:00:00+00:00' },
    { title: '人民代表大会制度', url: 'http://www.npc.gov.cn/', summary: '根本政治制度。', site_name: '中国人大网', date: '2020-09-15T00:00:00+00:00' },
  ],
};

function sseBody() {
  const chunks = ANSWER.match(/.{1,40}/gs) || [];
  const lines = [];
  lines.push(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '先厘清制度定位。' }, index: 0 }] })}\n\n`);
  for (const chunk of chunks) {
    lines.push(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk }, index: 0 }] })}\n\n`);
  }
  lines.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] })}\n\n`);
  lines.push('data: [DONE]\n\n');
  return lines.join('');
}

let page;
try {
  page = await openTarget(FILE, { port: 9223, viewport: { width: 390, height: 844 } });
  await page.waitFor('document.querySelector("#init-screen")', 12000);

  // Intercept everything bound for the DeepSeek API.
  await page.send('Fetch.enable', {
    patterns: [{ urlPattern: '*api.deepseek.com*', requestStage: 'Request' }],
  });

  const seen = { validate: 0, search: 0, chat: 0, chatBody: null, searchBody: null };

  page.on('Fetch.requestPaused', async (params) => {
    const { requestId, request } = params;
    const url = request.url;
    try {
      // Cross-origin calls from file:// send Origin: null, so the CORS
      // preflight must be answered by the stub too — otherwise Chrome never
      // issues the real request.
      if (request.method === 'OPTIONS') {
        await page.send('Fetch.fulfillRequest', {
          requestId,
          responseCode: 204,
          responseHeaders: [
            { name: 'Access-Control-Allow-Origin', value: 'null' },
            { name: 'Access-Control-Allow-Methods', value: 'GET, POST, OPTIONS' },
            { name: 'Access-Control-Allow-Headers', value: 'authorization,content-type,accept' },
            { name: 'Access-Control-Max-Age', value: '600' },
          ],
        });
        return;
      }
      if (url.endsWith('/models')) {
        seen.validate += 1;
        await page.send('Fetch.fulfillRequest', {
          requestId,
          responseCode: 200,
          responseHeaders: [
            { name: 'Content-Type', value: 'application/json' },
            { name: 'Access-Control-Allow-Origin', value: 'null' },
          ],
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
          responseHeaders: [
            { name: 'Content-Type', value: 'application/json' },
            { name: 'Access-Control-Allow-Origin', value: 'null' },
          ],
          body: Buffer.from(JSON.stringify(SEARCH_RESULTS)).toString('base64'),
        });
        return;
      }
      if (url.includes('/chat/completions')) {
        seen.chat += 1;
        seen.chatBody = request.postData || '';
        await page.send('Fetch.fulfillRequest', {
          requestId,
          responseCode: 200,
          responseHeaders: [
            { name: 'Content-Type', value: 'text/event-stream; charset=utf-8' },
            { name: 'Access-Control-Allow-Origin', value: 'null' },
          ],
          body: Buffer.from(sseBody(), 'utf8').toString('base64'),
        });
        return;
      }
      await page.send('Fetch.continueRequest', { requestId });
    } catch {
      // The target may close mid-flight; nothing to do.
    }
  });

  await sleep(300);

  // Enter with a syntactically valid key; interception answers the validation.
  await page.setValue('#api-key', 'sk-standalone-test-key-000000000000');
  await page.click('#enter-button');
  await page.waitFor('!document.querySelector("#app-screen").hidden', 15000);
  check('key validation intercepted and accepted', seen.validate === 1, `calls=${seen.validate}`);
  check('entered main screen from file://', await page.visible('#app-screen'));
  await sleep(400);
  await page.screenshot(path.join(SHOTS, 'standalone-main.png'));

  // Ask a question; both search and chat must be issued cross-origin.
  await page.setValue('#question', '如何理解人民代表大会制度？');
  await page.click('#send-button');
  await page.waitFor(`(() => {
    const card = document.querySelector('.answer-card');
    return card && !card.classList.contains('is-pending')
      && (card.querySelector('.answer-markdown')?.innerText || '').length > 60;
  })()`, 30000);
  await sleep(400);

  const ui = await page.evaluate(`(() => ({
    text: document.querySelector('.answer-markdown').innerText,
    citations: document.querySelectorAll('.citation').length,
    sources: document.querySelectorAll('.source-item').length,
    brand: document.querySelector('#mode-label')?.textContent,
  }))()`);

  check('search request issued', seen.search === 1, `calls=${seen.search}`);
  check('chat request issued', seen.chat === 1, `calls=${seen.chat}`);
  check('answer rendered', ui.text.includes('人民代表大会制度'), `${ui.text.length} chars`);
  check('citation markers rendered', ui.citations > 0, `${ui.citations}`);
  check('source list rendered', ui.sources === 3, `${ui.sources}`);

  const chatPayload = seen.chatBody ? JSON.parse(seen.chatBody) : null;
  const searchPayload = seen.searchBody ? JSON.parse(seen.searchBody) : null;
  check('chat used deepseek-flash', chatPayload?.model === 'deepseek-flash', String(chatPayload?.model));
  check('chat enabled thinking at low effort', chatPayload?.thinking?.type === 'enabled' && chatPayload?.reasoning_effort === 'low');
  check('chat requested streaming', chatPayload?.stream === true);
  check('system prompt carries sources', /\[1\]/.test(chatPayload?.messages?.[0]?.content || ''));
  check('system prompt carries core rules', (chatPayload?.messages?.[0]?.content || '').includes('不得编造'));
  check('search sent the question', (searchPayload?.query || '').includes('人民代表大会制度'), String(searchPayload?.query));
  check('search asked for five results', searchPayload?.count === 5, String(searchPayload?.count));

  await page.screenshot(path.join(SHOTS, 'standalone-answer.png'));

  // Second turn keeps context.
  await page.setValue('#question', '那它和基本政治制度有什么不同？');
  await page.click('#send-button');
  await page.waitFor('document.querySelectorAll(".answer-card").length === 2', 15000);
  await page.waitFor(`(() => {
    const cards = [...document.querySelectorAll('.answer-card')];
    return cards.length === 2 && !cards[1].classList.contains('is-pending');
  })()`, 30000);
  const secondPayload = seen.chatBody ? JSON.parse(seen.chatBody) : null;
  check('second turn includes history', (secondPayload?.messages || []).some((m) => m.role === 'assistant'));
  check('two answers on screen', (await page.count('.answer-card')) === 2);

  await page.screenshot(path.join(SHOTS, 'standalone-multi.png'));
  await page.close();
} catch (error) {
  console.error('STANDALONE FLOW ERROR:', error.message);
  results.push({ name: 'standalone flow', passed: false, detail: error.message });
  if (page) { try { await page.close(); } catch { /* ignore */ } }
}

const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} standalone flow checks passed`);
if (failed.length) process.exitCode = 1;
