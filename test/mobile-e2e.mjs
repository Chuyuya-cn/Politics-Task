import { openTarget } from './cdp.mjs';
import { mkdirSync } from 'node:fs';

const SHOTS = 'screenshots/mobile';
mkdirSync(SHOTS, { recursive: true });
const results = [];
function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEVICES = [
  { name: 'android-pixel', width: 412, height: 915, scale: 2.6, mobile: true, ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36' },
  { name: 'ios-iphone14', width: 390, height: 844, scale: 3, mobile: true, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' },
  { name: 'harmonyos', width: 360, height: 780, scale: 3, mobile: true, ua: 'Mozilla/5.0 (Linux; Android 12; HarmonyOS; NOH-AN00) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36' },
];

const APP = process.env.APP_BASE || 'http://127.0.0.1:5199/';

for (const device of DEVICES) {
  let page;
  try {
    page = await openTarget(`${APP}?device=${device.name}`, {
      port: 9223,
      viewport: { width: device.width, height: device.height },
    });
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: device.width,
      height: device.height,
      deviceScaleFactor: device.scale,
      mobile: device.mobile,
    });
    await page.send('Emulation.setUserAgentOverride', { userAgent: device.ua });
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await page.send('Page.reload', { ignoreCache: false });
    await page.waitFor('document.querySelector("#init-screen")', 12000);
    await sleep(800);

    const init = await page.evaluate(`(() => {
      const input = document.querySelector('#api-key');
      const btn = document.querySelector('#enter-button');
      const wrap = document.querySelector('.init-wrap').getBoundingClientRect();
      return {
        fontPx: parseFloat(getComputedStyle(input).fontSize),
        btnH: Math.round(btn.getBoundingClientRect().height),
        overflowX: document.documentElement.scrollWidth - innerWidth,
        wrapTop: Math.round(wrap.top),
        wrapBottom: Math.round(wrap.bottom),
        vh: innerHeight,
        appHeightVar: getComputedStyle(document.documentElement).getPropertyValue('--app-height').trim(),
        manifest: document.querySelector('link[rel=manifest]')?.getAttribute('href'),
        appleIcon: document.querySelector('link[rel=apple-touch-icon]')?.getAttribute('href'),
      };
    })()`);

    check(`${device.name}: key input >= 16px (no iOS zoom)`, init.fontPx >= 16, `${init.fontPx}px`);
    check(`${device.name}: enter button >= 44px`, init.btnH >= 44, `${init.btnH}px`);
    check(`${device.name}: no horizontal overflow`, init.overflowX <= 1, `overflow=${init.overflowX}`);
    check(`${device.name}: init card fits viewport`, init.wrapTop >= 0 && init.wrapBottom <= init.vh + 1, `wrap ${init.wrapTop}-${init.wrapBottom} vh=${init.vh}`);
    check(`${device.name}: --app-height set`, /px$/.test(init.appHeightVar), init.appHeightVar);
    check(`${device.name}: manifest linked`, init.manifest === 'manifest.webmanifest', String(init.manifest));
    check(`${device.name}: apple-touch-icon linked`, init.appleIcon === 'assets/icon-180.png', String(init.appleIcon));

    await page.screenshot(`${SHOTS}/${device.name}-init.png`);

    // Enter the app.
    await page.setValue('#api-key', 'sk-mock-valid-key-1234567890abcdef');
    await page.click('#enter-button');
    await page.waitFor('!document.querySelector("#app-screen").hidden', 10000);
    await sleep(600);

    const main = await page.evaluate(`(() => {
      const ta = document.querySelector('#question');
      const send = document.querySelector('#send-button');
      const tool = document.querySelector('#search-toggle');
      const composer = document.querySelector('#composer-wrap').getBoundingClientRect();
      return {
        taFont: parseFloat(getComputedStyle(ta).fontSize),
        sendW: Math.round(send.getBoundingClientRect().width),
        toolH: Math.round(tool.getBoundingClientRect().height),
        composerBottom: Math.round(composer.bottom),
        vh: innerHeight,
        overflowX: document.documentElement.scrollWidth - innerWidth,
      };
    })()`);
    check(`${device.name}: textarea >= 16px`, main.taFont >= 16, `${main.taFont}px`);
    check(`${device.name}: send button >= 44px`, main.sendW >= 44, `${main.sendW}px`);
    check(`${device.name}: tool pill >= 40px`, main.toolH >= 40, `${main.toolH}px`);
    check(`${device.name}: composer within viewport`, main.composerBottom <= main.vh + 1, `bottom=${main.composerBottom} vh=${main.vh}`);
    check(`${device.name}: app no horizontal overflow`, main.overflowX <= 1, `overflow=${main.overflowX}`);

    await page.screenshot(`${SHOTS}/${device.name}-main.png`);

    // Ask and wait for the answer.
    await page.setValue('#question', '如何理解人民代表大会制度？');
    await page.click('#send-button');
    await page.waitFor(`(() => {
      const card = document.querySelector('.answer-card');
      return card && !card.classList.contains('is-pending')
        && (card.querySelector('.answer-markdown')?.innerText || '').length > 40;
    })()`, 30000);
    await sleep(500);
    const answer = await page.evaluate(`(() => {
      const card = document.querySelector('.answer-card').getBoundingClientRect();
      const composer = document.querySelector('#composer-wrap').getBoundingClientRect();
      return {
        text: document.querySelector('.answer-markdown').innerText.length,
        sources: document.querySelectorAll('.source-item').length,
        cardAboveComposer: card.bottom <= composer.top + 8,
        overflowX: document.documentElement.scrollWidth - innerWidth,
      };
    })()`);
    check(`${device.name}: answer rendered`, answer.text > 80, `${answer.text} chars`);
    check(`${device.name}: sources shown`, answer.sources === 3, `${answer.sources}`);
    check(`${device.name}: answer sits above composer`, answer.cardAboveComposer);
    check(`${device.name}: answer has no horizontal overflow`, answer.overflowX <= 1, `overflow=${answer.overflowX}`);
    await page.screenshot(`${SHOTS}/${device.name}-answer.png`);

    // Soft-keyboard simulation: shrink the visual viewport and confirm the
    // composer stays reachable (this is what the JS --app-height mirror does).
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: device.width,
      height: Math.round(device.height * 0.62),
      deviceScaleFactor: device.scale,
      mobile: device.mobile,
    });
    await sleep(500);
    const keyboard = await page.evaluate(`(() => {
      const composer = document.querySelector('#composer-wrap').getBoundingClientRect();
      const send = document.querySelector('#send-button').getBoundingClientRect();
      return {
        composerBottom: Math.round(composer.bottom),
        vh: innerHeight,
        sendVisible: send.top >= 0 && send.bottom <= innerHeight + 1,
        appHeight: getComputedStyle(document.documentElement).getPropertyValue('--app-height').trim(),
      };
    })()`);
    check(`${device.name}: composer visible with keyboard open`, keyboard.composerBottom <= keyboard.vh + 1, `bottom=${keyboard.composerBottom} vh=${keyboard.vh}`);
    check(`${device.name}: send button reachable with keyboard`, keyboard.sendVisible);
    await page.screenshot(`${SHOTS}/${device.name}-keyboard.png`);

    // Restore metrics before closing.
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: device.width,
      height: device.height,
      deviceScaleFactor: device.scale,
      mobile: device.mobile,
    });
  } catch (error) {
    console.error(`MOBILE ${device.name} ERROR:`, error.message);
    results.push({ name: `${device.name}: run`, passed: false, detail: error.message });
  } finally {
    if (page) { try { await page.close(); } catch { /* ignore */ } }
  }
}

const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} mobile checks passed`);
if (failed.length) process.exitCode = 1;
