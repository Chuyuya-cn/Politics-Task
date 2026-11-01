import { APP_CONFIG } from '../config.js';
import { ApiError, searchWeb, streamChat, validateKey } from './api.js';
import {
  DEFAULT_MODE,
  buildSearchQuery,
  composeSystemPrompt,
  modeDescriptionFromPrompt,
  modeNameFromFile,
} from './prompts.js';
import { renderMarkdown } from './markdown.js';
import {
  STANDALONE,
  embeddedManifest,
  embeddedPrompt,
  manifestURL,
} from './runtime.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const els = {
  initScreen: $('#init-screen'),
  appScreen: $('#app-screen'),
  bootError: $('#boot-error'),
  bootErrorMessage: $('#boot-error-message'),
  bgImage: $('#bg-image'),
  keyForm: $('#key-form'),
  apiKey: $('#api-key'),
  toggleKey: $('#toggle-key'),
  enterButton: $('#enter-button'),
  keyError: $('#key-error'),
  netHelp: $('#net-help'),
  netHelpTitle: $('#net-help-title'),
  netHelpBody: $('#net-help-body'),
  netHelpDiag: $('#net-help-diag'),
  netHelpRetry: $('#net-help-retry'),
  netHelpBypass: $('#net-help-bypass'),
  answerList: $('#answer-list'),
  answerArea: $('#answer-area'),
  composerWrap: $('#composer-wrap'),
  welcome: $('#welcome'),
  askForm: $('#ask-form'),
  question: $('#question'),
  sendButton: $('#send-button'),
  stopButton: $('#stop-button'),
  charCount: $('#char-count'),
  searchToggle: $('#search-toggle'),
  modeButton: $('#mode-button'),
  modeLabel: $('#mode-label'),
  modeMenu: $('#mode-menu'),
  newChat: $('#new-chat'),
  settingsPanel: $('#settings-panel'),
  settingsBackdrop: $('#settings-backdrop'),
  openSettings: $('#open-settings'),
  closeSettings: $('#close-settings'),
  backgroundSelect: $('#background-select'),
  promptSelect: $('#prompt-select'),
  modeDescription: $('#mode-description'),
  refreshContent: $('#refresh-content'),
  searchStatus: $('#search-status'),
  buildVersion: $('#build-version'),
  hardRefresh: $('#hard-refresh'),
  backToInit: $('#back-to-init'),
  changeKey: $('#change-key'),
  toast: $('#toast'),
  toastMessage: $('#toast-message'),
  toastAction: $('#toast-action'),
  answerTemplate: $('#answer-template'),
};

const state = {
  apiKey: '',
  manifest: { backgrounds: [], prompts: [], defaultBackground: '', defaultPrompt: '' },
  modes: [],
  mode: DEFAULT_MODE,
  promptFile: '',
  selectedBackground: '',
  searchEnabled: true,
  messages: [],
  turns: [],
  current: null,
  abortController: null,
  pendingQuestion: '',
  toastTimer: null,
  isBusy: false,
  epoch: 0,
};

const systemState = {
  booted: false,
};

init();

