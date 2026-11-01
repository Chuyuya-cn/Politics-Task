// A small local mock of the DeepSeek API surface used by the app.
// Used only for automated UI tests and screenshots; the real app points at
// https://api.deepseek.com by default.
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 9017);

const ANSWER = [
  '人民代表大会制度是我国的根本政治制度，也是人民当家作主的根本途径。\n\n',
  '从制度定位看，它居于我国政治制度体系的核心地位，体现为三个维度：\n\n',
  '1. **权力来源**：国家的一切权力属于人民，人民通过直接或间接选举产生各级人大代表，组成国家权力机关。[1]\n',
  '2. **组织原则**：实行民主集中制，在国家机构的产生和运行中，把广泛民主与正确集中结合起来。[2]\n',
  '3. **与其他制度的关系**：人民代表大会制度是“根本”，其他制度（如中国共产党领导的多党合作和政治协商制度、民族区域自治制度、基层群众自治制度）都是在它的框架内运行的重要制度安排。[3]\n\n',
  '需要区分的是：人民代表大会制度是我国的**政体**，而人民民主专政的国体决定政体。学习中常见的误解是把“人大”等同于“人大常委会”，或将根本政治制度与基本政治制度混为一谈。\n\n',
  '> 简记：根本政治制度回答“国家权力如何组织、由谁行使”；基本政治制度回答“各领域民主如何具体展开”。\n',
].join('');

const SOURCES = {
  results: [
    {
      title: '中华人民共和国全国人民代表大会组织法',
      url: 'https://www.gov.cn/xinwen/2021-03/12/content_5592295.htm',
      snippet: '全国人民代表大会是最高国家权力机关。',
      summary: '全国人民代表大会是最高国家权力机关，它的常设机关是全国人民代表大会常务委员会。',
      site_name: '中国政府网',
      date: '2021-03-12T00:00:00+00:00',
      authority: 4,
    },
    {
      title: '中华人民共和国宪法（节选）',
      url: 'https://www.gov.cn/guoqing/2018-03/22/content_5276318.htm',
      snippet: '中华人民共和国的一切权力属于人民。',
      summary: '中华人民共和国的一切权力属于人民。人民行使国家权力的机关是全国人民代表大会和地方各级人民代表大会。',
      site_name: '中国政府网',
      date: '2018-03-22T00:00:00+00:00',
      authority: 4,
    },
    {
      title: '中国人大网 · 人民代表大会制度专题',
      url: 'http://www.npc.gov.cn/',
      snippet: '人民代表大会制度是我国的根本政治制度。',
      summary: '人民代表大会制度是我国的根本政治制度，是实现全过程人民民主的重要制度载体。',
      site_name: '中国人大网',
      date: '2020-09-15T00:00:00+00:00',
      authority: 4,
    },
  ],
};

let lastChatRequest = null;
let lastSearchRequest = null;

const server = http.createServer((req, res) => {
  const auth = req.headers.authorization || '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const validKey = key.startsWith('sk-mock-valid-');

  if (req.method === 'GET' && req.url === '/debug/last') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ chat: lastChatRequest, search: lastSearchRequest }));
    return;
  }

  if (req.method === 'GET' && req.url === '/models') {
    if (!validKey) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Authentication Fails', type: 'authentication_error', code: 'invalid_request_error' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-flash', object: 'model' }] }));
    return;
  }

  if (req.method === 'POST' && req.url === '/v1/tools/search') {
    if (!validKey) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Authentication Fails', type: 'authentication_error', code: 'invalid_request_error' } }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (body.includes('FAIL_SEARCH')) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'mock search failure', type: 'server_error', code: 'server_error' } }));
        return;
      }
      try { lastSearchRequest = JSON.parse(body); } catch { lastSearchRequest = { raw: body }; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(SOURCES));
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/chat/completions') {
    if (!validKey) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Authentication Fails', type: 'authentication_error', code: 'invalid_request_error' } }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      // Echo back what the UI sent so tests can verify the request shape.
      let parsedRequest = {};
      try { parsedRequest = JSON.parse(body); } catch { /* ignore */ }
      lastChatRequest = parsedRequest;
      const lastMessage = [...(parsedRequest.messages || [])].reverse().find((m) => m.role === 'user');
      const prompt = String(lastMessage?.content || '');
      if (prompt.includes('FAIL_CHAT')) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'mock chat failure', type: 'server_error', code: 'server_error' } }));
        return;
      }
      if (process.env.MOCK_ECHO === '1') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ request: parsedRequest, answer: ANSWER }));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'close',
      });
      res.flushHeaders?.();
      // A short reasoning preamble, then the content in a few chunks.
      const emit = (delta) => {
        res.write(`data: ${JSON.stringify({ choices: [{ delta, index: 0 }] })}\n\n`);
      };
      emit({ reasoning_content: '先区分政体与根本政治制度的概念。' });
      const chunks = ANSWER.match(/.{1,48}/g) || [];
      const delayMs = prompt.includes('SLOW_CHAT') ? 260 : 14;
      let i = 0;
      const timer = setInterval(() => {
        if (res.writableEnded || res.destroyed) {
          clearInterval(timer);
          return;
        }
        if (i < chunks.length) {
          emit({ content: chunks[i] });
          i += 1;
        } else {
          clearInterval(timer);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        }
      }, delayMs);
      res.on('error', () => clearInterval(timer));
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'not found', type: 'invalid_request_error', code: 'invalid_request_error' } }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock deepseek listening on http://127.0.0.1:${PORT}`);
});
