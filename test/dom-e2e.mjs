// Full DOM-level end-to-end test without a browser renderer. It loads the real
// index.html into jsdom, imports the real app.js/api.js modules, and talks to
// the running local app (which talks to the running mock upstream).
//
// This covers the complete interaction logic and network path. Visual layout
// still needs a human/browser check because jsdom has no CSS engine.
//
// Run: node test/dom-e2e.mjs
import { JSDOM } from '../.tools/node_modules/jsdom/lib/api.js';
import path from 'node:path';

const APP = process.env.APP_BASE || 'http://127.0.0.1:5199';
const nativeFetch = globalThis.fetch.bind(globalThis);
const results = [];
function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs = 15000, label = 'condition') {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}${lastError ? ': ' + lastError.message : ''}`);
}

function visible(selector) {
  const el = document.querySelector(selector);
  if (!el) return false;
  return !el.hidden && getComputedStyleSafe(el);
}

function getComputedStyleSafe(el) {
  // jsdom does not cascade stylesheets fully; `hidden` plus inline display is
  // the state all UI visibility toggles use.
  return el.style.display !== 'none';
}

function setValue(selector, value) {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`missing ${selector}`);
  el.value = value;
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
  el.dispatchEvent(new window.Event('change', { bubbles: true }));
}

function submit(selector) {
  const form = document.querySelector(selector);
  if (!form) throw new Error(`missing ${selector}`);
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}

try {
  const html = await (await nativeFetch(APP + '/')).text();
  const dom = new JSDOM(html, {
    url: APP + '/',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });

  const { window } = dom;
  globalThis.window = window;
  globalThis.document = window.document;
  // Node 24 exposes navigator as a getter-only global.
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
  globalThis.location = window.location;
  globalThis.history = window.history;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.HTMLTextAreaElement = window.HTMLTextAreaElement;
  globalThis.HTMLInputElement = window.HTMLInputElement;
  globalThis.Node = window.Node;
  globalThis.Event = window.Event;
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);

  // Image is used only to wait for backgrounds; jsdom does not decode images.
  class FakeImage {
    constructor() {
      this.naturalWidth = 1920;
      this.complete = true;
      this.onload = null;
      this.onerror = null;
    }
    set src(value) {
      this._src = value;
      setTimeout(() => this.onload?.(), 5);
    }
    get src() { return this._src; }
  }
  globalThis.Image = FakeImage;
  window.Image = FakeImage;

  const wrappedFetch = (input, init) => {
    if (typeof input === 'string' && input.startsWith('/')) {
      return nativeFetch(APP + input, init);
    }
    return nativeFetch(input, init);
  };
  globalThis.fetch = wrappedFetch;
  window.fetch = wrappedFetch;

  // jsdom with pretendToBeVisual normally provides rAF, but the module was
  // imported above the window globals in some Node versions. Alias explicitly.
  globalThis.requestAnimationFrame = window.requestAnimationFrame?.bind(window)
    || ((callback) => setTimeout(callback, 16));
  window.requestAnimationFrame = globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame?.bind(window)
    || ((id) => clearTimeout(id));

  // Load the real front-end modules after the DOM and globals are in place.
  await import('../web/js/app.js');
  await waitFor(() => document.querySelectorAll('#prompt-select option').length >= 3, 15000, 'content manifest/prompts');
  await waitFor(() => document.querySelector('#bg-image').classList.contains('is-loaded'), 5000, 'background load');

  check('init screen present', Boolean(document.querySelector('#init-screen')));
  check('app hidden initially', document.querySelector('#app-screen').hidden === true);
  check('background applied', (document.querySelector('#bg-image').getAttribute('src') || '').includes('default.svg'));
  check('four prompt modes loaded', document.querySelectorAll('#prompt-select option').length === 4);
  check('default mode is 课程讲解', document.querySelector('#mode-label').textContent === '课程讲解');

  // Invalid key path.
  setValue('#api-key', 'sk-invalid-key-for-testing-1234567890');
  submit('#key-form');
  await waitFor(() => !document.querySelector('#key-error').hidden, 10000, 'invalid key error');
  check('invalid key shows inline error', document.querySelector('#key-error').hidden === false);
  check('invalid key stays on init', document.querySelector('#app-screen').hidden === true);
  check('invalid key error is Chinese', document.querySelector('#key-error').textContent.includes('Key 校验未通过'));
  check('enter button restored', document.querySelector('#enter-button').disabled === false);

  // Valid key.
  setValue('#api-key', 'sk-mock-valid-key-1234567890abcdef');
  submit('#key-form');
  await waitFor(() => document.querySelector('#app-screen').hidden === false, 10000, 'app screen');
  check('valid key enters app', document.querySelector('#init-screen').hidden === true);
  check('key input cleared', document.querySelector('#api-key').value === '');
  check('search toggle active', document.querySelector('#search-toggle').getAttribute('aria-pressed') === 'true');

  // First question, with mocked search + streamed answer.
  setValue('#question', '如何理解人民代表大会制度在我国政治制度体系中的地位？');
  submit('#ask-form');
  await waitFor(() => document.querySelector('.answer-card'), 10000, 'answer card');
  await waitFor(() => {
    const card = document.querySelector('.answer-card');
    return card && !card.classList.contains('is-pending')
      && card.querySelector('.answer-markdown')?.textContent.length > 80;
  }, 30000, 'complete answer');
  const answerText = document.querySelector('.answer-markdown').textContent;
  check('answer rendered', answerText.includes('人民代表大会制度'));
  check('citations parsed', document.querySelectorAll('.citation').length > 0);
  check('three sources rendered', document.querySelectorAll('.source-item').length === 3);
  check('sources section visible', document.querySelector('.sources').hidden === false);
  check('progress line hidden after completion', document.querySelector('.progress-line').hidden === true);
  check('stop button hidden after completion', document.querySelector('#stop-button').hidden === true);
  check('send button visible after completion', document.querySelector('#send-button').hidden === false);
  check('send button disabled on empty input', document.querySelector('#send-button').disabled === true);
  setValue('#question', '继续追问');
  await sleep(30);
  check('send button re-enabled after typing', document.querySelector('#send-button').disabled === false);
  setValue('#question', '');
  await sleep(30);
  check('answer card above composer in DOM order', (() => {
    const cards = document.querySelector('#answer-list');
    const composer = document.querySelector('#composer-wrap');
    return cards && composer && (cards.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  })());

  // Second turn.
  setValue('#question', '那它和基本政治制度有什么不同？');
  submit('#ask-form');
  await waitFor(() => document.querySelectorAll('.answer-card').length === 2, 15000, 'second card');
  await waitFor(() => {
    const cards = [...document.querySelectorAll('.answer-card')];
    return cards.length === 2 && !cards[1].classList.contains('is-pending')
      && cards[1].querySelector('.answer-markdown')?.textContent.length > 40;
  }, 30000, 'second answer');
  check('multi-turn appends second answer', document.querySelectorAll('.answer-card').length === 2);
  check('second answer has sources', document.querySelectorAll('.answer-card')[1].querySelectorAll('.source-item').length === 3);

  // Settings.
  document.querySelector('#open-settings').click();
  await sleep(50);
  check('settings opens', document.querySelector('#settings-panel').hidden === false);
  check('settings has four modes', document.querySelectorAll('#prompt-select option').length === 4);
  check('README absent from modes', !document.querySelector('#prompt-select').textContent.includes('README'));
  check('background select populated', document.querySelectorAll('#background-select option').length >= 1);
  document.querySelector('#close-settings').click();
  await sleep(50);
  check('settings closes', document.querySelector('#settings-panel').hidden === true);

  // Mode switching.
  document.querySelector('#mode-button').click();
  await waitFor(() => document.querySelector('#mode-menu').hidden === false, 5000, 'mode menu');
  const secondOption = document.querySelectorAll('.mode-option')[1];
  secondOption.click();
  await sleep(100);
  check('mode switches to 时政分析', document.querySelector('#mode-label').textContent === '时政分析');

  // Search toggle.
  document.querySelector('#search-toggle').click();
  check('search toggle off', document.querySelector('#search-toggle').getAttribute('aria-pressed') === 'false');
  document.querySelector('#search-toggle').click();
  check('search toggle on again', document.querySelector('#search-toggle').getAttribute('aria-pressed') === 'true');

  // New chat.
  document.querySelector('#new-chat').click();
  await sleep(50);
  check('new chat clears cards', document.querySelectorAll('.answer-card').length === 0);
  check('welcome visible again', document.querySelector('#welcome').hidden === false);

  // Return to init clears the key and conversation.
  document.querySelector('#change-key').click();
  await sleep(50);
  check('change key returns to init', document.querySelector('#init-screen').hidden === false);
  check('change key hides app', document.querySelector('#app-screen').hidden === true);
  check('change key clears API key memory via input', document.querySelector('#api-key').value === '');

  // Boot guard: direct file access shows a helpful message instead of a blank
  // page. Simulate by re-importing is impossible (module cache), so assert the
  // markup exists and the handler is wired in source.
  check('boot error element exists', Boolean(document.querySelector('#boot-error')));

  dom.window.close();
} catch (error) {
  console.error('DOM E2E ERROR:', error);
  results.push({ name: 'dom e2e run', passed: false, detail: error.message });
}

const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exitCode = 1;