async function init() {
  wireEvents();
  normalizeBoot();
  setupViewportHeight();
  registerServiceWorker();
  await loadContent();
  applyInitialBackground();
  autoGrowTextarea();
  updateCharCount();
  updateSearchToggle();
  if (window.location.hash === '#app') {
    // Never bypass key entry: a reloaded page has no key in memory.
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
}

// On iOS/Android/HarmonyOS the soft keyboard shrinks visualViewport without
// changing 100dvh, which pushes the composer behind the keyboard. Mirror the
// visible height into --app-height so the layout shrinks with it.
function setupViewportHeight() {
  const root = document.documentElement;
  const apply = () => {
    const height = window.visualViewport?.height || window.innerHeight;
    root.style.setProperty('--app-height', `${Math.round(height)}px`);
  };
  apply();
  window.addEventListener('resize', apply, { passive: true });
  window.visualViewport?.addEventListener('resize', apply, { passive: true });
  window.visualViewport?.addEventListener('scroll', apply, { passive: true });
  window.addEventListener('orientationchange', () => setTimeout(apply, 120), { passive: true });
}

// Offline shell caching is a bonus. It only works in a secure context, so on a
// plain http:// LAN address the registration is rejected and we ignore it.
function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

function normalizeBoot() {
  // The single-file build legitimately runs from file:// and embeds its own
  // content, so it must not be blocked by the "open me through the launcher"
  // guard. Static hosting is served over http(s) and needs no guard either.
  if (window.location.protocol === 'file:' && !STANDALONE) {
    els.bootError.hidden = false;
    els.initScreen.hidden = true;
    els.appScreen.hidden = true;
    return;
  }
  if (els.bootError) els.bootError.hidden = true;
  systemState.booted = true;
}

function wireEvents() {
  els.keyForm.addEventListener('submit', handleKeySubmit);
  els.netHelpRetry.addEventListener('click', () => {
    hideNetworkHelp();
    els.keyForm.requestSubmit();
  });
  els.netHelpBypass.addEventListener('click', () => {
    // Layout preview only: no key is stored, so every question fails visibly.
    hideNetworkHelp();
    state.apiKey = '';
    showApp();
    showToast('已进入预览模式：未连接 AI，提问不会得到回答。', 'info');
  });
  els.toggleKey.addEventListener('click', toggleKeyVisibility);
  els.apiKey.addEventListener('input', () => {
    clearKeyError();
    if (!els.netHelp.hidden) hideNetworkHelp();
  });
  els.askForm.addEventListener('submit', handleAskSubmit);
  els.question.addEventListener('input', () => {
    autoGrowTextarea();
    updateCharCount();
    updateSendState();
    closeModeMenu();
  });
  els.question.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!els.sendButton.disabled) els.askForm.requestSubmit();
    }
  });
  // Mobile browsers scroll inconsistently when the soft keyboard opens; pull the
  // composer back into view after the viewport settles.
  els.question.addEventListener('focus', () => {
    setTimeout(() => {
      if (typeof els.composerWrap?.scrollIntoView === 'function') {
        els.composerWrap.scrollIntoView({ block: 'end', behavior: 'smooth' });
      }
    }, 250);
  });
  els.stopButton.addEventListener('click', stopGeneration);
  els.searchToggle.addEventListener('click', toggleSearch);
  els.modeButton.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleModeMenu();
  });
  document.addEventListener('click', (event) => {
    if (!els.modeMenu.hidden && !els.modeMenu.contains(event.target) && !els.modeButton.contains(event.target)) {
      closeModeMenu();
    }
  });
  els.modeMenu.addEventListener('keydown', handleModeMenuKeys);
  $$('.suggestion').forEach((button) => {
    button.addEventListener('click', () => {
      els.question.value = button.dataset.question || '';
      els.question.focus();
      autoGrowTextarea();
      updateCharCount();
      updateSendState();
    });
  });
  els.newChat.addEventListener('click', resetConversation);
  els.openSettings.addEventListener('click', openSettings);
  els.closeSettings.addEventListener('click', closeSettings);
  els.settingsBackdrop.addEventListener('click', closeSettings);
  els.backgroundSelect.addEventListener('change', handleBackgroundChange);
  els.promptSelect.addEventListener('change', handlePromptChange);
  els.refreshContent.addEventListener('click', refreshContent);
  els.hardRefresh?.addEventListener('click', hardRefresh);
  els.changeKey.addEventListener('click', returnToInit);
  els.backToInit.addEventListener('click', returnToInit);
  els.toastAction.addEventListener('click', () => {
    const action = els.toastAction.dataset.action;
    hideToast();
    if (action === 'retry') els.askForm.requestSubmit();
    if (action === 'init') returnToInit();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!els.settingsPanel.hidden) closeSettings();
      else if (!els.modeMenu.hidden) closeModeMenu();
    }
    if (event.key === 'Tab' && !els.settingsPanel.hidden) {
      trapSettingsFocus(event);
    }
  });
  window.addEventListener('online', () => showToast('网络已恢复。', 'info'));
  window.addEventListener('offline', () => showToast('当前网络已断开，请检查连接。', 'error'));
  window.addEventListener('beforeunload', () => {
    state.apiKey = '';
    if (state.abortController) state.abortController.abort();
  });
}

async function loadContent() {
  try {
    const manifest = STANDALONE ? embeddedManifest() : await fetchManifest();
    if (!manifest) throw new Error('content manifest missing');
    state.manifest = normalizeManifest(manifest);
    await buildModes();
    renderContentSelectors();
    applySelectedMode(state.mode.prompt, state.mode.name);
  } catch {
    state.manifest = normalizeManifest({});
    await buildModes();
    renderContentSelectors();
  }
}

async function fetchManifest() {
  const response = await fetch(manifestURL(), { cache: 'no-store' });
  if (!response.ok) throw new Error('content manifest failed');
  return response.json();
}

function normalizeManifest(manifest) {
  return {
    backgrounds: Array.isArray(manifest?.backgrounds) ? manifest.backgrounds : [],
    prompts: Array.isArray(manifest?.prompts) ? manifest.prompts : [],
    defaultBackground: typeof manifest?.defaultBackground === 'string' ? manifest.defaultBackground : '',
    defaultPrompt: typeof manifest?.defaultPrompt === 'string' ? manifest.defaultPrompt : '',
  };
}

async function fetchPromptText(url) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) return null;
  return response.text();
}

