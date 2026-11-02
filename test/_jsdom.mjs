// Resolves jsdom from either location so the same test script works locally
// (dependency in .tools/, which is gitignored) and in CI (`npm install jsdom`).
//
// A plain `await import('jsdom').catch(...)` does not work here: the failing
// specifier is resolved during module linking, before the promise rejection can
// be handled. Existence checks avoid that entirely.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export async function loadJSDOM() {
  const candidates = [
    'jsdom',
    new URL('../.tools/node_modules/jsdom/lib/api.js', import.meta.url).href,
  ];

  const errors = [];
  for (const specifier of candidates) {
    try {
      const mod = await import(specifier);
      if (mod?.JSDOM) return mod.JSDOM;
    } catch (error) {
      errors.push(`${specifier}: ${error.code || error.message}`);
    }
  }
  throw new Error(
    `jsdom not available. Install it with:\n  npm install --no-fund --no-audit --no-save jsdom\nTried:\n  ${errors.join('\n  ')}`,
  );
}

// True when jsdom can be found without importing it (for skipping tests early).
export function hasJSDOM() {
  const local = path.join(import.meta.dirname, '..', '.tools', 'node_modules', 'jsdom');
  if (existsSync(local)) return true;
  try {
    createRequire(import.meta.url).resolve('jsdom');
    return true;
  } catch {
    return false;
  }
}
