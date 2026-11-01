// Real-API smoke test. This is the only test that contacts DeepSeek with a
// live key. It always reads the key from the environment; the key is never
// written to disk and never printed.
//
// Usage (PowerShell):
//   $env:DEEPSEEK_API_KEY = 'sk-...'
//   .\政治问答系统.exe -no-open -port 5199   # in another terminal
//   node test/live-smoke.mjs
//
// This makes one Search request and one small Chat request, both billed to the
// account. Set SKIP_SEARCH=1 to skip the Search request.
const APP = process.env.APP_BASE || 'http://127.0.0.1:5199';
const KEY = (process.env.DEEPSEEK_API_KEY || '').trim();

if (!KEY) {
  console.error('DEEPSEEK_API_KEY is not set. Example:');
  console.error("  $env:DEEPSEEK_API_KEY = 'sk-...'");
  console.error('  node test/live-smoke.mjs');
  process.exit(2);
}
if (!KEY.startsWith('sk-') || KEY.length < 8) {
  console.error('DEEPSEEK_API_KEY does not look like a DeepSeek key.');
  process.exit(2);
}

const masked = KEY.slice(0, 5) + '***' + KEY.slice(-4);
const results = [];
function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

async function post(path, payload) {
  return fetch(APP + path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

function parseSSE(text) {
  const events = [];
  for (const block of text.split(/\n\n/)) {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data) events.push(data);
    }
  }
  return events;
}

try {
  console.log(`Testing ${APP} with key ${masked}`);
  const health = await fetch(APP + '/local-api/health');
  check('local launcher reachable', health.ok);
  if (!health.ok) throw new Error('local launcher is not running');

  const validation = await post('/local-api/validate', undefined);
  if (!validation.ok) {
    const body = await validation.text();
    check('live key accepted', false, `HTTP ${validation.status}: ${body.slice(0, 200)}`);
    throw new Error('key validation failed');
  }
  check('live key accepted', true);

  if (process.env.SKIP_SEARCH !== '1') {
    const search = await post('/local-api/search', {
      query: '人民代表大会制度',
      ori_question: '人民代表大会制度在我国政治制度体系中的地位',
      count: 3,
      need_content: false,
    });
    if (!search.ok) {
      const body = await search.text();
      check('live search succeeded', false, `HTTP ${search.status}: ${body.slice(0, 200)}`);
    } else {
      const payload = await search.json();
      const count = Array.isArray(payload.results) ? payload.results.length : 0;
      check('live search succeeded', count > 0, `${count} results`);
      if (count > 0) {
        check('live search returned URLs', payload.results.every((r) => typeof r.url === 'string' && r.url.startsWith('http')));
      }
    }
  } else {
    console.log('SKIP_SEARCH=1: search call skipped.');
  }

  const chat = await post('/local-api/chat', {
    model: 'deepseek-flash',
    messages: [
      { role: 'system', content: '你是政治课程助教。请用一句话回答，并说明这是测试。' },
      { role: 'user', content: '请用一句话说明我国的根本政治制度是什么。' },
    ],
    stream: true,
    thinking: { type: 'enabled' },
    reasoning_effort: 'low',
    max_tokens: 256,
  });
  check('live chat accepted', chat.ok, `HTTP ${chat.status}`);

  if (chat.ok) {
    const raw = await chat.text();
    const events = parseSSE(raw);
    const deltas = events.filter((event) => event !== '[DONE]').map((event) => JSON.parse(event));
    const content = deltas.map((delta) => delta.choices?.[0]?.delta?.content || '').join('');
    const reasoning = deltas.map((delta) => delta.choices?.[0]?.delta?.reasoning_content || '').join('');
    check('live stream terminated', events.includes('[DONE]'));
    check('live reasoning stream present', reasoning.length > 0, `${reasoning.length} chars`);
    check('live answer non-empty', content.trim().length > 0, `${content.length} chars`);
    console.log('\n--- live answer ---');
    console.log(content.trim());
    console.log('--- end ---\n');
  }
} catch (error) {
  console.error('LIVE SMOKE ERROR:', error.message);
  results.push({ name: 'live smoke run', passed: false, detail: error.message });
}

const failed = results.filter((result) => !result.passed);
console.log(`\n${results.length - failed.length}/${results.length} live checks passed`);
if (failed.length) process.exitCode = 1;
