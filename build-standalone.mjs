// Builds a single self-contained HTML file that runs from file:// on Android,
// iOS and HarmonyOS browsers. No bundler dependency: the front-end modules are
// plain ES modules with static imports, so they are concatenated in dependency
// order and their import/export syntax is stripped.
//
//   node build-standalone.mjs
//
// Output: web/政问-单文件版.html
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = import.meta.dirname;
const WEB = path.join(ROOT, 'web');

// Module order is a hand-maintained topological sort: a module may only be
// listed after everything it imports. config.js must come first because
// runtime.js/api.js/app.js all read APP_CONFIG at module scope.
const MODULES = [
  'config.js',
  'js/runtime.js',
  'js/markdown.js',
  'js/prompts.js',
  'js/api.js',
  'js/app.js',
];

function stripModuleSyntax(source, file) {
  let out = source;
  out = out.replace(/^import\s+\{[^}]*\}\s+from\s+['"][^'"]+['"];?\s*$/gm, '');
  out = out.replace(/^import\s+[\w*\s,]+\s+from\s+['"][^'"]+['"];?\s*$/gm, '');
  out = out.replace(/^export\s+\{[^}]*\};?\s*$/gm, '');
  out = out.replace(/^export\s+default\s+/gm, '');
  out = out.replace(/^export\s+(async\s+function|function|const|let|var|class)\b/gm, '$1');
  if (/\bimport\s+|\bexport\s+/.test(out.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''))) {
    const leftover = out.split('\n').filter((line) => /^\s*(import|export)\s/.test(line));
    if (leftover.length) {
      throw new Error(`${file}: module syntax left after transform:\n${leftover.join('\n')}`);
    }
  }
  return out;
}

function buildModuleBundle() {
  const parts = [];
  for (const relative of MODULES) {
    const file = path.join(WEB, relative);
    const source = readFileSync(file, 'utf8');
    parts.push(`\n/* ==== ${relative} ==== */\n${stripModuleSyntax(source, relative)}\n`);
  }
  return `(() => {\n'use strict';\n${parts.join('\n')}\n})();`;
}

function dataUrlFor(file) {
  const ext = path.extname(file).toLowerCase();
  const mime = ext === '.svg' ? 'image/svg+xml'
    : ext === '.png' ? 'image/png'
      : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
        : ext === '.webp' ? 'image/webp'
          : 'application/octet-stream';
  const base64 = readFileSync(file).toString('base64');
  return `data:${mime};base64,${base64}`;
}

function readPrompts() {
  const dir = path.join(ROOT, 'prompts');
  const prompts = {};
  for (const name of readdirSync(dir)) {
    if (!name.toLowerCase().endsWith('.md')) continue;
    if (name.toUpperCase().startsWith('README')) continue;
    prompts[name] = readFileSync(path.join(dir, name), 'utf8');
  }
  return prompts;
}

function readBackgrounds() {
  const dir = path.join(ROOT, 'backgrounds');
  const allowed = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp']);
  const entries = [];
  for (const name of readdirSync(dir)) {
    if (!allowed.has(path.extname(name).toLowerCase())) continue;
    entries.push({ name, src: dataUrlFor(path.join(dir, name)) });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

function buildContent() {
  const prompts = readPrompts();
  const backgrounds = readBackgrounds();
  const promptNames = Object.keys(prompts).sort();
  const preferredBackground = backgrounds.find((item) => item.name === 'default.svg')?.name
    || backgrounds[0]?.name
    || '';
  const manifest = {
    // In standalone mode the manifest URL is the data URL itself, so the
    // existing setBackground()/option rendering code works unchanged.
    backgrounds: backgrounds.map((item) => ({ name: item.name, url: item.src })),
    prompts: promptNames.map((name) => ({ name, url: name })),
    defaultBackground: preferredBackground,
    defaultPrompt: promptNames.find((name) => name.startsWith('01-')) || promptNames[0] || '',
  };
  return {
    manifest,
    prompts,
    backgrounds,
  };
}

function main() {
  const html = readFileSync(path.join(WEB, 'index.html'), 'utf8');
  const css = readFileSync(path.join(WEB, 'styles.css'), 'utf8');
  const boot = readFileSync(path.join(WEB, 'js/boot.js'), 'utf8');
  const content = buildContent();
  const bundle = buildModuleBundle();

  const escapedContent = JSON.stringify(content).replace(/</g, '\\u003c');

  let out = html;

  // Drop the proxy-only service worker / manifest / icon links: file:// cannot
  // install them and they would 404 from a single file.
  out = out.replace(/^\s*<link rel="manifest"[^>]*>\s*$/gm, '');
  out = out.replace(/^\s*<link rel="apple-touch-icon"[^>]*>\s*$/gm, '');
  // The favicon is also a separate file; inline it so no asset request 404s.
  const faviconData = dataUrlFor(path.join(WEB, 'assets', 'favicon.svg'));
  out = out.replace(
    /<link rel="icon" href="assets\/favicon\.svg" type="image\/svg\+xml">/,
    () => `<link rel="icon" href="${faviconData}" type="image/svg+xml">`,
  );

  // Every injection below uses a replacer *function*. Passing the payload as a
  // replacement string would let sequences like `$$` (used by app.js) be
  // interpreted as replacement patterns and silently corrupted.
  out = out.replace(
    /<link rel="stylesheet" href="styles\.css">/,
    () => `<style>\n${css}\n</style>`,
  );

  // The boot guard only applies to the proxy build.
  out = out.replace(/<script src="js\/boot\.js"><\/script>\s*/, '');

  // Replace the module entry with the standalone payload.
  out = out.replace(
    /<script src="js\/app\.js" type="module"><\/script>/,
    () => [
      '<script id="pq-standalone-content" type="application/json">',
      escapedContent,
      '</script>',
      '<script>',
      'window.__PQ_STANDALONE__ = true;',
      "window.__PQ_CONTENT__ = JSON.parse(document.getElementById('pq-standalone-content').textContent);",
      '</script>',
      '<script>',
      bundle,
      '</script>',
    ].join('\n'),
  );

  out = out.replace('<title>政问 · 政治课程学习助手</title>',
    () => '<title>政问 · 政治课程学习助手（单文件版）</title>');

  const target = path.join(WEB, '政问-单文件版.html');
  writeFileSync(target, out, 'utf8');

  const size = (Buffer.byteLength(out, 'utf8') / 1024 / 1024).toFixed(2);
  console.log(`wrote ${target}`);
  console.log(`  size: ${size} MiB`);
  console.log(`  prompts: ${content.manifest.prompts.length}`);
  console.log(`  backgrounds: ${content.manifest.backgrounds.length}`);
  console.log(`  bundle: ${(Buffer.byteLength(bundle, 'utf8') / 1024).toFixed(1)} KiB`);
}

main();