async function buildModes() {
  const promptEntries = state.manifest.prompts;
  if (!promptEntries.length) {
    state.modes = [{ ...DEFAULT_MODE, file: '' }];
    state.mode = state.modes[0];
    state.promptFile = '';
    return;
  }
  const loaded = await Promise.all(promptEntries.map(async (entry) => {
    try {
      const text = STANDALONE ? embeddedPrompt(entry.name) : await fetchPromptText(entry.url);
      if (text === null) return null;
      return {
        name: modeNameFromFile(entry.name),
        description: modeDescriptionFromPrompt(text),
        prompt: text,
        file: entry.name,
        url: entry.url,
      };
    } catch {
      return null;
    }
  }));
  state.modes = loaded.filter(Boolean);
  if (!state.modes.length) state.modes = [{ ...DEFAULT_MODE, file: '' }];

  const preferredFile = state.promptFile
    || state.manifest.prompts.find((entry) => entry.name === state.manifest.defaultPrompt)?.name
    || state.modes[0].file;
  state.mode = state.modes.find((mode) => mode.file === preferredFile) || state.modes[0];
  state.promptFile = state.mode.file;
}

function renderContentSelectors() {
  els.backgroundSelect.replaceChildren();
  const backgrounds = state.manifest.backgrounds;
  if (backgrounds.length) {
    for (const entry of backgrounds) {
      const option = document.createElement('option');
      option.value = entry.name;
      option.textContent = entry.name;
      option.selected = entry.name === state.selectedBackground || (!state.selectedBackground && entry.name === state.manifest.defaultBackground);
      els.backgroundSelect.appendChild(option);
    }
    if (!state.selectedBackground) {
      state.selectedBackground = els.backgroundSelect.value || state.manifest.defaultBackground || backgrounds[0].name;
    }
  } else {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '未找到底图（使用内置渐变）';
    els.backgroundSelect.appendChild(option);
  }

  els.promptSelect.replaceChildren();
  for (const mode of state.modes) {
    const option = document.createElement('option');
    option.value = mode.file;
    option.textContent = mode.name;
    option.selected = mode.file === state.mode.file;
    els.promptSelect.appendChild(option);
  }
  updateModeUi();
}

function applyInitialBackground() {
  const selected = state.selectedBackground || state.manifest.defaultBackground || state.manifest.backgrounds[0]?.name;
  if (!selected) {
    state.selectedBackground = '';
    return;
  }
  const entry = state.manifest.backgrounds.find((item) => item.name === selected) || state.manifest.backgrounds[0];
  if (entry) setBackground(entry);
}

function setBackground(entry) {
  const src = entry?.url || entry?.src;
  if (!src) return;
  state.selectedBackground = entry.name;
  if (els.backgroundSelect.options.length) els.backgroundSelect.value = entry.name;
  els.bgImage.classList.remove('is-loaded');
  const image = new Image();
  image.onload = () => {
    els.bgImage.src = src;
    requestAnimationFrame(() => els.bgImage.classList.add('is-loaded'));
  };
  image.onerror = () => {
    showToast('底图加载失败，已使用渐变背景。', 'error');
  };
  image.src = src;
}

function setBackgroundByName(name) {
  const entry = state.manifest.backgrounds.find((item) => item.name === name);
  if (entry) setBackground(entry);
}

function applySelectedMode(prompt, name = '') {
  state.mode = { ...state.mode, prompt, name: name || state.mode.name };
  els.modeLabel.textContent = state.mode.name;
  if (els.promptSelect.options.length) {
    const matching = state.modes.find((mode) => mode.prompt === prompt);
    if (matching) {
      state.promptFile = matching.file;
      state.mode = matching;
      els.modeLabel.textContent = matching.name;
      els.promptSelect.value = matching.file;
    }
  }
  els.modeDescription.textContent = state.mode.description || '';
  updateModeUi();
}

function updateModeUi() {
  els.modeLabel.textContent = state.mode.name;
  $$('.mode-option', els.modeMenu).forEach((option) => {
    option.classList.toggle('is-selected', option.dataset.file === state.mode.file);
    option.setAttribute('aria-selected', String(option.dataset.file === state.mode.file));
  });
  if (els.promptSelect.options.length) els.promptSelect.value = state.mode.file;
}

function renderModeMenu() {
  els.modeMenu.replaceChildren();
  for (const mode of state.modes) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mode-option';
    button.dataset.file = mode.file;
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(mode.file === state.mode.file));
    if (mode.file === state.mode.file) button.classList.add('is-selected');
    button.innerHTML = '';
    const title = document.createElement('span');
    title.textContent = mode.name;
    button.appendChild(title);
    button.addEventListener('click', () => {
      selectMode(mode.file);
      closeModeMenu();
      els.modeButton.focus();
    });
    els.modeMenu.appendChild(button);
  }
}

function toggleModeMenu() {
  if (els.modeMenu.hidden) {
    renderModeMenu();
    els.modeMenu.hidden = false;
    els.modeButton.setAttribute('aria-expanded', 'true');
    const selected = $('.mode-option.is-selected', els.modeMenu);
    (selected || $('.mode-option', els.modeMenu))?.focus();
  } else {
    closeModeMenu();
  }
}

