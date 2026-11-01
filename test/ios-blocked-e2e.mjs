// Reproduces the iOS Safari failure: a file:// page whose cross-origin requests
// are blocked. The app must not silently hang on the init screen — it must show
// the diagnosis panel with the file:// cause and the LAN-mode way out.
//
// Chrome is told to fail every request to api.deepseek.com, which is the same
// observable behaviour Safari exhibits (fetch rejects, nothing reaches the
// server).
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

let page;
try {
  page = await openTarget(FILE, { port: 9223, viewport: { width: 390, height: 844 } });
  // Present as iOS Safari so the message matches what the user actually hits.
  await page.send('Emulation.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    platform: 'iPhone',
  });
  await page.send('Page.reload');
  await page.waitFor('document.querySelector("#init-screen")', 12000);
  await sleep(600);

  // Fail every request bound for the API, mimicking Safari's opaque-origin block.
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*api.deepseek.com*', requestStage: 'Request' }] });
  let blocked = 0;
  page.on('Fetch.requestPaused', async (params) => {
    blocked += 1;
    try {
      await page.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'Failed' });
    } catch { /* page may have moved on */ }
  });
  await sleep(200);

  await page.setValue('#api-key', 'sk-ios-test-key-0000000000000000');
  await page.click('#enter-button');
  await page.waitFor('!document.querySelector("#net-help").hidden', 20000);
  await sleep(300);

  const panel = await page.evaluate(`(() => {
    const el = document.querySelector('#net-help');
    return {
      visible: !el.hidden,
      title: document.querySelector('#net-help-title').textContent,
      body: document.querySelector('#net-help-body').textContent,
      diagCount: document.querySelectorAll('#net-help-diag dt').length,
      diagText: document.querySelector('#net-help-diag').textContent,
      retryVisible: !document.querySelector('#net-help-retry').hidden,
      bypassVisible: !document.querySelector('#net-help-bypass').hidden,
      keyErrorHidden: document.querySelector('#key-error').hidden,
      stillOnInit: !document.querySelector('#init-screen').hidden,
      enterEnabled: !document.querySelector('#enter-button').disabled,
    };
  })()`);

  check('network failure does not hang silently', panel.visible);
  check('title names the iOS cause', /iOS|Safari/.test(panel.title), panel.title);
  check('body explains opaque origin', /不透明|拦截/.test(panel.body), panel.body.slice(0, 40));
  check('body recommends LAN mode', /局域网|-lan/.test(panel.body));
  check('diagnostics rendered', panel.diagCount >= 5, `${panel.diagCount} rows`);
  check('diagnostics show file:// origin', panel.diagText.includes('file://'), panel.diagText.slice(0, 50));
  check('diagnostics show iOS Safari', panel.diagText.includes('iOS Safari'), panel.diagText.slice(0, 60));
  check('retry and preview actions offered', panel.retryVisible && panel.bypassVisible);
  check('inline key error suppressed in favour of panel', panel.keyErrorHidden);
  check('still on init screen', panel.stillOnInit);
  check('enter button re-enabled after failure', panel.enterEnabled);

  await page.screenshot(path.join(SHOTS, 'ios-blocked-diagnosis.png'));

  // Retry must re-attempt the request rather than stay stuck.
  const before = blocked;
  await page.click('#net-help-retry');
  await page.waitFor('!document.querySelector("#net-help").hidden', 20000);
  await sleep(400);
  check('retry issues another request', blocked > before, `${before} -> ${blocked}`);

  // The preview escape hatch must reach the main screen and refuse to answer.
  await page.click('#net-help-bypass');
  await page.waitFor('!document.querySelector("#app-screen").hidden', 8000);
  check('preview opens the interface', await page.visible('#app-screen'));

  await page.setValue('#question', '测试预览模式');
  await page.click('#send-button');
  await sleep(700);
  const preview = await page.evaluate(`(() => ({
    toast: (document.querySelector('#toast-message').textContent || ''),
    cards: document.querySelectorAll('.answer-card').length,
    backOnInit: !document.querySelector('#init-screen').hidden,
  }))()`);
  check('preview refuses to call the API', preview.cards === 0, `cards=${preview.cards}`);
  check('preview explains the refusal', /API Key|预览|重新/.test(preview.toast), preview.toast.slice(0, 40));

  await page.screenshot(path.join(SHOTS, 'ios-blocked-preview.png'));
  await page.close();
} catch (error) {
  console.error('IOS DIAGNOSIS TEST ERROR:', error.message);
  results.push({ name: 'ios diagnosis run', passed: false, detail: error.message });
  if (page) { try { await page.close(); } catch { /* ignore */ } }
}

const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} iOS-blocked checks passed`);
if (failed.length) process.exitCode = 1;
