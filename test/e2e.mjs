// End-to-end UI test over CDP. Servers must already be running:
//   node test/mock-upstream.mjs (port 9017)
//   politicsqa.exe -no-open -port 5199 -upstream http://127.0.0.1:9017
//   chrome --headless=new --remote-debugging-port=9223 ...
// Run: node test/e2e.mjs
import { openTarget } from './cdp.mjs';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SHOTS = path.join(ROOT, 'screenshots');
mkdirSync(SHOTS, { recursive: true });

const APP = 'http://127.0.0.1:5199/';
const CDP_PORT = 9223;

const results = [];
function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let page;
let expected401 = true;
try {
  page = await openTarget(APP, { port: CDP_PORT, viewport: { width: 1440, height: 900 } });
  await page.waitFor('document.querySelector("#init-screen") && document.readyState === "complete"', 15000);
  await page.waitFor('document.querySelector("#bg-image").classList.contains("is-loaded")', 12000);
  await sleep(900);

  check('init screen visible', await page.visible('#init-screen'));
  check('main app hidden initially', !(await page.visible('#app-screen')));
  check('background image loaded', await page.evaluate('document.querySelector("#bg-image").naturalWidth > 0'));
  check('default background is default.svg', (await page.evaluate('document.querySelector("#bg-image").getAttribute("src") || ""')).includes('default.svg'));
  check('init card uses frosted glass', await page.evaluate(`(() => {
    const card = document.querySelector('.init-card');
    const style = getComputedStyle(card);
    return style.backdropFilter.includes('blur') || style.webkitBackdropFilter.includes('blur');
  })()`));
  await page.screenshot(path.join(SHOTS, '01-init.png'));

  // Invalid key -> inline error, stay on init.
  await page.setValue('#api-key', 'sk-invalid-key-for-testing-1234567890');
  await page.click('#enter-button');
  await page.waitFor('!document.querySelector("#key-error").hidden', 10000);
  check('invalid key stays on init', await page.visible('#init-screen'));
  check('invalid key shows error', await page.visible('#key-error'));
  check('enter button re-enabled', await page.evaluate('!document.querySelector("#enter-button").disabled'));
  await sleep(300);
  await page.screenshot(path.join(SHOTS, '02-invalid-key.png'));

  // Valid key -> main app.
  await page.setValue('#api-key', 'sk-mock-valid-key-1234567890abcdef');
  await page.click('#enter-button');
  await page.waitFor('!document.querySelector("#app-screen").hidden', 10000);
  await page.waitFor('document.querySelector("#init-screen").hidden', 5000);
  await sleep(700);

  check('app screen visible after valid key', await page.visible('#app-screen'));
  check('key field cleared', (await page.evaluate('document.querySelector("#api-key").value')) === '');
  check('welcome suggestions visible', await page.visible('.suggestion'));
  check('search toggle on by default', (await page.evaluate('document.querySelector("#search-toggle").getAttribute("aria-pressed")')) === 'true');
  check('composer positioned in lower half', await page.evaluate(`(() => {
    const rect = document.querySelector('#composer-wrap').getBoundingClientRect();
    return rect.top > window.innerHeight * 0.55;
  })()`));
  await page.screenshot(path.join(SHOTS, '03-main-empty.png'));

  // Ask first question.
  await page.setValue('#question', '如何理解人民代表大会制度在我国政治制度体系中的地位？');
  await sleep(150);
  check('send button enabled after typing', await page.evaluate('!document.querySelector("#send-button").disabled'));
  await page.click('#send-button');
  await page.waitFor('document.querySelector(".answer-card")', 10000);
  await page.waitFor(`(() => {
    const card = document.querySelector('.answer-card');
    return card && !card.classList.contains('is-pending')
      && (card.querySelector('.answer-markdown')?.innerText || '').length > 80;
  })()`, 30000);
  await sleep(700);

  const answerText = await page.text('.answer-markdown');
  check('answer rendered', answerText.includes('人民代表大会制度'));
  check('citations rendered', (await page.count('.citation')) > 0);
  check('three sources rendered', (await page.count('.source-item')) === 3);
  check('sources section visible', await page.visible('.sources'));
  check('stop button hidden after completion', !(await page.visible('#stop-button')));
  check('answer card above composer', await page.evaluate(`(() => {
    const card = document.querySelector('.answer-card').getBoundingClientRect();
    const composer = document.querySelector('#composer-wrap').getBoundingClientRect();
    return card.bottom <= composer.top + 8;
  })()`));
  check('answer card uses frosted glass', await page.evaluate(`(() => {
    const style = getComputedStyle(document.querySelector('.answer-card'));
    return style.backdropFilter.includes('blur') || style.webkitBackdropFilter.includes('blur');
  })()`));
  await page.screenshot(path.join(SHOTS, '04-answer.png'));

  // Follow-up, same conversation.
  await page.setValue('#question', '那它和基本政治制度有什么不同？');
  await page.click('#send-button');
  await page.waitFor('document.querySelectorAll(".answer-card").length === 2', 15000);
  await page.waitFor(`(() => {
    const cards = [...document.querySelectorAll('.answer-card')];
    return cards.length === 2 && !cards[1].classList.contains('is-pending')
      && (cards[1].querySelector('.answer-markdown')?.innerText || '').length > 40;
  })()`, 30000);
  await sleep(600);
  check('second answer appended', (await page.count('.answer-card')) === 2);
  await page.screenshot(path.join(SHOTS, '05-multi-turn.png'));

  // Settings and content folders.
  await page.click('#open-settings');
  await page.waitFor('!document.querySelector("#settings-panel").hidden', 5000);
  await sleep(500);
  check('settings panel visible', await page.visible('#settings-panel'));
  const promptOptions = await page.count('#prompt-select option');
  check('four prompt modes listed', promptOptions === 4, `found ${promptOptions}`);
  check('README excluded from modes', !(await page.text('#prompt-select')).includes('README'));
  check('background available', (await page.count('#background-select option')) >= 1);
  await page.screenshot(path.join(SHOTS, '06-settings.png'));
  await page.click('#close-settings');
  await page.waitFor('document.querySelector("#settings-panel").hidden', 5000);

  // Mode menu switches the active prompt.
  await page.click('#mode-button');
  await page.waitFor('!document.querySelector("#mode-menu").hidden', 5000);
  await page.evaluate('document.querySelectorAll(".mode-option")[1].click()');
  await sleep(250);
  check('mode label changes', (await page.text('#mode-label')) === '时政分析');

  // New conversation.
  await page.click('#new-chat');
  await sleep(400);
  check('new chat clears answers', (await page.count('.answer-card')) === 0);
  check('welcome returns', await page.visible('#welcome'));

  // Mobile layout and screenshot.
  await page.setViewport(390, 844, true);
  await sleep(600);
  await page.screenshot(path.join(SHOTS, '07-mobile-empty.png'));
  check('mobile composer visible', await page.visible('#ask-form'));
  check('mobile no horizontal overflow (empty)', await page.evaluate('document.documentElement.scrollWidth - window.innerWidth <= 1'));
  await page.setValue('#question', '全过程人民民主主要包括哪些环节？');
  await page.click('#send-button');
  await page.waitFor(`(() => {
    const card = document.querySelector('.answer-card');
    return card && !card.classList.contains('is-pending')
      && (card.querySelector('.answer-markdown')?.innerText || '').length > 40;
  })()`, 30000);
  await sleep(700);
  await page.screenshot(path.join(SHOTS, '08-mobile-answer.png'));
  const overflow = await page.evaluate('document.documentElement.scrollWidth - window.innerWidth');
  check('no horizontal overflow on mobile', overflow <= 1, `overflow=${overflow}`);
  check('mobile input reachable', await page.evaluate(`(() => {
    const rect = document.querySelector('#ask-form').getBoundingClientRect();
    return rect.bottom <= window.innerHeight + 2 && rect.top > 0;
  })()`));

  const consoleErrors = [...page.consoleErrors, ...page.logErrors].filter((text) => {
    // The invalid-key test intentionally triggers one 401. Browsers log every
    // failed network response as a console error, so exclude that expected one.
    if (text.includes('401')) return false;
    if (text.includes('favicon')) return false;
    return true;
  });
  check('no unexpected console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  // Search failure should degrade gracefully to a normal answer.
  await page.click('#new-chat');
  await page.waitFor('document.querySelector("#welcome") && !document.querySelector("#welcome").hidden', 5000);
  await page.setValue('#question', 'FAIL_SEARCH 人民代表大会制度');
  await page.click('#send-button');
  await page.waitFor('document.querySelector(".answer-card:not(.is-pending)")', 30000);
  await page.waitFor(`(() => {
    const card = document.querySelector('.answer-card');
    return card && !card.classList.contains('is-pending')
      && (card.querySelector('.answer-markdown')?.innerText || '').length > 40;
  })()`, 30000);
  await sleep(300);
  check('search failure still produces an answer', (await page.count('.answer-card')) === 1);
  check('search failure shows no sources', (await page.count('.source-item')) === 0);

  // Chat upstream failure should show a retryable error state.
  await page.click('#new-chat');
  await page.waitFor('document.querySelector("#welcome") && !document.querySelector("#welcome").hidden', 5000);
  await page.setValue('#question', 'FAIL_CHAT 人民代表大会制度');
  await page.click('#send-button');
  await page.waitFor('document.querySelector(".answer-error:not([hidden])")', 30000);
  check('chat failure shows error card', await page.visible('.answer-error'));
  check('chat failure offers retry', await page.visible('.answer-retry'));
  await sleep(300);
  await page.screenshot(path.join(SHOTS, '09-error-state.png'));

  // Stop generation mid-stream.
  await page.evaluate('document.querySelector("#new-chat").click()');
  await sleep(250);
  await page.setValue('#question', 'SLOW_CHAT 人民代表大会制度');
  await page.click('#send-button');
  await page.waitFor('document.querySelector(".answer-card")', 10000);
  await page.waitFor('document.querySelector(".answer-card .answer-markdown").textContent.length > 20', 15000);
  check('stop button appears while streaming', await page.visible('#stop-button'));
  await page.click('#stop-button');
  await page.waitFor('document.querySelector("#stop-button").hidden', 10000);
  check('stopped stream remains as partial answer', (await page.evaluate('document.querySelector(".answer-markdown").textContent.length')) > 0);
  check('stop button hidden after cancel', !(await page.visible('#stop-button')));

  // Keyboard focus trap in the settings drawer.
  await page.click('#open-settings');
  await page.waitFor('!document.querySelector("#settings-panel").hidden', 5000);
  await sleep(300);
  await page.evaluate(`(() => {
    const panel = document.querySelector('#settings-panel');
    const buttons = [...panel.querySelectorAll('button:not([disabled]), select:not([disabled])')].filter((el) => el.getClientRects().length);
    panel.querySelector('#close-settings').focus();
    return buttons.length;
  })()`);
  check('settings close button focused', (await page.evaluate('document.activeElement.id')) === 'close-settings');
  await page.evaluate(`document.querySelector('#close-settings').focus()`);
  await page.sendKey?.('Shift+Tab');
  await page.evaluate(`(() => {
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    return true;
  })()`);
  await sleep(80);
  check('focus stays inside settings when shift-tabbing', await page.evaluate(`(() => {
    const panel = document.querySelector('#settings-panel');
    return panel.contains(document.activeElement);
  })()`));
  await page.evaluate(`(() => {
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: false, bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    return true;
  })()`);
  await sleep(80);
  check('focus stays inside settings when tabbing', await page.evaluate(`(() => {
    const panel = document.querySelector('#settings-panel');
    return panel.contains(document.activeElement);
  })()`));
  await page.click('#close-settings');
  await page.waitFor('document.querySelector("#settings-panel").hidden', 5000);
  check('focus returns to settings trigger', (await page.evaluate('document.activeElement.id')) === 'open-settings');

  await page.close();
} catch (error) {
  console.error('E2E ERROR:', error);
  results.push({ name: 'e2e run', passed: false, detail: error.message });
  if (page) {
    try { await page.screenshot(path.join(SHOTS, '99-error.png')); } catch { /* ignore */ }
    try { await page.close(); } catch { /* ignore */ }
  }
}

const failed = results.filter((result) => !result.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exitCode = 1;
