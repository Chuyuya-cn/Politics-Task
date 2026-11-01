// Browser-free integration test for the full browser -> local proxy -> upstream
// streaming path. Servers must already be running (see test/run-e2e.ps1).
// This exercises exactly the HTTP surface the front-end uses, without needing
// to automate a browser (which the DSH sandbox blocks).
const APP = process.env.APP_BASE || 'http://127.0.0.1:5199';
const KEY = 'sk-mock-valid-key-1234567890abcdef';
const BAD_KEY = 'sk-invalid-key-1234567890abcdef';

const results = [];
function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

async function post(path, body, key) {
  return fetch(APP + path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
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
  // Content manifest & prompt files.
  const manifestRes = await fetch(APP + '/local-api/content');
  const manifest = await manifestRes.json();
  check('manifest 200', manifestRes.status === 200);
  check('background listed', manifest.backgrounds.length >= 1);
  check('four prompt modes', manifest.prompts.length === 4, `found ${manifest.prompts.length}`);
  check('README excluded', !manifest.prompts.some((p) => p.name.toUpperCase().startsWith('README')));
  const promptRes = await fetch(APP + manifest.prompts[0].url);
  const promptText = await promptRes.text();
  check('prompt file served', promptRes.ok && promptText.includes('回答方向'));
  const bgRes = await fetch(APP + manifest.backgrounds[0].url);
  check('background served', bgRes.ok && (bgRes.headers.get('content-type') || '').includes('svg'));

  // Key validation: bad then good.
  const badValidate = await post('/local-api/validate', undefined, BAD_KEY);
  const badBody = await badValidate.json();
  check('invalid key -> 401', badValidate.status === 401);
  check('invalid key error is Chinese', badBody.error.message.includes('API Key 无效'), badBody.error.message);
  check('invalid key error does not echo key', !JSON.stringify(badBody).includes('sk-'));

  const goodValidate = await post('/local-api/validate', undefined, KEY);
  check('valid key -> 200', goodValidate.status === 200);

  // Search.
  const searchRes = await post('/local-api/search', {
    query: '人民代表大会制度',
    ori_question: '如何理解人民代表大会制度？',
    count: 5,
    need_content: false,
  }, KEY);
  const searchBody = await searchRes.json();
  check('search 200', searchRes.status === 200);
  check('search returns results', Array.isArray(searchBody.results) && searchBody.results.length === 3);
  check('search results have citations metadata', searchBody.results.every((r) => r.title && r.url));

  // Chat streaming, mirroring the browser request shape.
  const chatRes = await post('/local-api/chat', {
    model: 'deepseek-flash',
    messages: [
      { role: 'system', content: '你是政治课助教。' },
      { role: 'user', content: '如何理解人民代表大会制度？' },
    ],
    stream: true,
    thinking: { type: 'enabled' },
    reasoning_effort: 'low',
  }, KEY);
  check('chat 200', chatRes.status === 200);
  check('chat is SSE', (chatRes.headers.get('content-type') || '').includes('text/event-stream'));
  const raw = await chatRes.text();
  const events = parseSSE(raw);
  check('SSE has [DONE]', events.includes('[DONE]'));
  const deltas = events.filter((e) => e !== '[DONE]').map((e) => JSON.parse(e));
  const reasoning = deltas.map((d) => d.choices?.[0]?.delta?.reasoning_content || '').join('');
  const content = deltas.map((d) => d.choices?.[0]?.delta?.content || '').join('');
  check('reasoning stream received', reasoning.length > 0);
  check('content stream received', content.includes('人民代表大会制度'), content.slice(0, 40));
  check('answer has citation markers', /\[\d\]/.test(content));

  // Auth failure on chat is translated, not raw.
  const unauthChat = await post('/local-api/chat', { model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }] }, BAD_KEY);
  check('chat unauthorized -> 401', unauthChat.status === 401);
  const unauthBody = await unauthChat.text();
  check('chat unauthorized is Chinese', unauthBody.includes('API Key 无效'));
  check('chat unauthorized hides key', !unauthBody.includes('sk-'));

  // Local security: cross-origin API call is rejected.
  const cross = await fetch(APP + '/local-api/health', { headers: { Origin: 'https://evil.example' } });
  check('cross-origin local API rejected', cross.status === 403);

  // Traversal on content folders.
  const trav = await fetch(APP + '/backgrounds/..%2Fprompts%2F01-%E8%AF%BE%E7%A8%8B%E8%AE%B2%E8%A7%A3.md');
  check('path traversal rejected', trav.status === 404, `status=${trav.status}`);
} catch (error) {
  console.error('INTEGRATION ERROR:', error);
  results.push({ name: 'integration run', passed: false, detail: error.message });
}

const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exitCode = 1;
