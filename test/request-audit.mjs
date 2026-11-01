// Verifies the exact DeepSeek request produced by the *real* UI, using the
// mock's /debug/last endpoint. Requires browser E2E to have run (or run it here
// via CDP against the mock).
import { openTarget } from './cdp.mjs';

const APP = 'http://127.0.0.1:5199/';
const MOCK = 'http://127.0.0.1:9017';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

let page;
try {
  // Reset mock state by asking through a fresh page.
  page = await openTarget(APP, { port: 9223, viewport: { width: 1200, height: 800 } });
  await page.waitFor('document.querySelector("#init-screen")', 10000);
  await page.setValue('#api-key', 'sk-mock-valid-key-1234567890abcdef');
  await page.click('#enter-button');
  await page.waitFor('!document.querySelector("#app-screen").hidden', 10000);
  await page.setValue('#question', '如何理解人民代表大会制度？');
  await page.click('#send-button');
  await page.waitFor('document.querySelector(".answer-card")', 15000);
  await page.waitFor(`(() => {
    const card = document.querySelector('.answer-card');
    return card && !card.classList.contains('is-pending')
      && (card.querySelector('.answer-markdown')?.innerText || '').length > 40;
  })()`, 30000);
  await sleep(400);

  const debug = await (await fetch(MOCK + '/debug/last')).json();
  const chat = debug.chat;
  const search = debug.search;

  check('UI sent a chat request', Boolean(chat));
  check('UI used deepseek-flash', chat?.model === 'deepseek-flash');
  check('UI streamed', chat?.stream === true);
  check('UI enabled thinking', chat?.thinking?.type === 'enabled');
  check('UI set low reasoning effort', chat?.reasoning_effort === 'low');
  check('UI capped output tokens', Number(chat?.max_tokens) >= 1024);
  check('UI sent system message first', chat?.messages?.[0]?.role === 'system');
  check('system prompt includes core rule', (chat?.messages?.[0]?.content || '').includes('不得编造'));
  check('system prompt includes mode direction', (chat?.messages?.[0]?.content || '').includes('回答方向'));
  check('system prompt includes source block', (chat?.messages?.[0]?.content || '').includes('[1] 中华人民共和国全国人民代表大会组织法'));
  check('current question sent last', chat?.messages?.at(-1)?.content === '如何理解人民代表大会制度？');
  check('UI did not send reasoning back', !JSON.stringify(chat?.messages || []).includes('reasoning_content'));

  check('UI performed one search', Boolean(search));
  check('search query is the question', (search?.query || '').includes('人民代表大会制度'));
  check('search count is five', Number(search?.count) === 5);
  check('search did not request full page content', search?.need_content === false);
  check('search includes original question', (search?.ori_question || '').includes('人民代表大会制度'));

  // Follow-up: ensure history is included and search query context is used.
  await page.setValue('#question', '那它和基本政治制度有什么不同？');
  await page.click('#send-button');
  await page.waitFor('document.querySelectorAll(".answer-card").length === 2', 15000);
  await page.waitFor(`(() => {
    const cards = [...document.querySelectorAll('.answer-card')];
    return cards.length === 2 && !cards[1].classList.contains('is-pending')
      && (cards[1].querySelector('.answer-markdown')?.innerText || '').length > 40;
  })()`, 30000);
  await sleep(300);
  const debug2 = await (await fetch(MOCK + '/debug/last')).json();
  check('follow-up includes prior user question', (debug2.chat?.messages || []).some((m) => m.role === 'user' && m.content.includes('如何理解人民代表大会制度')));
  check('follow-up includes prior assistant answer', (debug2.chat?.messages || []).some((m) => m.role === 'assistant' && m.content.includes('人民代表大会制度')));
  check('follow-up search query carries context', (debug2.search?.query || '').includes('人民代表大会制度'));
  check('old citations stripped from history', !(debug2.chat?.messages || []).some((m) => m.role === 'assistant' && /\[\d\]/.test(m.content)));

  await page.close();
} catch (error) {
  console.error('REQUEST AUDIT ERROR:', error);
  results.push({ name: 'request audit', passed: false, detail: error.message });
  if (page) { try { await page.close(); } catch { /* ignore */ } }
}

const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exitCode = 1;