function closeModeMenu() {
  if (els.modeMenu.hidden) return;
  els.modeMenu.hidden = true;
  els.modeButton.setAttribute('aria-expanded', 'false');
}

function handleModeMenuKeys(event) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Escape') return;
  event.preventDefault();
  const options = $$('.mode-option', els.modeMenu);
  const currentIndex = options.indexOf(document.activeElement);
  if (event.key === 'Escape') {
    closeModeMenu();
    els.modeButton.focus();
    return;
  }
  const nextIndex = event.key === 'ArrowDown'
    ? (currentIndex + 1 + options.length) % options.length
    : (currentIndex - 1 + options.length) % options.length;
  options[nextIndex]?.focus();
}

function selectMode(file) {
  const mode = state.modes.find((item) => item.file === file);
  if (!mode) return;
  state.mode = mode;
  state.promptFile = mode.file;
  els.promptSelect.value = mode.file;
  els.modeDescription.textContent = mode.description || '';
  updateModeUi();
}

async function handleKeySubmit(event) {
  event.preventDefault();
  if (!systemState.booted || els.enterButton.disabled) return;
  const key = els.apiKey.value.trim();
  if (!key) {
    setKeyError('请输入 DeepSeek API Key。');
    els.apiKey.focus();
    return;
  }
  if (key.length < 8) {
    setKeyError('API Key 长度过短，请确认已复制完整。');
    els.apiKey.focus();
    return;
  }

  clearKeyError();
  setEnterLoading(true);
  try {
    await validateKey(key);
    state.apiKey = key;
    hideNetworkHelp();
    showApp();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      setKeyError('Key 校验未通过，请确认 Key 是否有效、是否已复制完整。');
    } else if (error instanceof ApiError && error.status === 402) {
      setKeyError('该账号余额不足，无法调用 API。请先充值后重试。');
    } else if (error instanceof ApiError && error.kind === 'network') {
      // The request never reached the server. Showing a "check your network"
      // toast here would be wrong when the real cause is the browser's
      // file:// policy, so explain the situation instead.
      showNetworkHelp(error, key);
    } else {
      setKeyError(error?.message || 'Key 校验失败，请稍后重试。');
    }
  } finally {
    setEnterLoading(false);
  }
}

function showNetworkHelp(error, key) {
  setKeyError('');
  els.netHelp.hidden = false;
  const isFile = window.location.protocol === 'file:';
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  if (isFile && isIOS) {
    els.netHelpTitle.textContent = 'iOS 阻止了本地文件联网';
    els.netHelpBody.innerHTML = 'Safari 打开本地 HTML 时会把页面当作<strong>不透明来源</strong>，'
      + '直接拦截发往 <strong>api.deepseek.com</strong> 的请求，所以 Key 无法校验。<br>'
      + '这不是你的 Key 有问题，也不是网络问题。<strong>请改用电脑的「局域网模式」</strong>：'
      + '在电脑上运行 <strong>政治问答系统.exe -lan</strong>，手机与电脑连同一个 Wi-Fi，扫码打开即可。';
  } else if (isFile) {
    els.netHelpTitle.textContent = '浏览器阻止了本地文件联网';
    els.netHelpBody.innerHTML = '当前浏览器不允许本地 HTML 文件直接访问网络。'
      + '可以换用 <strong>Chrome / Edge</strong> 打开同一文件，'
      + '或改用电脑的 <strong>局域网模式（-lan）</strong>。';
  } else {
    els.netHelpTitle.textContent = '无法连接到 DeepSeek';
    els.netHelpBody.innerHTML = '请求没有发出或没有收到响应。请检查：手机是否联网、'
      + '是否开启了 VPN / 代理拦截、DeepSeek 服务是否正常。';
  }

  const diagnostics = [
    ['页面来源', window.location.protocol === 'file:' ? 'file://（本地文件）' : window.location.origin],
    ['浏览器', shortUserAgent()],
    ['联网状态', navigator.onLine ? '在线' : '离线'],
    ['页面版本', APP_CONFIG.buildVersion || '未知'],
    ['错误', error?.message || '网络请求被拦截'],
  ];
  if (error?.detail) diagnostics.push(['原始错误', error.detail]);
  els.netHelpDiag.replaceChildren();
  for (const [label, value] of diagnostics) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    els.netHelpDiag.append(dt, dd);
  }
  els.netHelpBypass.dataset.key = key ? '1' : '';
  els.netHelp.scrollIntoView?.({ block: 'nearest' });
}

function hideNetworkHelp() {
  els.netHelp.hidden = true;
  delete els.netHelpBypass.dataset.key;
}

function shortUserAgent() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return 'iOS Safari';
  if (/HarmonyOS/i.test(ua)) return 'HarmonyOS 浏览器';
  if (/Android/.test(ua) && /Chrome/.test(ua)) return 'Android Chrome';
  if (/Edg\//.test(ua)) return 'Edge';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Safari\//.test(ua)) return 'Safari';
  return '未知浏览器';
}

