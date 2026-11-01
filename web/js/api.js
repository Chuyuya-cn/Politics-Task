import { APP_CONFIG } from '../config.js';
import { DIRECT_API, ENDPOINTS, STANDALONE } from './runtime.js';

export class ApiError extends Error {
  constructor(message, { status = 0, code = '', retryable = false, kind = '', detail = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.kind = kind;
    this.detail = detail;
  }
}

// In single-file mode the browser talks to DeepSeek directly, so the provider's
// English error text reaches the user. Translate the common cases first.
function translateProviderMessage(message) {
  const text = String(message || '');
  if (/authentication|invalid.*api key|api key.*invalid/i.test(text)) return 'API Key 无效，请检查后重试。';
  if (/insufficient|balance|quota/i.test(text)) return 'DeepSeek 账户余额不足，请充值后重试。';
  if (/rate limit|too many requests/i.test(text)) return '请求过于频繁，请稍后重试。';
  if (/timeout|timed out/i.test(text)) return '请求超时，请检查网络后重试。';
  if (/model.*not found|invalid model/i.test(text)) return '模型不可用，请检查配置。';
  return text;
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: text.slice(0, 300) } };
  }
}

function errorFromResponse(response, payload) {
  const raw = payload?.error?.message || payload?.message || '';
  const message = (raw && (DIRECT_API ? translateProviderMessage(raw) : raw))
    || (response.status === 401 ? 'API Key 无效，请检查后重试。' : '')
    || (response.status === 402 ? 'DeepSeek 账户余额不足，请充值后重试。' : '')
    || (response.status === 429 ? '请求过于频繁，请稍后重试。' : '')
    || `请求失败（HTTP ${response.status}）`;
  const code = payload?.error?.code || payload?.error?.type || '';
  return new ApiError(message, {
    status: response.status,
    code,
    retryable: response.status === 429 || response.status >= 500 || response.status === 0,
  });
}

function withTimeout(controller, timeoutMs) {
  let timer = null;
  return {
    arm() {
      timer = window.setTimeout(() => controller.abort('timeout'), timeoutMs);
    },
    clear() {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    },
  };
}

export async function validateKey(apiKey) {
  const controller = new AbortController();
  const timeout = withTimeout(controller, APP_CONFIG.validateTimeoutMs);
  timeout.arm();
  try {
    const response = await fetch(ENDPOINTS.validate, {
      method: ENDPOINTS.validateMethod,
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: controller.signal,
      cache: 'no-store',
    });
    const payload = await readJsonResponse(response);
    if (!response.ok) throw errorFromResponse(response, payload);
    return payload;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error?.name === 'AbortError') {
      throw new ApiError('验证超时，请检查网络后重试。', { status: 0, retryable: true, kind: 'timeout' });
    }
    // A rejected fetch (TypeError) here means the request never left the
    // browser: blocked scheme, blocked origin, DNS failure or offline.
    throw new ApiError(networkErrorMessage(), {
      status: 0,
      retryable: false,
      kind: 'network',
      detail: describeFetchError(error),
    });
  } finally {
    timeout.clear();
  }
}

// Turn the browser's opaque fetch failure into something actionable. Chrome
// reports a blocked CORS request as "Failed to fetch"; Safari as "Load failed".
function describeFetchError(error) {
  const text = String(error?.message || error || '');
  if (!text) return '';
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

// file:// pages have an opaque origin. Some mobile browsers (notably iOS Safari)
// block cross-origin fetch from them entirely, so the failure must explain the
// fix instead of looking like a network outage.
function networkErrorMessage() {
  if (!DIRECT_API) return '无法连接到本机服务，请确认启动器仍在运行。';
  if (window.location.protocol === 'file:') {
    return '当前浏览器阻止了本地文件联网。请改用「局域网模式」打开，或换用 Chrome / Edge 打开该文件。';
  }
  return '无法连接 DeepSeek，请检查网络后重试。';
}

export { networkErrorMessage };

export async function searchWeb(apiKey, query, oriQuestion = '') {
  const controller = new AbortController();
  const timeout = withTimeout(controller, APP_CONFIG.searchTimeoutMs);
  timeout.arm();
  try {
    const response = await fetch(ENDPOINTS.search, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        query: query.slice(0, 128),
        ori_question: oriQuestion.slice(0, 128),
        count: APP_CONFIG.searchResultCount,
        need_content: false,
      }),
      signal: controller.signal,
      cache: 'no-store',
    });
    const payload = await readJsonResponse(response);
    if (!response.ok) throw errorFromResponse(response, payload);
    return Array.isArray(payload?.results) ? payload.results : [];
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error?.name === 'AbortError') {
      throw new ApiError('联网检索超时。', { status: 0, retryable: true });
    }
    throw new ApiError('联网检索失败，请检查网络。', { status: 0 });
  } finally {
    timeout.clear();
  }
}

/**
 * Streams a chat completion. The callback receives parsed SSE events.
 * Returns the final assistant text and reasoning text.
 */
export async function streamChat(apiKey, messages, { signal, onDelta, onReasoning, onDone } = {}) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  const body = {
    model: APP_CONFIG.model,
    messages,
    stream: true,
    stream_options: { include_usage: false },
    thinking: { type: 'enabled' },
    reasoning_effort: APP_CONFIG.reasoningEffort,
    max_tokens: APP_CONFIG.maxOutputTokens,
  };

  let response;
  try {
    response = await fetch(ENDPOINTS.chat, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
      cache: 'no-store',
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new ApiError(networkErrorMessage(), { status: 0 });
  }

  if (!response.ok) {
    const payload = await readJsonResponse(response);
    throw errorFromResponse(response, payload);
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    // A compatible gateway can return a normal JSON completion. Handle it so
    // the UI still works if streaming is unavailable.
    const payload = await readJsonResponse(response);
    const text = payload?.choices?.[0]?.message?.content || '';
    if (text) onDelta?.(text, text);
    onDone?.();
    return { content: text, reasoning: payload?.choices?.[0]?.message?.reasoning_content || '' };
  }

  if (!response.body) throw new ApiError('服务器没有返回可读取的回答流。', { status: 0 });

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let content = '';
  let reasoning = '';
  let finished = false;

  const handleEvent = (data) => {
    if (data === '[DONE]') {
      finished = true;
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (parsed?.error) {
      throw new ApiError(parsed.error.message || '生成回答时出错。', {
        status: 0,
        code: parsed.error.code || '',
      });
    }
    const choice = parsed?.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      reasoning += delta.reasoning_content;
      onReasoning?.(delta.reasoning_content);
    }
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      onDelta?.(delta.content, content);
    }
  };

  try {
    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
        buffer = buffer.slice(newlineIndex + 1);
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trimStart();
        if (!data) continue;
        handleEvent(data);
        if (finished) break;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      for (const raw of buffer.split('\n')) {
        const line = raw.replace(/\r$/, '');
        if (line.startsWith('data:')) {
          const data = line.slice(5).trimStart();
          if (data) handleEvent(data);
        }
      }
    }
  } catch (error) {
    if (error?.name === 'AbortError' || error instanceof ApiError) throw error;
    throw new ApiError('回答流中断，请重试。', { status: 0, retryable: true });
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }

  onDone?.({ content, reasoning });
  return { content, reasoning };
}
