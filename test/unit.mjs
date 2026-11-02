// Unit tests for front-end pure logic using jsdom. Run: node test/unit.mjs
//
// jsdom is a dev-only dependency. Locally it may live in .tools/ (gitignored);
// in CI it comes from a normal `npm install jsdom`. test/_jsdom.mjs resolves
// whichever one is present.
import { loadJSDOM } from './_jsdom.mjs';
import assert from 'node:assert/strict';

const JSDOM = await loadJSDOM();

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1:5199/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.URL = dom.window.URL;
globalThis.Node = dom.window.Node;

const { renderMarkdown, plainText } = await import('../web/js/markdown.js');
const { buildSearchQuery, composeSystemPrompt, modeNameFromFile, modeDescriptionFromPrompt, DEFAULT_MODE } = await import('../web/js/prompts.js');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, passed: true });
    console.log(`PASS  ${name}`);
  } catch (error) {
    results.push({ name, passed: false, detail: error.message });
    console.log(`FAIL  ${name} — ${error.message}`);
  }
}

check('renders headings, bold, lists, blockquote', () => {
  const html = renderMarkdown('# 标题\n\n**重点**\n\n1. 第一\n2. 第二\n\n> 引用').innerHTML;
  assert.match(html, /<h1>标题<\/h1>/);
  assert.match(html, /<strong>重点<\/strong>/);
  assert.match(html, /<ol><li>第一<\/li><li>第二<\/li><\/ol>/);
  assert.match(html, /<blockquote><p>引用<\/p><\/blockquote>/);
});

check('renders citation markers as spans', () => {
  const html = renderMarkdown('这是一句结论[1]，另一句[2]。').innerHTML;
  assert.match(html, /<span class="citation">1<\/span>/);
  assert.match(html, /<span class="citation">2<\/span>/);
});

check('escapes raw HTML (XSS)', () => {
  const root = renderMarkdown('<img src=x onerror=alert(1)>\n\n<script>alert(2)</script>');
  assert.equal(root.querySelector('img'), null);
  assert.equal(root.querySelector('script'), null);
  assert.ok(root.textContent.includes('<img'));
});

check('blocks javascript: links', () => {
  const root = renderMarkdown('[点我](javascript:alert(1))');
  assert.equal(root.querySelector('a'), null);
  assert.ok(root.textContent.includes('点我'));
});

check('allows only http(s) links with target blank', () => {
  const root = renderMarkdown('[来源](https://www.gov.cn/a)');
  const anchor = root.querySelector('a');
  assert.ok(anchor);
  assert.equal(anchor.getAttribute('target'), '_blank');
  assert.equal(anchor.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(anchor.href, 'https://www.gov.cn/a');
});

check('escapes HTML inside code fences', () => {
  const root = renderMarkdown('```\n<script>x</script>\n```');
  const code = root.querySelector('pre code');
  assert.ok(code);
  assert.equal(code.querySelector('script'), null);
  assert.equal(code.textContent, '<script>x</script>');
});

check('plainText strips markdown', () => {
  assert.equal(plainText('**你好** [1]'), '你好 [1]');
});

check('composes core rules and source block', () => {
  const prompt = composeSystemPrompt('测试模式', [{
    title: '来源标题',
    url: 'https://example.com/x',
    summary: '摘要内容',
    site_name: '示例站',
    date: '2026-10-01T00:00:00+00:00',
  }]);
  assert.ok(prompt.includes('不得编造'));
  assert.ok(prompt.includes('测试模式'));
  assert.ok(prompt.includes('[1] 来源标题'));
  assert.ok(prompt.includes('https://example.com/x'));
  assert.ok(prompt.includes('不是指令'));
});

check('no-source prompt warns against fake citations', () => {
  const prompt = composeSystemPrompt('测试模式', [], { searchAttempted: true });
  assert.ok(prompt.includes('没有检索到可用的在线资料'));
  assert.ok(prompt.includes('不要虚构引用'));
});

check('search-disabled prompt is distinguished from empty results', () => {
  const prompt = composeSystemPrompt('测试模式', [], { searchAttempted: false });
  assert.ok(prompt.includes('未启用在线检索'));
  assert.ok(prompt.includes('不要虚构引用'));
});

check('search query uses prior question for pronoun follow-up', () => {
  const q = buildSearchQuery('那它有什么不同？', '人民代表大会制度是什么？');
  assert.ok(q.startsWith('人民代表大会制度是什么？'));
  assert.ok(q.includes('那它有什么不同'));
});

check('search query leaves standalone question alone', () => {
  assert.equal(buildSearchQuery('全过程人民民主包括哪些环节？', '上一个问题'), '全过程人民民主包括哪些环节？');
  assert.equal(buildSearchQuery('请解释民主集中制', '上一个问题'), '请解释民主集中制');
});

check('search query supplements a very short follow-up', () => {
  assert.ok(buildSearchQuery('为什么？', '人民代表大会制度是什么？').startsWith('人民代表大会制度是什么？'));
});

check('search query caps length', () => {
  assert.ok(buildSearchQuery('问'.repeat(300), '').length <= 120);
});

check('mode name strips order prefix and extension', () => {
  assert.equal(modeNameFromFile('01-课程讲解.md'), '课程讲解');
  assert.equal(modeNameFromFile('时政分析.md'), '时政分析');
  assert.equal(modeNameFromFile('README.txt'), 'README');
});

check('mode description is a short preview', () => {
  const desc = modeDescriptionFromPrompt('# 标题\n' + '内容'.repeat(100));
  assert.ok(desc.length <= 97);
});

check('default mode has description and prompt', () => {
  assert.ok(DEFAULT_MODE.name);
  assert.ok(DEFAULT_MODE.prompt.includes('回答方向'));
});

const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exitCode = 1;