function toggleKeyVisibility() {
  const visible = els.apiKey.type === 'text';
  els.apiKey.type = visible ? 'password' : 'text';
  els.toggleKey.setAttribute('aria-label', visible ? '显示 API Key' : '隐藏 API Key');
  els.toggleKey.classList.toggle('is-revealed', !visible);
  els.apiKey.focus();
}

function setEnterLoading(loading) {
  els.enterButton.disabled = loading;
  els.enterButton.classList.toggle('is-loading', loading);
  els.enterButton.querySelector('.button-label').textContent = loading ? '正在校验' : '进入问答';
  els.apiKey.disabled = loading;
}

function setKeyError(message) {
  els.keyError.textContent = message;
  els.keyError.hidden = !message;
  els.apiKey.setAttribute('aria-invalid', message ? 'true' : 'false');
}

function clearKeyError() {
  if (els.keyError.hidden) return;
  els.keyError.hidden = true;
  els.keyError.textContent = '';
  els.apiKey.removeAttribute('aria-invalid');
}

function showApp() {
  els.initScreen.hidden = true;
  els.appScreen.hidden = false;
  els.apiKey.value = '';
  setKeyError('');
  state.epoch += 1;
  state.isBusy = false;
  state.current = null;
  setBusyUi(false);
  requestAnimationFrame(() => {
    els.question.focus();
    updateSendState();
  });
}

function returnToInit() {
  closeSettings();
  state.epoch += 1;
  if (state.abortController) {
    state.abortController.abort();
    state.abortController = null;
  }
  state.apiKey = '';
  state.messages = [];
  state.turns = [];
  state.pendingQuestion = '';
  state.isBusy = false;
  state.current = null;
  setBusyUi(false);
  els.answerList.replaceChildren(els.welcome);
  els.welcome.hidden = false;
  els.question.value = '';
  updateCharCount();
  updateSendState();
  els.initScreen.hidden = false;
  els.appScreen.hidden = true;
  els.initScreen.querySelector('.init-card')?.classList.add('is-returning');
  requestAnimationFrame(() => {
    els.apiKey.focus();
  });
}

async function handleAskSubmit(event) {
  event.preventDefault();
  if (state.isBusy) return;
  const question = els.question.value.trim();
  if (!question) {
    els.question.focus();
    return;
  }
  if (!state.apiKey) {
    returnToInit();
    showToast('会话已失效，请重新输入 API Key。', 'error');
    return;
  }
  state.pendingQuestion = question;
  await ask(question);
}

