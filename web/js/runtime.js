// Runtime mode abstraction. The same front-end runs in three shapes:
//
//   1. "proxy"      — served by the Go launcher. API calls go to /local-api/*,
//                     content folders are read from disk on every refresh.
//   2. "standalone" — one self-contained .html opened from file://. Content is
//                     embedded at build time, API calls go straight to DeepSeek.
//   3. "static"     — HTTPS static hosting (Caddy/Nginx/GitHub Pages...).
//                     Content comes from content.json plus plain files, API
//                     calls go straight to DeepSeek.
//
// Build scripts inject window.__PQ_STANDALONE__ or window.__PQ_STATIC_HOST__
// before this module runs.

const mode = window.__PQ_STANDALONE__
  ? 'standalone'
  : window.__PQ_STATIC_HOST__
    ? 'static'
    : 'proxy';

export const MODE = mode;
export const STANDALONE = mode === 'standalone';
export const STATIC_HOST = mode === 'static';
// Both non-proxy modes talk to DeepSeek directly, so there is no local server to
// validate keys or to relay search/chat.
export const DIRECT_API = STANDALONE || STATIC_HOST;

const DIRECT_BASE = 'https://api.deepseek.com';

export const ENDPOINTS = DIRECT_API
  ? {
    validate: `${DIRECT_BASE}/models`,
    search: `${DIRECT_BASE}/v1/tools/search`,
    chat: `${DIRECT_BASE}/chat/completions`,
    validateMethod: 'GET',
  }
  : {
    validate: '/local-api/validate',
    search: '/local-api/search',
    chat: '/local-api/chat',
    validateMethod: 'POST',
  };

// In standalone mode the manifest and prompt bodies are embedded at build time.
export function embeddedManifest() {
  return window.__PQ_CONTENT__?.manifest || null;
}

export function embeddedPrompt(name) {
  const prompts = window.__PQ_CONTENT__?.prompts || {};
  return Object.prototype.hasOwnProperty.call(prompts, name) ? prompts[name] : null;
}

export function embeddedBackground() {
  return window.__PQ_CONTENT__?.background || null;
}

// Where the content manifest lives in each non-embedded mode.
export function manifestURL() {
  return STATIC_HOST ? 'content.json' : '/local-api/content';
}

// Human-facing description of the current runtime, used in settings.
export function runtimeLabel() {
  if (STANDALONE) return '单文件版';
  if (STATIC_HOST) return '在线版';
  return '本机版';
}
