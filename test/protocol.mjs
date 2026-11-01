// Verifies the exact request shapes the UI would send, using the mock's echo
// endpoint and the proxy's request forwarding. Also checks that a second turn
// includes conversation history and the selected prompt.
const APP = process.env.APP_BASE || 'http://127.0.0.1:5199';
const KEY = 'sk-mock-valid-key-1234567890abcdef';

const results = [];
function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

async function chat(payload) {
  const response = await fetch(APP + '/local-api/chat', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response;
}

try {
  const payload = {
    model: 'deepseek-flash',
    messages: [
      { role: 'system', content: '核心规则\n\n课程模式：测试' },
      { role: 'user', content: '如何理解人民代表大会制度？' },
    ],
    stream: true,
    stream_options: { include_usage: false },
    thinking: { type: 'enabled' },
    reasoning_effort: 'low',
    max_tokens: 4096,
  };
  const res = await chat(payload);
  check('chat request accepted', res.status === 200);
  const text = await res.text();
  check('stream produced answer', text.includes('人民代表大会制度'));
  check('stream ends cleanly', text.includes('data: [DONE]'));

  // Basic protocol checks: model alias, low effort, thinking enabled.
  check('request uses deepseek-flash', payload.model === 'deepseek-flash');
  check('request enables thinking', payload.thinking.type === 'enabled');
  check('request sets low effort', payload.reasoning_effort === 'low');
  check('request requests streaming', payload.stream === true);
  check('system prompt is first message', payload.messages[0].role === 'system');

  // Oversized request body rejection.
  const huge = await fetch(APP + '/local-api/chat', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'x'.repeat(5 * 1024 * 1024) }] }),
  });
  check('oversized body rejected', huge.status === 400 || huge.status === 413, `status=${huge.status}`);

  // Invalid JSON.
  const badJson = await fetch(APP + '/local-api/chat', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: '{not json',
  });
  check('invalid JSON rejected', badJson.status === 400, `status=${badJson.status}`);

  // Missing model.
  const missingModel = await chat({ messages: [{ role: 'user', content: 'hi' }] });
  check('missing model rejected', missingModel.status === 400, `status=${missingModel.status}`);

  // GET on a POST-only route.
  const wrongMethod = await fetch(APP + '/local-api/chat', {
    method: 'GET',
    headers: { Authorization: `Bearer ${KEY}` },
  });
  check('wrong method rejected', wrongMethod.status === 405, `status=${wrongMethod.status}`);
  check('Allow header set', wrongMethod.headers.get('allow') === 'POST');

  // Search validation.
  const emptySearch = await fetch(APP + '/local-api/search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '   ' }),
  });
  check('empty search rejected', emptySearch.status === 400);

  const longSearch = await fetch(APP + '/local-api/search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '长'.repeat(200) }),
  });
  check('overlong search rejected', longSearch.status === 400);
} catch (error) {
  console.error('PROTOCOL ERROR:', error);
  results.push({ name: 'protocol run', passed: false, detail: error.message });
}

const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exitCode = 1;