async function ask(question) {
  closeModeMenu();
  state.epoch += 1;
  const epoch = state.epoch;
  state.isBusy = true;
  state.current = createTurn(question);
  setBusyUi(true);
  els.question.value = '';
  autoGrowTextarea();
  updateCharCount();
  updateSendState();

  const turn = state.current;
  const card = createAnswerCard(turn);
  els.answerList.appendChild(card);
  els.welcome.hidden = true;
  turn.progress.hidden = false;
  scrollToLatest(true);

  const controller = new AbortController();
  state.abortController = controller;
  const previousQuestion = getPreviousQuestion();
  let sources = [];
  let searchFailed = false;
  const searchAttempted = state.searchEnabled;

  try {
    turn.progress.textContent = state.searchEnabled ? '正在检索公开资料' : '正在整理想法';
    card.classList.add('is-pending');

    if (state.searchEnabled) {
      try {
        const query = buildSearchQuery(question, previousQuestion);
        sources = await searchWeb(state.apiKey, query, question);
        if (state.epoch !== epoch) return;
        if (!sources.length) {
          turn.progress.textContent = '未检索到资料，改为基于知识回答';
          await delay(420);
        }
      } catch (error) {
        if (controller.signal.aborted) throw error;
        if (error instanceof ApiError && (error.status === 401 || error.status === 402)) throw error;
        searchFailed = true;
        turn.progress.textContent = '联网检索失败，改为基于知识回答';
        await delay(500);
      }
    }
    if (state.epoch !== epoch) return;

    turn.progress.textContent = '正在组织回答';
    turn.sources = sources;
    const messages = buildMessages(question, state.mode.prompt, sources, searchAttempted);
    let pendingRender = false;
    let renderTimer = null;
    const scheduleRender = () => {
      if (pendingRender || state.epoch !== epoch) return;
      pendingRender = true;
      renderTimer = window.setTimeout(() => {
        pendingRender = false;
        if (state.epoch === epoch) renderAnswer(turn, true);
      }, 50);
    };

    const result = await streamChat(state.apiKey, messages, {
      signal: controller.signal,
      onDelta: (_delta, fullContent) => {
        if (state.epoch !== epoch) return;
        turn.content = fullContent;
        if (!turn.started) {
          turn.started = true;
          turn.progress.hidden = true;
        }
        scheduleRender();
      },
      onReasoning: () => {
        if (state.epoch === epoch && !turn.started) turn.progress.textContent = '正在思考';
      },
    });
    if (state.epoch !== epoch) return;
    window.clearTimeout(renderTimer);
    turn.content = result.content || turn.content;
    turn.progress.hidden = true;
    card.classList.remove('is-pending');
    if (!turn.content.trim()) {
      throw new ApiError('模型没有返回文字内容，请重试。', { status: 0, retryable: true });
    }
    renderAnswer(turn, false);
    renderSources(turn);
    turn.markdownNode.classList.remove('cursor-blink');
    if (searchFailed) {
      showToast('本次联网检索失败，回答基于模型已有知识。', 'error');
    } else if (state.searchEnabled && !sources.length) {
      showToast('本次未检索到相关公开资料，回答未附来源。', 'info');
    }
    state.messages = buildHistory(state.messages, question, turn.content);
    state.turns.push(turn);
  } catch (error) {
    if (state.epoch !== epoch) return;
    const aborted = controller.signal.aborted;
    turn.progress.hidden = true;
    card.classList.remove('is-pending');
    if (aborted) {
      turn.content = turn.content.trim();
      if (turn.content) {
        renderAnswer(turn, false);
        renderSources(turn);
        turn.markdownNode.classList.remove('cursor-blink');
        turn.interrupted = true;
        // Preserve interrupted answers in the conversation so the next
        // follow-up has context.
        state.messages = buildHistory(state.messages, question, turn.content);
        state.turns.push(turn);
      } else {
        turn.card.remove();
      }
    } else {
      renderAnswer(turn, false);
      const message = error instanceof ApiError ? error.message : '生成回答失败，请稍后重试。';
      showAnswerError(turn, message, error);
      if (error instanceof ApiError && error.status === 401) {
        showToast('API Key 已失效，请重新输入。', 'error', { label: '更换 Key', action: 'init' });
      } else {
        showToast(message, 'error');
      }
    }
  } finally {
    if (state.epoch === epoch) {
      if (state.abortController === controller) state.abortController = null;
      state.isBusy = false;
      state.current = null;
      setBusyUi(false);
      updateSendState();
      if (turn?.sources?.length) renderSources(turn);
      scrollToLatest(true);
      els.question.focus();
    }
  }
}

function buildMessages(question, modePrompt, sources, searchAttempted) {
  const system = composeSystemPrompt(modePrompt, sources, { searchAttempted });
  const history = trimHistory(state.messages, APP_CONFIG.maxHistoryMessages);
  return [
    { role: 'system', content: system },
    ...history,
    { role: 'user', content: question },
  ];
}

function trimHistory(messages, maxMessages) {
  const trimmed = messages.length <= maxMessages ? messages : messages.slice(messages.length - maxMessages);
  // Source numbers are local to each turn. Strip old citation markers so the
  // model does not confuse an old [1] with a source from the current search.
  return trimmed.map((message) => (
    message.role === 'assistant'
      ? { ...message, content: message.content.replace(/\[(\d{1,2})\]/g, '') }
      : message
  ));
}

function buildHistory(history, question, answer) {
  return [
    ...history,
    { role: 'user', content: question },
    { role: 'assistant', content: answer },
  ].slice(-APP_CONFIG.maxHistoryMessages);
}

function getPreviousQuestion() {
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    if (state.messages[i].role === 'user') return state.messages[i].content;
  }
  return '';
}

function createTurn(question) {
  const fragment = els.answerTemplate.content.cloneNode(true);
  const card = fragment.querySelector('.answer-card');
  const questionNode = fragment.querySelector('.question-text');
  questionNode.textContent = question;
  const time = fragment.querySelector('.answer-time');
  time.textContent = formatTime(new Date());
  return {
    card,
    question,
    content: '',
    sources: [],
    markdownNode: fragment.querySelector('.answer-markdown'),
    progress: fragment.querySelector('.progress-line'),
    progressStatus: fragment.querySelector('.progress-status'),
    questionNode,
    started: false,
    sourceList: fragment.querySelector('.source-list'),
    sourcesWrap: fragment.querySelector('.sources'),
    errorWrap: fragment.querySelector('.answer-error'),
    errorMessage: fragment.querySelector('.answer-error__message'),
    retryButton: fragment.querySelector('.answer-retry'),
    copyButton: fragment.querySelector('.copy-answer'),
    time,
  };
}

