// Verifies that every relative link and image in the tracked Markdown files
// points at a file that is actually tracked by git. Catches the class of bug
// where a doc references something that .gitignore excludes — exactly what
// happened with README pointing at screenshots/ before.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const tracked = new Set(
  execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .map((p) => p.replace(/\\/g, '/')),
);

const markdownFiles = [...tracked].filter((f) => f.toLowerCase().endsWith('.md'));

let failures = 0;
let checked = 0;

function check(name, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

// [text](target) and ![alt](target), ignoring absolute URLs and anchors.
const LINK = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

for (const file of markdownFiles) {
  const body = readFileSync(file, 'utf8');
  const dir = path.posix.dirname(file);
  let match;
  while ((match = LINK.exec(body)) !== null) {
    const raw = match[1];
    if (/^(https?:|mailto:|#|data:)/i.test(raw)) continue;
    const target = decodeURIComponent(raw.split('#')[0]);
    if (!target) continue;
    checked += 1;
    const resolved = path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, target));
    const ok = tracked.has(resolved);
    check(`${file} -> ${target}`, ok, ok ? '' : `resolves to "${resolved}" which is NOT tracked`);
  }
}

console.log(`\n${checked} relative link(s) checked across ${markdownFiles.length} Markdown file(s)`);
if (failures) {
  console.log(`${failures} broken reference(s) — these would render as broken links on GitHub`);
  process.exitCode = 1;
} else {
  console.log('all relative references resolve to tracked files');
}
