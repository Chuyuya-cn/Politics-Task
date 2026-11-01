// Runtime configuration for the UI. The executable embeds this file, so edit
// it and rebuild only if you want to change the API model or limits.
export const APP_CONFIG = Object.freeze({
  model: 'deepseek-flash',
  modelLabel: 'V4.1 Flash',
  reasoningEffort: 'low',
  maxOutputTokens: 4096,
  searchResultCount: 5,
  maxQuestionLength: 2000,
  maxHistoryMessages: 10,
  validateTimeoutMs: 25000,
  searchTimeoutMs: 35000,
  // Shown in Settings so you can tell which build the browser is actually
  // running — the fastest way to spot a stale-cache problem.
  buildVersion: '2026-10-31-a',
});