function createAnswerCard(turn) {
  // The cloned card is already attached to the fragment; return the actual
  // element after transfer to the live DOM.
  const card = turn.card;
  const listItem = document.createElement('div');
  listItem.appendChild(card);
  const article = listItem.firstElementChild;
  turn.card = article;
  turn.markdownNode = article.querySelector('.answer-markdown');
  turn.progress = article.querySelector('.progress-line');
  turn.progressStatus = article.querySelector('.progress-status');
  turn.sourceList = article.querySelector('.source-list');
  turn.sourcesWrap = article.querySelector('.sources');
  turn.errorWrap = article.querySelector('.answer-error');
  turn.errorMessage = article.querySelector('.answer-error__message');
  turn.retryButton = article.querySelector('.answer-retry');
  turn.copyButton = article.querySelector('.copy-answer');
  turn.retryButton.addEventListener('click', () => {
    if (state.isBusy) return;
    if (turn.card.isConnected) turn.card.remove();
    els.question.value = turn.question;
    updateCharCount();
    updateSendState();
    els.askForm.requestSubmit();
  });
  turn.copyButton.addEventListener('click', () => copyAnswer(turn));
  return article;
}

function renderAnswer(turn, streaming) {
  const rendered = renderMarkdown(turn.content);
  turn.markdownNode.replaceChildren(...rendered.childNodes);
  turn.markdownNode.classList.toggle('cursor-blink', Boolean(streaming && turn.content));
  if (!streaming) turn.markdownNode.classList.remove('cursor-blink');
  if (streaming) scrollToLatest(false);
}

function renderSources(turn) {
  if (!turn.sources.length) {
    turn.sourcesWrap.hidden = true;
    return;
  }
  turn.sourceList.replaceChildren();
  turn.sources.forEach((source, index) => {
    const item = document.createElement('li');
    item.className = 'source-item';
    const indexEl = document.createElement('span');
    indexEl.className = 'source-index';
    indexEl.textContent = String(index + 1);
    const body = document.createElement('div');
    body.className = 'source-body';
    const title = document.createElement('a');
    title.className = 'source-title';
    title.href = safeUrl(source.url) || '#';
    title.target = '_blank';
    title.rel = 'noopener noreferrer';
    title.textContent = source.title || '未命名资料';
    title.title = source.title || '';
    const meta = document.createElement('span');
    meta.className = 'source-meta';
    meta.textContent = [source.site_name, formatSourceDate(source.date)].filter(Boolean).join(' · ') || '公开网页';
    body.append(title, meta);
    item.append(indexEl, body);
    turn.sourceList.appendChild(item);
  });
  turn.sourcesWrap.hidden = false;
}

function safeUrl(value) {
  try {
    const url = new URL(String(value || ''), window.location.origin);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
  } catch {
    return '';
  }
  return '';
}

function formatSourceDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function showAnswerError(turn, message, error) {
  turn.errorWrap.hidden = false;
  turn.errorMessage.textContent = message;
  turn.retryButton.hidden = false;
  if (error instanceof ApiError && error.status === 401) {
    turn.retryButton.hidden = true;
  }
}

function stopGeneration() {
  if (!state.abortController) return;
  state.abortController.abort('user');
  showToast('已停止生成。', 'info');
}

function setBusyUi(busy) {
  els.appScreen.classList.toggle('is-busy', busy);
  els.sendButton.hidden = busy;
  els.stopButton.hidden = !busy;
  els.question.setAttribute('aria-busy', String(busy));
  updateSendState();
}

function toggleSearch() {
  state.searchEnabled = !state.searchEnabled;
  updateSearchToggle();
  showToast(state.searchEnabled ? '已开启联网检索。' : '已关闭联网检索，将仅使用模型知识。', 'info');
}

function updateSearchToggle() {
  els.searchToggle.classList.toggle('is-active', state.searchEnabled);
  els.searchToggle.setAttribute('aria-pressed', String(state.searchEnabled));
  els.searchStatus.textContent = state.searchEnabled ? '开启' : '关闭';
}

function resetConversation() {
  state.epoch += 1;
  if (state.abortController) {
    state.abortController.abort();
    state.abortController = null;
  }
  state.isBusy = false;
  state.current = null;
  setBusyUi(false);
  state.messages = [];
  state.turns = [];
  state.pendingQuestion = '';
  els.answerList.replaceChildren(els.welcome);
  els.welcome.hidden = false;
  els.question.value = '';
  updateCharCount();
  updateSendState();
  els.question.focus();
}

function openSettings() {
  renderSettings();
  els.settingsBackdrop.hidden = false;
  els.settingsPanel.hidden = false;
  requestAnimationFrame(() => els.closeSettings.focus());
}

function closeSettings() {
  if (els.settingsPanel.hidden) return;
  els.settingsPanel.hidden = true;
  els.settingsBackdrop.hidden = true;
  els.openSettings.focus();
}

