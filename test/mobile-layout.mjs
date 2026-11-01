import { openTarget } from './cdp.mjs';

const page = await openTarget('http://127.0.0.1:5199/', { port: 9223, viewport: { width: 390, height: 844 } });
await page.waitFor('document.querySelector("#init-screen")', 10000);
await new Promise((resolve) => setTimeout(resolve, 900));
await page.screenshot('screenshots/07b-mobile-init.png');

const layout = await page.evaluate(`(() => {
  const wrap = document.querySelector('.init-wrap').getBoundingClientRect();
  const card = document.querySelector('.init-card').getBoundingClientRect();
  const title = document.querySelector('.init-title').getBoundingClientRect();
  const input = document.querySelector('#api-key').getBoundingClientRect();
  return {
    viewport: { w: innerWidth, h: innerHeight },
    wrap: { top: Math.round(wrap.top), bottom: Math.round(wrap.bottom), h: Math.round(wrap.height) },
    card: { top: Math.round(card.top), bottom: Math.round(card.bottom), h: Math.round(card.height) },
    title: { top: Math.round(title.top), h: Math.round(title.height) },
    input: { top: Math.round(input.top), bottom: Math.round(input.bottom) },
    scrollHeight: document.documentElement.scrollHeight,
    horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
  };
})()`);
console.log(JSON.stringify(layout, null, 2));

// Fill a key and check the mobile app state too.
await page.setValue('#api-key', 'sk-mock-valid-key-1234567890abcdef');
await page.click('#enter-button');
await page.waitFor('!document.querySelector("#app-screen").hidden', 10000);
await new Promise((resolve) => setTimeout(resolve, 700));
await page.screenshot('screenshots/07c-mobile-main.png');
const main = await page.evaluate(`(() => {
  const composer = document.querySelector('#composer-wrap').getBoundingClientRect();
  return {
    composer: { top: Math.round(composer.top), bottom: Math.round(composer.bottom) },
    viewportH: innerHeight,
    horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
  };
})()`);
console.log(JSON.stringify(main, null, 2));
await page.close();