function trapSettingsFocus(event) {
  const focusable = [...els.settingsPanel.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((element) => !element.hidden && element.getClientRects().length > 0);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !els.settingsPanel.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !els.settingsPanel.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

function renderSettings() {
  if (els.backgroundSelect.options.length !== state.manifest.backgrounds.length) {
    renderContentSelectors();
  }
  if (state.selectedBackground) els.backgroundSelect.value = state.selectedBackground;
  if (els.promptSelect.options.length) els.promptSelect.value = state.mode.file;
  els.modeDescription.textContent = state.mode.description || '';
  els.searchStatus.textContent = state.searchEnabled ? '开启' : '关闭';
  if (els.buildVersion) els.buildVersion.textContent = APP_CONFIG.buildVersion || '—';
}

// Clears the service-worker cache and reloads. This is the reliable escape
// hatch when a phone keeps running an older build after a re-deploy.
async function hardRefresh() {
  els.hardRefresh.disabled = true;
  els.hardRefresh.textContent = '正在清除…';
  try {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    }
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
  } catch {
    // Reload anyway; the query-string below also busts HTTP caches.
  }
  const url = new URL(window.location.href);
  url.searchParams.set('v', Date.now().toString(36));
  window.location.replace(url.toString());
}

function handleBackgroundChange() {
  const name = els.backgroundSelect.value;
  if (!name) return;
  setBackgroundByName(name);
}

function handlePromptChange() {
  selectMode(els.promptSelect.value);
  els.modeDescription.textContent = state.mode.description || '';
}

async function refreshContent() {
  els.refreshContent.disabled = true;
  els.refreshContent.textContent = '正在刷新…';
  const previousMode = state.promptFile;
  const previousBackground = state.selectedBackground;
  try {
    if (STANDALONE) {
      // Single-file builds embed their content; nothing on disk can change.
      showToast('单文件版内容已内置，如需修改请重新生成文件。', 'info');
      return;
    }
    const manifest = normalizeManifest(await fetchManifest());
    state.manifest = manifest;
    // Static hosting cannot serve a directory listing, so the manifest is a
    // file generated at build time. Say so when the list looks stale.
    await buildModes();
    state.promptFile = previousMode;
    const preferredMode = state.modes.find((mode) => mode.file === previousMode)
      || state.modes.find((mode) => mode.file === manifest.defaultPrompt)
      || state.modes[0];
    state.mode = preferredMode;
    state.selectedBackground = previousBackground;
    renderContentSelectors();
    if (!state.manifest.backgrounds.some((entry) => entry.name === previousBackground)) {
      applyInitialBackground();
    }
    if (state.selectedBackground) els.backgroundSelect.value = state.selectedBackground;
    showToast('内容已刷新。', 'info');
  } catch {
    showToast('内容刷新失败，请确认启动器仍在运行。', 'error');
  } finally {
    els.refreshContent.disabled = false;
    els.refreshContent.textContent = '刷新内容';
  }
}

async function copyAnswer(turn) {
  const text = turn.content.trim();
  if (!text) return;
  const copied = await writeClipboard(text);
  if (copied) {
    showToast('回答已复制。', 'info');
  } else {
    showToast('当前环境不支持自动复制，请长按选择文本。', 'error');
  }
}

// navigator.clipboard is undefined on plain http:// origins (a phone opening the
// LAN address), which is exactly the mobile case. Fall back to the legacy
// selection + execCommand path before giving up.
async function writeClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.left = '-9999px';
    area.style.fontSize = '16px';
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, area.value.length);
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

function autoGrowTextarea() {
  els.question.style.height = 'auto';
  els.question.style.height = `${Math.min(els.question.scrollHeight, 150)}px`;
}

function updateCharCount() {
  const length = [...els.question.value].length;
  const nearLimit = length > APP_CONFIG.maxQuestionLength * 0.85;
  els.charCount.textContent = `${length} / ${APP_CONFIG.maxQuestionLength}`;
  els.charCount.classList.toggle('is-visible', length > 0);
  els.charCount.classList.toggle('is-near-limit', nearLimit);
}

function updateSendState() {
  const hasText = els.question.value.trim().length > 0;
  els.sendButton.disabled = !hasText || state.isBusy;
}

function scrollToLatest(force) {
  if (state.isBusy && !force) {
    const nearBottom = els.answerList.scrollHeight - els.answerList.scrollTop - els.answerList.clientHeight < 160;
    if (!nearBottom) return;
  }
  els.answerArea.scrollTop = els.answerArea.scrollHeight;
  els.answerList.scrollTop = els.answerList.scrollHeight;
}

function showToast(message, type = 'info', action = null) {
  if (state.toastTimer) window.clearTimeout(state.toastTimer);
  els.toastMessage.textContent = message;
  els.toast.classList.toggle('is-error', type === 'error');
  els.toast.hidden = false;
  if (action) {
    els.toastAction.hidden = false;
    els.toastAction.textContent = action.label;
    els.toastAction.dataset.action = action.action;
  } else {
    els.toastAction.hidden = true;
    delete els.toastAction.dataset.action;
  }
  state.toastTimer = window.setTimeout(hideToast, type === 'error' ? 6500 : 4200);
}

function hideToast() {
  if (state.toastTimer) window.clearTimeout(state.toastTimer);
  state.toastTimer = null;
  els.toast.hidden = true;
}

function formatTime(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
